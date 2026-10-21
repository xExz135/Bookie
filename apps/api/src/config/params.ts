import { z } from 'zod';

/**
 * Every setting the API reads, with its default and where the default comes from.
 * Spec rule: parameters are configurable defaults or hypotheses, not facts.
 * `.env.example` is generated from this list (`pnpm generate` from the repository root).
 */
interface ParamDef {
  schema: z.ZodType;
  description: string;
  /** Spec section or decision the value comes from. */
  source: string;
  /** Secrets never get a value in .env.example. */
  secret?: boolean;
}

const int = (fallback: number, min = 1) => z.coerce.number().int().min(min).default(fallback);
const num = (fallback: number, min: number, max: number) =>
  z.coerce.number().min(min).max(max).default(fallback);

export const PARAMS = {
  // --- Runtime ---
  NODE_ENV: {
    schema: z.enum(['development', 'test', 'production']).default('development'),
    description: 'Runtime environment.',
    source: 'BE-1',
  },
  API_PORT: { schema: int(3001), description: 'Port the API listens on.', source: 'BE-1' },
  WEB_ORIGIN: {
    schema: z.url().default('http://localhost:3000'),
    description: 'Frontend origin allowed by CORS and used in reset-password links.',
    source: 'BE-1',
  },
  DATABASE_URL: {
    schema: z.string().min(1).default('postgresql://bookie:bookie@localhost:5432/bookie'),
    description: 'PostgreSQL connection string. The default matches docker-compose.yml.',
    source: 'D-005',
  },
  REDIS_URL: {
    schema: z.string().min(1).default('redis://localhost:6379'),
    description: 'Redis connection string. The default matches docker-compose.yml.',
    source: 'D-005',
  },

  // --- Secrets ---
  AUTH_TOKEN_SECRET: {
    schema: z.string().min(32).optional(),
    description:
      'Secret for signing access tokens, at least 32 characters. Required in production. ' +
      'In development a random one is generated at start-up.',
    source: 'D-001',
    secret: true,
  },
  GOOGLE_BOOKS_API_KEY: {
    schema: z.string().min(1).optional(),
    description: 'Google Books API key. Ratings and metadata, fetched live only, never stored.',
    source: 'D-003',
    secret: true,
  },
  HARDCOVER_API_TOKEN: {
    schema: z.string().min(1).optional(),
    description: 'Hardcover personal access token with read-only scopes. Aggregate ratings only.',
    source: 'D-003',
    secret: true,
  },
  GEMINI_API_KEY: {
    schema: z.string().min(1).optional(),
    description: 'Gemini API key for LLM and vision steps. Server-side only.',
    source: 'D-005',
    secret: true,
  },

  // --- Mail (Mailpit locally) ---
  SMTP_HOST: {
    schema: z.string().default('localhost'),
    description: 'SMTP host.',
    source: 'D-001',
  },
  SMTP_PORT: { schema: int(1025), description: 'SMTP port (Mailpit: 1025).', source: 'D-001' },
  SMTP_USER: { schema: z.string().optional(), description: 'SMTP user, if any.', source: 'D-001' },
  SMTP_PASSWORD: {
    schema: z.string().optional(),
    description: 'SMTP password, if any.',
    source: 'D-001',
    secret: true,
  },
  MAIL_FROM: {
    schema: z.string().default('Bookie <no-reply@bookie.local>'),
    description: 'Sender address for password-reset emails.',
    source: 'D-001',
  },

  // --- Authentication (D-001) ---
  AUTH_ACCESS_TOKEN_TTL_SECONDS: {
    schema: int(900, 60),
    description: 'Access token lifetime.',
    source: 'D-001',
  },
  AUTH_REFRESH_TOKEN_TTL_DAYS: {
    schema: int(30),
    description: 'Refresh token lifetime. Rotated on every use.',
    source: 'D-001',
  },
  AUTH_RESET_TOKEN_TTL_MINUTES: {
    schema: int(30, 5),
    description: 'Password-reset link lifetime. Single use.',
    source: 'D-001',
  },
  AUTH_PASSWORD_MIN_LENGTH: {
    schema: int(10, 8),
    description: 'Minimum password length.',
    source: 'D-001',
  },
  AUTH_PASSWORD_MAX_LENGTH: {
    schema: int(128, 16),
    description: 'Maximum password length.',
    source: 'D-001',
  },
  RATE_LIMIT_AUTH_MAX: {
    schema: int(10),
    description:
      'Register, login and forgot-password requests allowed per IP and per email in one window.',
    source: 'D-001 (hypothesis)',
  },
  RATE_LIMIT_AUTH_WINDOW_SECONDS: {
    schema: int(900, 60),
    description: 'Window for RATE_LIMIT_AUTH_MAX.',
    source: 'D-001 (hypothesis)',
  },

  // --- Onboarding and taste (spec 6, D-002, D-008) ---
  ONBOARDING_ALLOW_SKIP: {
    schema: z.stringbool().default(true),
    description: 'Readers may skip onboarding. Setting false requires changing ONB-2 first.',
    source: 'D-002',
  },
  TASTE_MIN_RATED_FOR_CONFIDENCE: {
    schema: int(10),
    description: 'Rated books needed for a confident personal match.',
    source: 'Spec 6, D-008',
  },
  TASTE_HARD_FLOOR: {
    schema: int(3),
    description: 'Below this many rated books, no personal match is shown (MODEL-4).',
    source: 'Spec 6, D-008',
  },

  // --- Discovery (spec 6) ---
  SEARCH_MAX_CANDIDATES: {
    schema: int(3),
    description: 'Candidates shown for a search or scan.',
    source: 'Spec 6',
  },
  SCAN_RESIZE_MAX_PX: {
    schema: int(1024, 256),
    description: 'Longest side the client resizes a cover photo to before upload.',
    source: 'Spec 6, D-008',
  },
  SCAN_MAX_UPLOAD_BYTES: {
    schema: int(2_000_000, 100_000),
    description:
      'Largest accepted scan upload. Larger uploads are rejected before processing (DISC-4).',
    source: 'Spec 6 (hypothesis)',
  },
  SCAN_DAILY_QUOTA: {
    schema: int(20),
    description: 'Scans allowed per reader per day.',
    source: 'Spec 6 (hypothesis)',
  },
  SCAN_MIN_CONFIDENCE: {
    schema: num(0.7, 0, 1),
    description: 'Identification confidence below this is treated as uncertain (DISC-2).',
    source: 'Spec 6 (hypothesis)',
  },

  // --- Analysis pipeline (spec 8) ---
  EVIDENCE_MAX_REVIEWS: {
    schema: int(75),
    description: 'Maximum reviews in the evidence set sent to the language model.',
    source: 'Spec 8, D-008',
  },
  SOURCE_TIMEOUT_MS: {
    schema: int(8000, 500),
    description: 'Timeout for one source fetch.',
    source: 'Spec 8 (hypothesis)',
  },
  ANALYSIS_POLL_AFTER_MS: {
    schema: int(1500, 250),
    description: 'pollAfterMs returned to the client while an analysis runs.',
    source: 'CONTRACT 4.4',
  },
  RATE_LIMIT_ANALYSES_PER_HOUR: {
    schema: int(30),
    description: 'New analyses a reader may start per hour.',
    source: 'Spec 12 (hypothesis)',
  },
  REFRESH_PER_BOOK_PER_DAY: {
    schema: int(3),
    description: 'Manual review refreshes a reader may request per book per day.',
    source: 'Spec 10 (hypothesis)',
  },

  // --- Evidence selection (spec 8: deduplicate, filter language and length, balance, truncate) ---
  EVIDENCE_MIN_REVIEW_CHARS: {
    schema: int(80, 1),
    description: 'Reviews shorter than this are not used as written evidence.',
    source: 'Spec 8 (hypothesis)',
  },
  EVIDENCE_MAX_REVIEW_CHARS: {
    schema: int(1000, 100),
    description: 'Longer reviews are cut to this length before use.',
    source: 'Spec 8 (hypothesis)',
  },
  EVIDENCE_LANGUAGES: {
    schema: z
      .string()
      .regex(/^[a-z]{2,3}(,[a-z]{2,3})*$/)
      .default('en'),
    description: 'Comma-separated languages a review must be detected as to count as evidence.',
    source: 'Spec 8, D-015',
  },
  EVIDENCE_CANDIDATE_LIMIT: {
    schema: int(400, 10),
    description:
      'Reviews per edition considered before selection (a stable sample for very popular books).',
    source: 'D-015 (hypothesis)',
  },

  // --- Language model and embeddings (D-006, D-015) ---
  GEMINI_EMBEDDING_MODEL: {
    schema: z.string().min(1).default('gemini-embedding-001'),
    description:
      'Embedding model for book representations (768 dimensions, fixed by migration). gemini-embedding-2 accepts longer input but its free-tier quota ran out after about 47,000 tokens (D-015).',
    source: 'D-015',
  },
  GEMINI_TRAIT_MODEL: {
    schema: z.string().min(1).default('gemini-3.5-flash-lite'),
    description: 'Smaller model used for trait extraction (spec 10: small model first).',
    source: 'D-015, H2',
  },
  GEMINI_TRAIT_MODEL_LARGE: {
    schema: z.string().min(1).default('gemini-3.5-flash'),
    description: 'Larger model compared against the smaller one for trait extraction (H2).',
    source: 'D-015, H2',
  },
  GEMINI_TIMEOUT_MS: {
    schema: int(60_000, 1000),
    description: 'Timeout for one Gemini request.',
    source: 'D-015 (hypothesis)',
  },
  GEMINI_MAX_REQUESTS_PER_MINUTE: {
    schema: int(30),
    description: 'Client-side request pacing to stay under the API rate limit.',
    source: 'D-015 (hypothesis)',
  },
  GEMINI_TOKENS_PER_MINUTE: {
    schema: int(30_000, 1000),
    description:
      'Client-side cap on estimated input tokens per minute. The free tier rejected bursts of about 60,000 tokens a minute (D-015).',
    source: 'D-015 (hypothesis, measured 2026-10-21)',
  },
  GEMINI_TRANSIENT_RETRIES: {
    schema: int(2, 0),
    description:
      'Retries after an overloaded, unavailable or rate-limited response. Separate from the single retry for invalid output (spec 8).',
    source: 'D-015 (hypothesis)',
  },
  EMBEDDING_MAX_REVIEWS: {
    schema: int(20, 0),
    description: 'Selected reviews included in a book embedding next to its description.',
    source: 'Spec 7, D-015 (hypothesis)',
  },
  EMBEDDING_MAX_CHARS: {
    schema: int(7_000, 1000),
    description:
      'Embedding input is cut to this length (gemini-embedding-001 accepts 2,048 tokens, about 8,000 characters).',
    source: 'D-015',
  },
  EMBEDDING_BATCH_SIZE: {
    schema: int(5),
    description: 'Books embedded per API request.',
    source: 'D-015 (hypothesis)',
  },

  // --- Caching (spec 10) ---
  CACHE_METADATA_TTL_DAYS: {
    schema: int(60),
    description: 'Reuse window for book metadata and covers (spec range 30 to 90).',
    source: 'Spec 10',
  },
  CACHE_REVIEWS_TTL_DAYS: {
    schema: int(30),
    description: 'Reuse window for reviews and public analysis.',
    source: 'Spec 10',
  },
  CACHE_SOURCE_FAILURE_TTL_MINUTES: {
    schema: int(10),
    description: 'How long a source failure is remembered before retrying (spec range 5 to 15).',
    source: 'Spec 10',
  },
  CACHE_SOURCE_EMPTY_TTL_HOURS: {
    schema: int(24),
    description: 'How long an empty source result is remembered before retrying.',
    source: 'Spec 10',
  },
} satisfies Record<string, ParamDef>;

export type ParamKey = keyof typeof PARAMS;
