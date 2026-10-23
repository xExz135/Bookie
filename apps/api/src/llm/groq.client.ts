import { type JsonRequest, LlmError, type LlmUsage } from './gemini.client';

/**
 * Minimal Groq client (OpenAI-compatible chat completions) for reading cover
 * photos (D-030). It has the same `generateJson` contract as GeminiClient:
 * it returns the raw JSON text and leaves validation, and the spec's single
 * retry for invalid output, to the caller. Errors use the same LlmError kinds.
 *
 * A rate limit is not waited out: the scan falls back to the other provider
 * instead, so the reader is not kept waiting.
 */
export interface GroqClientOptions {
  apiKey: string | undefined;
  timeoutMs: number;
  maxRequestsPerMinute: number;
  /** Retries after an overloaded, unavailable or timed-out request. */
  transientRetries: number;
  /** Upper bound on generated tokens, reasoning included. */
  maxOutputTokens?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Replaceable in tests so retries do not really wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

/**
 * The JSON object in a chat answer. Not every Groq model can be held to a
 * schema, so the schema is in the prompt and the answer may arrive wrapped in
 * a code fence or after a reasoning block. The caller still validates it.
 */
export function extractJsonText(content: string): string {
  const answer = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  return start >= 0 && end > start ? answer.slice(start, end + 1) : answer.trim();
}

export class GroqClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private nextSlot = 0;

  constructor(private readonly options: GroqClientOptions) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.minIntervalMs = Math.ceil(60_000 / options.maxRequestsPerMinute);
  }

  async generateJson(
    model: string,
    request: JsonRequest,
  ): Promise<{ text: string; usage: LlmUsage }> {
    const body = {
      model,
      temperature: request.temperature ?? 0,
      max_completion_tokens: this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      messages: [
        {
          role: 'system',
          content:
            `${request.system}\n\nAnswer with one JSON object and nothing else. ` +
            `It must follow this JSON Schema:\n${JSON.stringify(request.schema)}`,
        },
        {
          role: 'user',
          content: [
            // Images are sent from memory only, never written anywhere (DISC-3).
            ...(request.images ?? []).map((image) => ({
              type: 'image_url',
              image_url: { url: `data:${image.mimeType};base64,${image.data.toString('base64')}` },
            })),
            { type: 'text', text: request.user },
          ],
        },
      ],
    };
    const { data: raw, latencyMs, waitedMs } = await this.post('chat/completions', body);
    const data = raw as {
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? '';
    if (!choice || content.trim() === '') {
      throw new LlmError('blocked', `No usable output (${choice?.finish_reason ?? 'empty'})`);
    }
    return {
      text: extractJsonText(content),
      usage: {
        model,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        latencyMs,
        waitedMs,
      },
    };
  }

  private async pace(): Promise<void> {
    const now = this.now();
    const wait = this.nextSlot - now;
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await this.sleep(wait);
  }

  private async post(
    path: string,
    body: unknown,
  ): Promise<{ data: unknown; latencyMs: number; waitedMs: number }> {
    if (!this.options.apiKey) throw new LlmError('auth', 'GROQ_API_KEY is not set');
    const started = this.now();
    let attempt = 0;
    for (;;) {
      await this.pace();
      const sent = this.now();
      try {
        const data = await this.postOnce(path, body);
        return { data, latencyMs: this.now() - sent, waitedMs: sent - started };
      } catch (error) {
        const retryable =
          error instanceof LlmError && (error.kind === 'unavailable' || error.kind === 'timeout');
        if (!retryable || attempt >= this.options.transientRetries) throw error;
        attempt++;
        await this.sleep(2 ** attempt * 1000);
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
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey!}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted)
        throw new LlmError('timeout', `Groq did not answer in ${this.options.timeoutMs} ms`);
      throw new LlmError('unavailable', `Groq request failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) return response.json();

    const message = extractMessage(await response.text()) ?? `HTTP ${response.status}`;
    switch (response.status) {
      case 429: {
        const retryAfter = Number(response.headers.get('retry-after'));
        throw new LlmError(
          'quota',
          message,
          Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : undefined,
        );
      }
      case 401:
      case 403:
        throw new LlmError('auth', message);
      case 498: // Groq: capacity exceeded for the flex tier
        throw new LlmError('unavailable', message);
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
