/**
 * Minimal Gemini REST client (D-005, D-015): embeddings and JSON output.
 * It paces requests, retries transient failures (overloaded, unavailable,
 * short rate limits) and reports token usage for cost measurement (H4).
 * It never decides whether output is *valid*: callers validate and apply
 * the spec's single retry for invalid output.
 */

export type LlmErrorKind =
  | 'quota' // rate limit or quota still exhausted after retrying (LLM_QUOTA_EXHAUSTED)
  | 'unavailable' // overloaded or server error after retrying
  | 'timeout'
  | 'invalid_request' // our request was rejected (bad model name, bad schema, ...)
  | 'blocked' // the model refused or returned no usable candidate
  | 'auth'; // missing or rejected API key

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Time the successful request took at Google, excluding our own waits. */
  latencyMs: number;
  /** Time spent waiting before sending: rate pacing and retries. */
  waitedMs: number;
}

export interface GeminiClientOptions {
  apiKey: string | undefined;
  timeoutMs: number;
  maxRequestsPerMinute: number;
  /** Client-side cap on estimated input tokens per minute (free-tier limits). */
  tokensPerMinute: number;
  transientRetries: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Replaceable in tests so retries do not really wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type EmbeddingTaskType = 'SEMANTIC_SIMILARITY' | 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export interface JsonRequest {
  system: string;
  user: string;
  /** JSON Schema the response must follow (Gemini responseJsonSchema). */
  schema: object;
  temperature?: number;
  /** Images sent before the text, held in memory only (DISC-3). */
  images?: Array<{ mimeType: string; data: Buffer }>;
}

/** Rough token cost of one image, for pacing only (Gemini bills images by tiles). */
const IMAGE_TOKEN_ESTIMATE = 1300;

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
/** Longest wait we accept for a rate limit before reporting the quota as exhausted. */
const MAX_RETRY_AFTER_SECONDS = 60;
/** A rate limit without a stated delay is treated as a per-minute window. */
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 60;
const WINDOW_MS = 60_000;

/** Rough token estimate for pacing (about 4 characters per token in English). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class GeminiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private nextSlot = 0;
  /** Estimated tokens sent in the last minute, for pacing. */
  private tokenLog: Array<{ at: number; tokens: number }> = [];

  constructor(private readonly options: GeminiClientOptions) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.minIntervalMs = Math.ceil(60_000 / options.maxRequestsPerMinute);
  }

  /** Embeds texts in one request. Vectors come back in input order. */
  async embed(
    model: string,
    texts: string[],
    options: { taskType: EmbeddingTaskType; dimensions: number },
  ): Promise<{ vectors: number[][]; usage: LlmUsage }> {
    const body = {
      requests: texts.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        taskType: options.taskType,
        outputDimensionality: options.dimensions,
      })),
    };
    const tokens = texts.reduce((sum, t) => sum + estimateTokens(t), 0);
    const {
      data: raw,
      latencyMs,
      waitedMs,
    } = await this.post(`models/${model}:batchEmbedContents`, body, tokens);
    const data = raw as { embeddings?: Array<{ values?: number[] }> };
    const vectors = (data.embeddings ?? []).map((e) => e.values ?? []);
    if (vectors.length !== texts.length || vectors.some((v) => v.length !== options.dimensions)) {
      throw new LlmError(
        'blocked',
        `Expected ${texts.length} vectors of ${options.dimensions} values`,
      );
    }
    return {
      vectors,
      // The embedding endpoint does not report tokens; cost is measured by characters elsewhere.
      usage: { model, inputTokens: 0, outputTokens: 0, latencyMs, waitedMs },
    };
  }

  /**
   * Asks for JSON matching a schema. Returns the raw text: parsing and
   * validation belong to the caller, so invalid output can be retried once.
   */
  async generateJson(
    model: string,
    request: JsonRequest,
  ): Promise<{ text: string; usage: LlmUsage }> {
    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [
        {
          role: 'user',
          parts: [
            ...(request.images ?? []).map((image) => ({
              inlineData: { mimeType: image.mimeType, data: image.data.toString('base64') },
            })),
            { text: request.user },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: request.schema,
        temperature: request.temperature ?? 0,
      },
    };
    const tokens =
      estimateTokens(request.system) +
      estimateTokens(request.user) +
      (request.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE;
    const {
      data: raw,
      latencyMs,
      waitedMs,
    } = await this.post(`models/${model}:generateContent`, body, tokens);
    const data = raw as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
      };
    };
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (data.promptFeedback?.blockReason || !candidate || text === '') {
      throw new LlmError(
        'blocked',
        `No usable output (${data.promptFeedback?.blockReason ?? candidate?.finishReason ?? 'empty'})`,
      );
    }
    return {
      text,
      usage: {
        model,
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        // Thinking tokens are billed as output (price page: "output, including thinking tokens").
        outputTokens:
          (data.usageMetadata?.candidatesTokenCount ?? 0) +
          (data.usageMetadata?.thoughtsTokenCount ?? 0),
        latencyMs,
        waitedMs,
      },
    };
  }

  private async pace(tokens: number): Promise<void> {
    // Request rate.
    const now = this.now();
    const wait = this.nextSlot - now;
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await this.sleep(wait);

    // Token rate: wait until the last minute has room. A single request larger
    // than the cap is still sent once the window is empty.
    for (;;) {
      const current = this.now();
      this.tokenLog = this.tokenLog.filter((entry) => entry.at > current - WINDOW_MS);
      const used = this.tokenLog.reduce((sum, entry) => sum + entry.tokens, 0);
      if (this.tokenLog.length === 0 || used + tokens <= this.options.tokensPerMinute) {
        this.tokenLog.push({ at: current, tokens });
        return;
      }
      await this.sleep(this.tokenLog[0]!.at + WINDOW_MS - current + 1);
    }
  }

  private async post(
    path: string,
    body: unknown,
    tokens: number,
  ): Promise<{ data: unknown; latencyMs: number; waitedMs: number }> {
    if (!this.options.apiKey) throw new LlmError('auth', 'GEMINI_API_KEY is not set');
    const started = this.now();
    let attempt = 0;
    for (;;) {
      await this.pace(tokens);
      const sent = this.now();
      try {
        const data = await this.postOnce(path, body);
        const done = this.now();
        return { data, latencyMs: done - sent, waitedMs: sent - started };
      } catch (error) {
        const retryable =
          error instanceof LlmError &&
          (error.kind === 'unavailable' ||
            error.kind === 'timeout' ||
            (error.kind === 'quota' && (error.retryAfterSeconds ?? 0) <= MAX_RETRY_AFTER_SECONDS));
        if (!retryable || attempt >= this.options.transientRetries) throw error;
        attempt++;
        const llmError = error as LlmError;
        const waitSeconds =
          llmError.retryAfterSeconds ??
          (llmError.kind === 'quota' ? DEFAULT_RATE_LIMIT_WAIT_SECONDS : 2 ** attempt);
        await this.sleep(waitSeconds * 1000);
      }
    }
  }

  private async postOnce(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.options.apiKey! },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted)
        throw new LlmError('timeout', `Gemini did not answer in ${this.options.timeoutMs} ms`);
      throw new LlmError('unavailable', `Gemini request failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) return response.json();

    const text = await response.text();
    const message = extractMessage(text) ?? `HTTP ${response.status}`;
    switch (response.status) {
      case 429:
        throw new LlmError('quota', message, retryAfterSeconds(response, text));
      case 401:
      case 403:
        throw new LlmError('auth', message);
      case 400:
      case 404:
        throw new LlmError('invalid_request', message);
      default:
        throw new LlmError(response.status >= 500 ? 'unavailable' : 'invalid_request', message);
    }
  }
}

function extractMessage(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message?.slice(0, 300);
  } catch {
    return undefined;
  }
}

/** Reads Retry-After, or the RetryInfo detail Google puts in error bodies ("12s"). */
function retryAfterSeconds(response: Response, text: string): number | undefined {
  const header = Number(response.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return header;
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text);
  return match ? Math.ceil(Number(match[1])) : undefined;
}
