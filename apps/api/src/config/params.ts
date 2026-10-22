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
  AUTH_DISPLAY_NAME_MAX_LENGTH: {
    schema: int(50, 10),
    description: 'Longest display name accepted at registration.',
    source: 'BE-3',
  },
  AUTH_COOKIE_SECURE: {
    schema: z.stringbool().default(true),
    description:
      'Send the refresh cookie with the Secure flag. Browsers accept Secure cookies on http://localhost, so keep this true.',
    source: 'D-001',
  },
  AUTH_ARGON2_MEMORY_KIB: {
    schema: int(19_456, 1024),
    description: 'argon2id memory cost in KiB.',
    source: 'D-001, OWASP Password Storage Cheat Sheet',
  },
  AUTH_ARGON2_ITERATIONS: {
    schema: int(2),
    description: 'argon2id time cost (iterations).',
    source: 'D-001, OWASP Password Storage Cheat Sheet',
  },
  AUTH_ARGON2_PARALLELISM: {
    schema: int(1),
    description: 'argon2id parallelism.',
    source: 'D-001, OWASP Password Storage Cheat Sheet',
  },
  TRUST_PROXY: {
    schema: z.stringbool().default(false),
    description:
      "Trust the first proxy's X-Forwarded-For header for the client IP (per-IP throttling). Turn on only behind a reverse proxy.",
    source: 'BE-3',
  },
  REDIS_KEY_PREFIX: {
    schema: z.string().min(1).default('bookie:'),
    description: 'Prefix for every Redis key, so several environments can share one Redis.',
    source: 'BE-3',
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
  STUDY_MIN_RATED_BOOKS: {
    schema: int(15),
    description: 'Rated books a reader needs to join the user study (spec 9: at least 15).',
    source: 'Spec 9, D-027',
  },
  STUDY_HELD_OUT_BOOKS: {
    schema: int(5),
    description:
      'Rated books held out from the model and predicted in the user study (spec 9: five). Chosen among the books the learned model knows.',
    source: 'Spec 9, D-027',
  },
  TASTE_HARD_FLOOR: {
    schema: int(3),
    description: 'Below this many rated books, no personal match is shown (MODEL-4).',
    source: 'Spec 6, D-008',
  },

  // --- Taste models (spec 7, D-006, D-024) ---
  TASTE_MODEL_VERSION: {
    schema: z.string().default(''),
    description:
      'Serve this release version instead of the shipped one (for tests and rollbacks). Empty = the shipped model.',
    source: 'D-024',
  },
  PERSONAL_CONFIDENCE_HIGH_RATINGS: {
    schema: int(40),
    description:
      "High confidence needs at least this many of the reader's ratings among the books the learned model knows.",
    source: 'D-024 (hypothesis: the learning curve still improves up to 40)',
  },
  PERSONAL_SIMILAR_BOOKS: {
    schema: int(3),
    description: "How many of the reader's most similar rated books explain a score.",
    source: 'D-024',
  },

  // --- Taste capture (spec 6, D-018) ---
  IMPORT_MAX_BYTES: {
    schema: int(10_000_000, 100_000),
    description: 'Largest accepted rating export file.',
    source: 'D-018 (hypothesis)',
  },
  IMPORT_MAX_ROWS: {
    schema: int(5000, 10),
    description: 'Most rated books accepted from one import file.',
    source: 'D-018 (hypothesis)',
  },
  IMPORT_MIN_TITLE_MATCH: {
    schema: num(0.8, 0, 1),
    description:
      'Title match (trigram similarity) an imported row needs to be matched without asking. Stricter than a scan, since nobody looks at it.',
    source: 'Spec 6, D-018 (hypothesis)',
  },
  IMPORT_MIN_AUTHOR_MATCH: {
    schema: num(0.6, 0, 1),
    description: 'Author match an imported row needs to be matched without asking.',
    source: 'D-018 (hypothesis)',
  },
  IMPORT_MAX_PER_DAY: {
    schema: int(10),
    description: 'Imports allowed per reader per day.',
    source: 'D-018 (hypothesis)',
  },
  IMPORT_STALE_SECONDS: {
    schema: int(120, 10),
    description:
      'An import still processing after this long (for example after a restart) is resumed.',
    source: 'D-018',
  },
  RATING_SAVES_PER_MINUTE: {
    schema: int(120),
    description:
      'Rating and questionnaire saves allowed per reader per minute. Each save is a new profile version.',
    source: 'D-018 (hypothesis)',
  },
  QUICK_RATE_LIST_SIZE: {
    schema: int(20, 1),
    description: 'Books returned by the quick-rate list and catalog search.',
    source: 'D-018',
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
    description:
      'Title match (trigram similarity, computed in code) a catalog book needs for a scan to count as identified. Below it the scan is uncertain (DISC-2).',
    source: 'Spec 6, D-017 (hypothesis)',
  },
  SCAN_AUTHOR_MIN_MATCH: {
    schema: num(0.6, 0, 1),
    description:
      'Author match a catalog book needs, when the cover shows an author, to count as plausible.',
    source: 'D-017 (hypothesis)',
  },
  SCAN_TIMEOUT_MS: {
    schema: int(20_000, 1000),
    description: 'Timeout for reading one cover with the vision model.',
    source: 'D-017 (hypothesis)',
  },
  GEMINI_VISION_MODEL: {
    schema: z.string().min(1).default('gemini-3.5-flash-lite'),
    description: 'Model that reads cover photos (title, author, whether it is a book).',
    source: 'D-017',
  },
  SEARCH_MIN_SCORE: {
    schema: num(0.4, 0.1, 1),
    description:
      'Lowest match score (trigram similarity, 0 to 1) for a catalog book to be a candidate.',
    source: 'Spec 6, D-017 (hypothesis)',
  },
  SEARCH_EXTERNAL_BELOW_SCORE: {
    schema: num(0.5, 0, 1),
    description:
      'If no catalog book matches at least this well, Open Library is searched too (spec 6: stored books first, then external metadata).',
    source: 'Spec 6, D-017 (hypothesis)',
  },
  SEARCH_POPULARITY_WEIGHT: {
    schema: num(0.1, 0, 1),
    description: 'How much the dataset rating count lifts a match in the ranking (0 turns it off).',
    source: 'D-017 (hypothesis)',
  },
  SEARCH_TIMEOUT_MS: {
    schema: int(3000, 100),
    description: 'Database time limit for one catalog search.',
    source: 'D-017 (hypothesis)',
  },
  SEARCH_RATE_LIMIT_PER_MINUTE: {
    schema: int(60),
    description:
      'Searches allowed per reader per minute (protects Open Library from repeated lookups).',
    source: 'D-017 (hypothesis)',
  },
  OPEN_LIBRARY_ENABLED: {
    schema: z.stringbool().default(true),
    description: 'Search Open Library when the catalog has no good match.',
    source: 'D-003',
  },
  OPEN_LIBRARY_USER_AGENT: {
    schema: z
      .string()
      .min(1)
      .default('Bookie/0.1 (portfolio project; https://github.com/xExz135/Bookie)'),
    description:
      'User-Agent sent to Open Library, which asks apps to identify themselves. Adding a contact email raises its limit to 3 requests per second.',
    source: 'D-003, docs/DATA_SOURCES.md',
  },
  OPEN_LIBRARY_MIN_INTERVAL_MS: {
    schema: int(1000, 100),
    description:
      'Minimum time between Open Library requests (1 per second without a contact email).',
    source: 'D-003, docs/DATA_SOURCES.md',
  },

  // --- Live rating sources (BE-5, D-003, D-020) ---
  SOURCE_DEADLINE_MS: {
    schema: int(12000, 1000),
    description:
      'Time limit for one source to answer for one book, across all its requests (an ISBN lookup, then a search, then ratings). Past it the source is reported as failed.',
    source: 'Spec 8, spec 10 cold-analysis target (hypothesis)',
  },
  SOURCE_MATCH_MIN_TITLE: {
    schema: num(0.75, 0, 1),
    description:
      'Title similarity (pg_trgm scale) a live source result needs to count as the same book. 0.75 keeps box sets ("The Hunger Games Trilogy", 0.71) out.',
    source: 'D-020 (hypothesis; measure with sources:check)',
  },
  SOURCE_MATCH_MIN_AUTHOR: {
    schema: num(0.5, 0, 1),
    description: 'Author similarity a live source result needs to count as the same book.',
    source: 'D-020 (hypothesis; measure with sources:check)',
  },
  SOURCE_SEARCH_RESULTS: {
    schema: int(5),
    description:
      'Results asked for when Open Library or Hardcover is searched by title and author.',
    source: 'D-020 (hypothesis)',
  },
  GOOGLE_BOOKS_ENABLED: {
    schema: z.stringbool().default(false),
    description:
      'Ask Google Books for ratings. Off by default: it matched 0 of the 12 most-rated books on 2026-10-21 (ISBN search returns nothing, and only the same edition may be used). Also needs GOOGLE_BOOKS_API_KEY.',
    source: 'D-020 (owner, 2026-10-21)',
  },
  GOOGLE_BOOKS_MAX_RESULTS: {
    schema: int(20),
    description:
      'Volumes asked for per Google Books search. Only the one with the edition ISBN is used, so more results mean more chances to find it.',
    source: 'D-020, docs/DATA_SOURCES.md test log',
  },
  GOOGLE_BOOKS_MIN_INTERVAL_MS: {
    schema: int(250, 50),
    description: 'Minimum time between Google Books requests (the free quota is per day).',
    source: 'D-020 (hypothesis)',
  },
  HARDCOVER_MIN_INTERVAL_MS: {
    schema: int(1000, 100),
    description: 'Minimum time between Hardcover requests (free plan: 60 a minute, burst 10).',
    source: 'D-003, docs/DATA_SOURCES.md',
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
  ANALYSIS_MAX_CONCURRENT: {
    schema: int(2),
    description:
      'Analyses this API process runs at once; the rest wait in order. They run in the background, so leaving the page never cancels one (RES-1).',
    source: 'D-021 (hypothesis)',
  },
  ANALYSIS_PARALLEL_MODEL_STEPS: {
    schema: z.stringbool().default(true),
    description:
      'Run trait extraction and the public summary at the same time; they read the same evidence and not each other.',
    source: 'D-025 (blocker 7: cold latency)',
  },
  PUBLIC_BUILD_WAIT_POLL_MS: {
    schema: int(500, 10),
    description:
      "How often an analysis waiting for another analysis's build of the same book checks again (PERF-2).",
    source: 'D-025 (hypothesis)',
  },
  PUBLIC_BUILD_CLAIM_TTL_SECONDS: {
    schema: int(180),
    description:
      'A build claim older than this is treated as abandoned (for example the process stopped), so another analysis may build.',
    source: 'D-025 (hypothesis: longer than a slow cold build)',
  },
  ANALYSIS_RECOVER_ON_START: {
    schema: z.stringbool().default(true),
    description:
      'On start-up, resume analyses that were running when the API stopped (RES-1). Never done when NODE_ENV is test, because test apps share one database.',
    source: 'D-021',
  },
  EVIDENCE_SUFFICIENT_REVIEWS: {
    schema: int(10),
    description:
      'Usable reviews with text needed for evidence to count as sufficient; fewer is limited (spec 8). Also the count for medium public confidence.',
    source: 'Spec 8, D-021 (hypothesis)',
  },
  PUBLIC_CONFIDENCE_HIGH_REVIEWS: {
    schema: int(40),
    description:
      'Usable reviews with text needed for high public evidence confidence, when no source failed and praise and complaints are both present.',
    source: 'Spec 4, D-021 (hypothesis)',
  },
  GEMINI_SUMMARY_MODEL: {
    schema: z.string().min(1).default('gemini-3.5-flash-lite'),
    description:
      'Model for the written summary, praise and complaints (spec 10: the small model unless measurement shows the larger one is needed).',
    source: 'D-021, H2',
  },
  RATE_LIMIT_ANALYSES_PER_HOUR: {
    schema: int(30),
    description: 'New analyses a reader may start per hour.',
    source: 'Spec 12 (hypothesis)',
  },
  RATE_LIMIT_DELETE_DATA_PER_HOUR: {
    schema: int(5),
    description:
      'Delete-my-data attempts per reader per hour. Each asks for the password, so this also limits password guessing.',
    source: 'D-022 (hypothesis)',
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
    schema: z.string().min(1).default('gemini-3.6-flash'),
    description:
      'Larger model compared against the smaller one for trait extraction (H2). Named explicitly: gemini-3.5-flash now routes to gemini-3.6-flash.',
    source: 'D-015, H2, D-028',
  },
  GEMINI_REFERENCE_MODEL: {
    schema: z.string().min(1).default('gemini-3.8-flash'),
    description:
      'Model that labels the LLM evaluation set and judges summary claims, following eval/llm/*-instructions.md. Must differ from both measured models. The strongest model with a free tier on 2026-10-22 (gemini-2.5-pro is closed to new users; gemini-3.1-pro-preview has no free tier).',
    source: 'D-028 (owner: labels by Gemini instead of by hand)',
  },
  TRAITS_EXTRACT_MAX_BOOKS: {
    schema: int(1000),
    description:
      'Most books `traits:extract` may cover: the offline evaluation set (eval/params.toml top_editions). It shares the daily model quota with live analyses, so a larger --limit is refused unless this is raised on purpose.',
    source: 'D-023',
  },
  LLM_EVAL_CATALOG: {
    schema: int(5000),
    description:
      'The evaluation set is drawn from this many most-rated editions (the catalog in use).',
    source: 'D-028',
  },
  LLM_EVAL_BOOKS: {
    schema: int(100),
    description:
      'Books in the trait evaluation set, hand-labelled by the owner (spec 9: about 50; 100 to stay on the free tier, D-028 update).',
    source: 'Spec 9, D-028',
  },
  LLM_EVAL_SUMMARY_BOOKS: {
    schema: int(25),
    description:
      'Books of the set that get a golden summary, whose claims are sampled for faithfulness.',
    source: 'D-028',
  },
  LLM_EVAL_CLAIMS: {
    schema: int(100),
    description: 'Summary claims judged for faithfulness (spec 9: about 100).',
    source: 'Spec 9, D-028',
  },
  LLM_EVAL_SEED: {
    schema: int(20261022, 0),
    description:
      'Seed of the evaluation set and claim sample, so the same books and claims are chosen again.',
    source: 'D-028',
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

  // --- Cost and latency measurement (spec 9, H4, D-026) ---
  LLM_PRICES_USD_PER_MTOK: {
    schema: z
      .string()
      .regex(
        /^[\w.-]+=\d+(\.\d+)?\/\d+(\.\d+)?(,[\w.-]+=\d+(\.\d+)?\/\d+(\.\d+)?)*$/,
        'Use model=input/output pairs separated by commas, in US dollars per million tokens',
      )
      .default('gemini-3.5-flash-lite=0.30/2.50,gemini-3.8-flash=0.75/3.75'),
    description:
      'Paid-tier list prices per million input and output tokens, as model=input/output pairs. Used to price measured token use; the free tier itself costs nothing.',
    source: 'ai.google.dev/gemini-api/docs/pricing, checked 2026-10-22 (D-026)',
  },
  COST_COMPARISON_MODEL: {
    schema: z.string().min(1).default('gemini-3.8-flash'),
    description:
      'Larger model the measured token use is also priced at, to report the saving of using the small model (spec 9 tiered model use).',
    source: 'D-026',
  },
  REPORT_BOOTSTRAP_RESAMPLES: {
    schema: int(1000, 100),
    description: 'Bootstrap resamples for the intervals in the cost and latency report.',
    source: 'D-026 (same as the offline evaluation, D-023)',
  },
  REPORT_SEED: {
    schema: int(20261022, 0),
    description:
      'Seed of the cost and latency report bootstrap, so the same rows give the same intervals.',
    source: 'D-026',
  },
} satisfies Record<string, ParamDef>;

export type ParamKey = keyof typeof PARAMS;
