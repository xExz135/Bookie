# Decision Log

Every decision that changes or clarifies the spec goes here. **OPEN** items block the work packages listed against them. Claude Code must not resolve an OPEN item on its own: it stops and asks the owner.

**How to add one:** copy the template, give it the next number, and set the status. Never delete a decision. If one is reversed, add a new entry that supersedes it.

```
## D-0XX Title
Status: OPEN | DECIDED | SUPERSEDED by D-0YY
Date: YYYY-MM-DD
Affects: work packages and spec sections
Context: why a decision is needed
Options: A, B, C (with consequences)
Decision: what was chosen and by whom
Consequences: what changes in code, spec or plan
```

---

## D-001 Authentication approach
Status: **DECIDED**
Date: 2026-10-20
Affects: FE-1, BE-3; spec sections 1, 3, 12, 14
Context: the owner's decision in the spec's section 1 says authentication is fully custom (the team writes password storage, reset emails and data encryption) because a managed provider needs a subscription. But section 3 (mandatory scope) and section 12 (security) say to use a managed provider or magic link, and section 14 (deferred) lists custom auth internals as out of scope.
Options:
- A. Custom email and password: argon2id hashing, reset emails with single-use expiring links, sessions with a short-lived access token and a refresh cookie. Most security code to write and test.
- B. Magic link sent by your own mail setup: no passwords to store or reset, much less security code, still no managed provider.
- C. Managed provider on a free tier, if one fits: least code, but depends on the provider's terms.
Decision: **A, custom email and password, with the extras in section 14 kept out.** Decided by the owner on 2026-10-20. The owner's section 1 note wins over sections 3 and 12.

In scope for v2:
- Register, login, logout, refresh, forgot password, reset password (endpoints in `CONTRACT.md` 4.1).
- Passwords hashed with argon2id. Never stored or logged in plain text. Length 10 to 128 characters (configurable).
- Access token: short-lived (default 15 minutes), kept in memory by the frontend.
- Refresh token: random, stored only as a hash, sent as an `httpOnly`, `Secure`, `SameSite=Lax` cookie (default 30 days). Rotated on every use: the old one is revoked and a new one issued.
- Reset links: single use, stored as a hash, expire after a configurable time (default 30 minutes). A successful reset revokes every refresh token for that user.
- Basic request throttling (per IP and per email) on register, login and forgot-password, through the same rate limiter used for scans and analyses. This is throttling, not account lockout.
- Email: Mailpit in Docker Compose for local development; real SMTP settings from environment variables. No paid mail service is required.
- "Data encryption" from the owner's note means: argon2id for passwords, SHA-256 hashes for every stored token, HTTPS in transit, and disk-level encryption from the host for data at rest. No field-level encryption in v2 (no field needs it).

Out of scope for v2 (deferred, spec section 14):
- Email verification. Accounts are usable right after registering. The "Verified Reader" badge in the mockups is removed (D-010).
- Account lockout after failed logins.
- Refresh-token family tracking and reuse detection.

Consequences:
- Without email verification, `POST /auth/register` cannot hide whether an email is already registered. It returns `409 EMAIL_IN_USE` for a taken email. This small account-enumeration risk is accepted and reduced by throttling. Login and forgot-password still give identical answers for known and unknown emails.
- SEC-2 ("no endpoint except sign-in is reachable without authentication") is read as: every `/auth/*` endpoint is public; every other endpoint needs a valid access token.
- Schema: drop `LoginAttempt`, `RefreshToken.familyId`, `User.emailVerifiedAt` and the `VERIFY` email-token type (see D-009).
- Spec sections 3 and 12 are annotated in `SPEC.md` to point here.

## D-002 Questionnaire gate
Status: **DECIDED**
Date: 2026-10-20
Affects: FE-2; spec sections 1 and 6 (ONB-2)
Context: the owner's note in section 1 says the reader must build a questionnaire before using the app. The onboarding journey in section 6 offers Import, Quick rate or Skip, treats the questionnaire as optional, and ONB-2 requires that skipping leads to public results. Earlier discussion also said skipping simply hides the personal match.
Options:
- A. Skip allowed (matches ONB-2 and the earlier statement).
- B. Questionnaire required before first use (matches the section 1 note; ONB-2 must change).
- C. Some taste input required (questionnaire, import or quick rate), questionnaire alone not required.
Decision: **A, Skip allowed.** Decided by the owner on 2026-10-20. This replaces the "questionnaire required before use" line in the section 1 note.
- After the first sign-in, the reader sees onboarding with: **Import ratings**, **Quick rate**, the **optional questionnaire**, and **Skip for now**.
- The onboarding screen is shown until the reader picks one of these, then never forced again. It stays reachable from the profile screen.
- Kept as a configuration setting `onboarding.allowSkip` (default `true`) so the gate can be switched on later without code changes. If it is ever set to `false`, ONB-2 must be changed in the spec first.
Consequences: ONB-2 stands as written. The result screen of a reader with no ratings shows public reception plus the invitation card (`personalMatch.status = needs_taste_data`).

## D-003 Which live sources are used
Status: **DECIDED**
Date: 2026-10-20
Affects: BE-5, BE-8; spec section 5
Context: the owner lists StoryGraph, Google Books, Open Library, LibraryThing and Hardcover. Spec section 5 says availability must be verified, not assumed, and a source that does not allow storing or displaying content is excluded or limited to derived data.
Decision: pending the audit in `docs/DATA_SOURCES.md`. Until it is complete, no live adapter is built, and the app runs on the dataset.
Audit so far (2026-10-20, details in `docs/DATA_SOURCES.md`): no audited source offers usable review text.
- StoryGraph: no official API; only a third-party service that logs in with your own account (100 free calls a month, then from $499 a month). Proposed: **exclude**.
- Google Books: ratings and metadata, no review text; needs a free API key; terms forbid permanent copies. Proposed: **use, live only** (cache per HTTP headers, never store).
- Open Library: ratings, metadata and covers, no review text; free, 1 request per second. Proposed: **use**, cached and rate-limited.
- LibraryThing (Talpa): natural-language search returning ISBNs only. Proposed: **exclude**.
- Hardcover: review text exists but its rules forbid using other users' data; aggregate ratings are allowed when labelled as Hardcover data. Free plan 5,000 requests a day; API in beta. Proposed: **derived data only** (average rating, count, breakdown).
Decision (owner, 2026-10-20): **use Open Library, Google Books and Hardcover; exclude StoryGraph and LibraryThing.**
- Open Library: `use`. Ratings, metadata and covers, cached, at most 1 request per second, identified by a User-Agent.
- Google Books: `use, live only`. Ratings and metadata fetched per analysis and kept only as long as the HTTP cache header allows; Google attribution shown.
- Hardcover: `derived data only`. Average rating, rating count and breakdown, always labelled as Hardcover data. No review text, no user data, no images.
- **Review text comes only from the UCSD Goodreads dataset** (spec section 5). The live sources add separate rating lines; they never supply written evidence.
Consequences:
- Adapters are built for these three sources only (BE-5). Their `review_sources` rows are added by a new migration with the terms above.
- Settings `GOOGLE_BOOKS_API_KEY` and `HARDCOVER_API_TOKEN` (secrets, server-side only). Test calls for Google Books and Hardcover run once the owner has put these in `.env`.
- The dataset was collected around 2017, so books published later usually have no review text. Their result shows live ratings but no written verdict (evidence `insufficient`, RES-3). This is a known limit, reported honestly in the UI and README.

## D-004 Dataset usage terms
Status: **DECIDED** (owner accepts the terms risk)
Date: 2026-10-20
Affects: BE-4, BE-12, BE-14, BE-15; spec section 5 and EVAL-3
Context: the data plan uses the UCSD Goodreads Book Graph. Its usage terms must be read and recorded.
Terms found (checked 2026-10-20 at https://mcauleylab.ucsd.edu/public_datasets/gdrive/goodreads/UCSD%20Book%20Graph.html):
- Verbatim: "We collected these datasets for academic use only. Please do not redistribute them or use for commercial purposes."
- Users are asked to cite: Mengting Wan, Julian McAuley, "Item Recommendation on Monotonic Behavior Chains", RecSys 2018; and Mengting Wan, Rishabh Misra, Ndapa Nakashole, Julian McAuley, "Fine-Grained Spoiler Detection from Large-Scale Review Corpora", ACL 2019.
- The page lists a contact for questions (Mengting Wan).
Owner's facts: Bookie is a **non-commercial personal portfolio project, not an academic one** (confirmed by the owner, 2026-10-20). This is outside the literal wording "academic use only".
Decision: **the owner chose to use the dataset anyway**, with these safeguards:
- **Files used** (stored in `data/raw/`, kept compressed, never committed):
  1. `goodreads_books.json.gz`: edition metadata.
  2. `goodreads_book_authors.json.gz`: author names.
  3. `goodreads_book_works.json.gz`: work grouping.
  4. `goodreads_book_genres_initial.json.gz`: genres (the page's link text says "gooreads"; the downloaded file is named as shown).
  5. `goodreads_reviews_dedup.json.gz`: review text and ratings (the page's link text says "goodread"; the downloaded file is named as shown).
  `goodreads_interactions.csv` and its two ID maps are not used unless the ratings in the reviews file prove too few for B3.
- **Never commercial.** Any commercial use requires removing the dataset first and replacing this decision.
- **No redistribution:** dataset files and review text are never committed or published. `data/` is git-ignored. The repository gets a download script and a checksum list instead.
- **EVAL-3 labeled sets:** commit only labels, dataset IDs and labeling instructions. Never review text. A script rebuilds the full set from a local copy.
- **Credit:** the README names the dataset and cites both papers.
- **Display:** review excerpts may be shown to signed-in readers in local and private demos. **Before any public deployment, this decision is revisited** (options: ask the dataset authors for permission, or set `display_allowed = false` so only derived data is shown).
- **If the dataset owners ask for the data to stop being used, it is removed.**
- Recommended, not required: email the dataset contact to ask whether non-commercial portfolio use is acceptable, and record the answer here.
Consequences: BE-4 is unblocked. `DATA_SOURCES.md` records the terms and the five files.

## D-005 Core stack
Status: **DECIDED**
Date: 2026-10-20
Decision: Next.js (App Router) and TypeScript for the frontend. NestJS, PostgreSQL and Redis for the backend. Gemini for LLM and vision. Python for the evaluation harness and models. Docker Compose for local development. Database software must be free, with no subscription.
Source: project discussion before this repository existed.

## D-006 How the models are served to the API
Status: **DECIDED**
Date: 2026-10-20
Affects: BE-12, BE-13, BE-14
Options:
- A. A small Python service the NestJS API calls.
- B. Precompute book vectors and model weights offline, load them into PostgreSQL or memory, and score in TypeScript.
- C. Run the models in Python and write scores to a table the API reads.
Decision: **B.** Decided by the owner on 2026-10-20.
- Python (in `eval/`) trains every model and exports versioned artifacts: book embeddings, the B2 regression coefficients, the B3 item factors or item-to-item neighbour lists, and the B4 blend weights. Each export has a `modelVersion` and records its training data, seed and code commit.
- Artifacts are loaded into PostgreSQL. Book embeddings use the free `pgvector` extension.
- NestJS scores in TypeScript at request time. These are small calculations: a weighted average of embeddings, cosine similarity, a linear mapping, item-neighbour averaging or a small least-squares fold-in for B3, and a weighted blend.
- **Parity test (required for MODEL-1):** a fixture set of readers and books is scored by both the Python and the TypeScript code in CI. The change fails if any score differs by more than 1e-6.
- The embedding model must be callable from both Python and TypeScript (for example the Gemini embedding API), so that books outside the precomputed set can be embedded at request time with the same model. The exact model is chosen in BE-12 by measurement.
Consequences: no extra Python service runs in production. BE-13 is unblocked.

## D-007 Score scale and wording
Status: **DECIDED** (by the spec)
Date: 2026-10-20
Decision: the personal match is shown on a rating-like scale (1 to 5 proposed in `docs/CONTRACT.md`), and is never presented as a probability of enjoyment. The UI states this.
Source: spec section 4, Preference match.

## D-008 Default thresholds
Status: **DECIDED as configurable defaults**
Date: 2026-10-20
Decision: minimum rated books for a confident match 10, hard floor 3, evidence set at most 75 reviews, scan resize 1024 px, per-reader holdout 20%, user study about 30 readers, labeled sets about 50 books, faithfulness sample about 100 claims. All are configuration values and hypotheses to be measured, not verified facts.
Source: spec sections 6, 8 and 9.

## D-009 Schema version
Status: **DECIDED**
Date: 2026-10-20
Affects: BE-2
Context: the PostgreSQL schema written earlier (now `docs/reference/v1_schema.prisma`) follows the v1 design (questionnaire and trait matching) and the mockups. v2 adds ratings, taste-profile versions, embeddings, model versions, reading list and imports. Its enums also disagree with `CONTRACT.md`.
Decision: **the old Prisma file is reference only. BE-2 writes a new v2 schema** that follows `CONTRACT.md` and this plan. Decided by the owner on 2026-10-20.

Keep (with the changes listed):
- Catalog: `Work`, `Edition`, `EditionExternalId`. Drop the audiobook fields (`narrator`, `durationSeconds`, `asin`) unless the dataset provides them.
- Sources and reviews: `ReviewSource`, `ReviewFetch`, `Review`. Drop `ReviewSource.audience` and `sourceType`, and `Review.reviewerRole`. Keep `storageAllowed` and `displayAllowed`.
- Public analysis: `PublicAnalysis`, `AnalysisEvidenceItem`, `AnalysisClaim`, `ClaimEvidence`, `BookTrait`, `BookTraitEvidence`. Drop `publicScore`, `criticScore`, `readerScore`, `consensusLabel` and the 0 to 100 `confidenceScore` (D-010).
- Analyses: `Analysis`, `AnalysisStep`, `PersonalAnalysis`, `Feedback`, `RefreshRequest`, `ScanUsage`, `AppSetting`. Drop `Analysis.verdict` (D-010).
- Auth: `User`, `EmailToken` (reset only), `RefreshToken` without `familyId`. Drop `LoginAttempt` and `emailVerifiedAt` (D-001).

Add:
- `TasteProfileVersion` (replaces `ProfileVersion`): immutable, numbered per user, with snapshot rows `ProfileRating` (editionId, rating 1 to 5, origin `quick_rate` or `import`) and the optional questionnaire fields from D-011.
- `RatingImport` and `RatingImportRow`: import status, matched count, and the unmatched rows with candidates. Raw rows are deleted once the import is confirmed (spec: keep only the ratings).
- `BookEmbedding` (edition or work, embedding model, `vector` via pgvector) and `TasteVector` (per profile version and model version).
- `ModelVersion`: model ID (B0 to B4), version string, artifact checksum, training seed, code commit, and the validation and test metrics (EVAL-2).
- `PersonalAnalysis` gains `modelId`, `modelVersion`, a `score` on the 1 to 5 scale (`Decimal(3,2)`), `confidence` with `confidenceReasons`, and child rows `PersonalSimilarBook` (the rated books that explain the score) and `PersonalTraitFit` (trait, `aligned` / `conflicting` / `unknown`, evidence).
- `ReadingListItem` (user, edition, addedAt).
- `Feedback` gains `modelVersion`.

Align enums with `CONTRACT.md` section 3:
- `StepName`: `resolve`, `fetchReviews`, `selectReviews`, `extractTraits`, `publicSummary`, `evidenceConfidence`, `personalMatch`, `finalize`.
- `AnalysisStatus`: `running`, `complete`, `partial`, `failed` (drop `CANCELLED`: leaving never cancels, RES-1).
- Trait keys: `pace`, `tone`, `themes`, `contentIntensity`. Trait fit: `aligned`, `conflicting`, `unknown`.
- Drop `VerdictLabel`, `ConsensusLabel`, `AudienceType`, `SourceType`.

Not in the database: offline evaluation results and labeled sets live as files in `eval/` (reproduced by one command, EVAL-1), not in tables.

Consequences: the old file keeps a header saying it is reference only. Acceptance IDs quoted in it (ACC-1, PROF-3, AUTH-5 and others) are v1 IDs and do not exist in the v2 spec.

Implementation notes (BE-2, 2026-10-20). Built in `apps/api/prisma/`. Where it differs from the plan above:
- `AppSetting` is not a table. Settings live in `apps/api/src/config/params.ts` and the environment (BE-1).
- The questionnaire is stored as rows (`profile_genre_preferences`, `profile_theme_avoidances`) plus a nullable `pace` column. A missing row means unknown, which keeps ONB-3 simple to enforce.
- Authors have their own table (the dataset links books to author IDs). Works, authors and editions each have an external-ID table for the dataset's IDs.
- Reviews do not belong to a fetch, because dataset reviews exist without one. `review_fetches` records each source query's outcome and counts.
- Evidence items have their own IDs (the contract's `evidenceIds`) and a kind: `review`, `description` or `source_aggregate` (for sources whose text may not be stored). Claims and traits cite them through composite foreign keys, so the database itself rejects a citation to missing evidence or to another analysis's evidence (RES-5).
- `personal_analyses` is linked one-to-one to `analyses` and stores an outcome (`scored`, `below_floor`, `needs_taste_data`). Running, failed and skipped come from the step status.
- The current taste-profile version is the one with the highest `version_no`; there is no pointer column.
- Immutability: updates to saved profile versions and personal results are rejected by triggers, and their child rows can only be inserted in the transaction that created the parent. Deletes stay allowed so delete-my-data works (SEC-3).
- Embedding vectors have no fixed dimension until the embedding model is chosen (BE-12), which also adds their index.
- Seed rows: the dataset's 10 genre groups, 4 themes to avoid (taken from the reader-profile mockup; the owner may extend the list) and the `goodreads_dataset` source policy (D-004).

## D-012 Database access library
Status: **DECIDED**
Date: 2026-10-20
Affects: BE-2 onward
Context: the earlier schema was written for Prisma. A library had to be chosen for migrations and queries.
Decision: **Prisma 7.10.1**, pinned. Made by the backend role while building BE-2.
- npm's "latest" tag for Prisma pointed at a release candidate (8.0.0-rc), so the last stable release is pinned instead.
- Prisma 7 uses the `pg` driver through `@prisma/adapter-pg`. The client is generated into `apps/api/src/generated/` (git-ignored) by `pnpm install`.
- Hand-written SQL (extensions, CHECK constraints, triggers, the partial unique index, seed rows) lives at the top and bottom of the first migration.
- Prisma refuses destructive commands such as `migrate reset` when run by an AI agent unless the user consents. That guard stays on.
Consequences: queries outside Prisma's reach (vector search, trigram search) use `$queryRaw`.

## D-010 One rule for designs and schema: three separate signals, no percentages
Status: **DECIDED**
Date: 2026-10-20
Affects: FE-1 to FE-9, BE-2, BE-8, BE-10; spec sections 4, 6 and 7; `docs/design/`
Context: the mockups in `docs/design/` and the old schema break rules the spec calls non-negotiable. They show a combined "Verdict: Highly Recommended" label built from the public and personal scores, show the personal match as a percentage ("84% Match"), explain the match from the v1 questionnaire, and list sources (NYT, the Guardian, Kirkus) that are not in the data plan.
Decision: **keep the visual style of the mockups; change their content as follows.** Decided by the owner on 2026-10-20. Where a mockup and this list disagree, this list wins.
1. **No combined verdict anywhere.** Remove "Verdict: Highly Recommended", "Worth Exploring" and similar labels from every screen, the API and the database.
2. **Personal match on the 1 to 5 scale**, one decimal, written like "4.2 / 5", always next to the line that it reflects similarity to the reader's taste and is not a probability of enjoyment. No percentages and no band words ("Excellent Match", "Likely Misalignment") unless the API returns them.
3. **Public reception** shows the written summary, praises and complaints with citations, and the average rating and review count per source. No "% Acclaim" and no consensus labels ("Universal Acclaim"): the contract has no code-computed rule for them. They can be proposed later as a contract change with a defined formula.
4. **Evidence confidence** is its own element on each side: level (low, medium, high) plus the reasons from the API. No "88/100" numbers.
5. **Match explanations come from the model:** "Similar books you rated" (title and your rating), traits that aligned or conflicted with their evidence, and "Not factored in". Remove "Evaluated against 5 of your core reading preferences". When a fallback model (B0 or B1) produced the score, say so and show low confidence.
6. **Sources:** show only sources returned by the API. Until D-003 is decided, fixtures and mock data use the Goodreads dataset only. Remove critic or reader splits, reviewer bylines and roles.
7. **Progress rail** shows the eight steps in `CONTRACT.md` (`stepName`), not the seven in the mockup.
8. **Profile screen:** rated books come first (import, quick rate, progress toward `minForConfidence` from the API). The questionnaire (D-011) is an optional section below. Remove the page-length sweet spot and the "include books over 600 pages" option (not in the spec). Benchmark books become ordinary ratings. Remove "Profile Completeness 95%" (not in the contract; the browser must not compute it). The version-history panel needs a contract endpoint first.
9. **Feedback buttons** say **Accurate** and **Not for me** (spec wording) for each section separately.
10. Remove the "Verified Reader" badge (no email verification, D-001), the "Install PWA" button (deferred, spec section 14) and "Online & Synced".
11. **Design tokens:** the YAML block at the top of `docs/design/DESIGN.md` is the official token set (it is what `discover.html` uses). Hex values in the prose of that file are descriptive only.
12. Screens with no mockup (onboarding, import review, reading list, compare, settings) are built with the same tokens and components. No new mockups are required before building them.
Consequences: the Stitch export files stay unchanged as a style reference. `FRONTEND.md` points here.

## D-011 Questionnaire fields
Status: **DECIDED**
Date: 2026-10-20
Affects: FE-2, BE-7, BE-13 (B1); `CONTRACT.md` 4.2
Context: the spec lists liked genres, preferred pace and themes to avoid. The draft contract had `themeTolerance` (one value), and the mockup has per-theme sensitivity levels, page ranges and benchmark books.
Decision: the optional questionnaire has exactly these fields. Every field may be left unanswered, which is stored as unknown and never counts as a dislike (ONB-3, MODEL-2):
- `likedGenres`: list of genres, or `null`.
- `dislikedGenres`: list of genres, or `null`.
- `pace`: `slow`, `moderate`, `fast`, or `null`.
- `themesToAvoid`: list of `{ theme, sensitivity: high | moderate | low }`. A theme that is not listed is unknown.
Genre and theme names come from a server-side list (`GET /questionnaire/options`).
Consequences: `CONTRACT.md` 4.2 updated (draft v0.2).

## D-013 Reviews from other editions of the same work
Status: **DECIDED (rejected)**
Date: 2026-10-20
Affects: BE-4, BE-8; spec section 4 (work and edition)
Context: an edition with no reviews of its own could borrow the dataset reviews of other editions of the same work, labelled as such.
Decision: **no.** Decided by the owner on 2026-10-20. Each edition uses only its own reviews, as spec section 4 says. An edition without usable reviews gets no written verdict (RES-3) and shows the live ratings and the personal match only.

## D-014 How the Goodreads dataset is imported
Status: **DECIDED** (backend role, BE-4)
Date: 2026-10-20
Affects: BE-4, BE-6, BE-8, BE-14
Context: the dataset needs mapping rules, and its size (2.36m books, 15.7m reviews) needs a loading strategy.
Decision:
- **Command:** `pnpm --filter @bookie/api import:goodreads` (everything) or with `--limit-books N` (the N most-rated books with their works, authors, genres and reviews). Streams the `.json.gz` files and bulk-loads with PostgreSQL `COPY`.
- **Re-runnable:** every ID is derived from the Goodreads ID (UUID version 5), so a re-run never duplicates rows. Editions and works whose details changed are updated; reviews, genres and links are only added.
- **Titles:** the trailing series marker ("(The Hunger Games, #1)") is removed, because the dataset's `title_without_series` field still contains it.
- **Missing values stay unknown:** Goodreads' "nophoto" placeholder becomes no cover; blank language, year, pages and ISBNs become null. Language codes are converted to BCP 47 ("eng" becomes "en").
- **Reviews:** rating 0 means no rating. A review with neither rating nor text is skipped. A rating without text is kept as a rating-only review (empty text), which evidence confidence counts separately (spec 4).
- **Goodreads' own rating summary** for each edition (average and count from the books file) is stored as a `review_fetches` row for the dataset source that never expires. Its `review_count` is the number of dataset reviews for that edition.
- **Missing references:** a book whose work is not in the works file gets its own placeholder work; author links to authors missing from the authors file are dropped; reviews of books not in the catalog are dropped.
- Cover URLs point at Goodreads' image server as recorded in 2017; nothing is downloaded or stored. Some links may no longer work.
Consequences: search (BE-6) and the pipeline (BE-8) read only the catalog tables, never the files.

## D-015 Book representation: embeddings, evidence selection and trait vocabulary
Status: **DECIDED** (backend role, BE-12; defaults are configurable and to be measured)
Date: 2026-10-21
Affects: BE-8, BE-12, BE-13, BE-14, BE-15; spec sections 7 and 8
Context: spec 7 asks for "a sentence-embedding of the description and selected review text, plus LLM-extracted traits (pace, tone, themes, content intensity), each stored with the supporting evidence". D-006 left the embedding model and vector size to this package.
Decision:
- **Embedding model `gemini-embedding-001`, 768 dimensions**, vectors normalised to length 1 and stored in `book_embeddings` with a cosine HNSW index. `gemini-embedding-2` accepts longer input (8,192 tokens) but its free-tier quota ran out after one request of about 47,000 tokens on 2026-10-21, so it is not practical without a paid plan. The stored model key (`gemini-embedding-001:768:text-v1`) names model, size and text recipe so vectors made differently never mix. BE-14 may compare models.
- **Embedding text:** title, authors, genres, description and up to 20 selected reviews, cut to 7,000 characters (the model accepts 2,048 tokens).
- **Evidence selection (spec 8), shared with the pipeline:** reviews under 80 characters are dropped; duplicates (same text after normalising) are dropped; reviews must be detected as English (`tinyld`, offline) and undetectable ones are dropped; complaints, praise, mixed and unrated reviews are taken in turn so both sides are represented; each review is cut to 1,000 characters at a word boundary; at most 75 per edition. Candidates are a stable sample of 400 reviews per edition, ordered by ID, so the same set comes back every time (MODEL-1).
- **Trait vocabularies** (closed lists, so accuracy and macro-F1 can be measured for H2): pace = slow, moderate, fast; tone = dark, light, serious, humorous, hopeful, melancholic, tense, romantic (one per book); content intensity = low, moderate, high; themes = up to 5 of 17 fixed themes, including addiction, violence, tragedy and grief and loss so they line up with the "themes to avoid" questionnaire. Any trait may be "unknown", which never cites evidence.
- **Trait extraction model:** `gemini-3.5-flash-lite` (small) by default; `gemini-3.5-flash` is the larger model for the H2 comparison. Temperature 0, JSON schema output.
- **Untrusted text (RES-6):** reviews, description and title are wrapped in tags and any `<` or `>` inside them is replaced, so they cannot close a tag or pose as another review. Rules live in the system prompt, data in the user message.
- **Validation in code (RES-5):** values must be in the vocabularies; every non-unknown value must cite evidence; every citation must exist in this evidence set (0 = description, 1..N = reviews). Invalid output is retried once, then the step fails with INVALID_MODEL_OUTPUT.
- **Rate limits:** the client paces requests per minute and estimated tokens per minute (default 30,000, measured: the free tier rejected about 60,000 tokens in a minute), waits a full minute after a rate limit without a stated delay, and reports a quota that stays exhausted as `quota` (LLM_QUOTA_EXHAUSTED).
Consequences:
- On the free tier, embedding is slow: roughly 15 to 20 books a minute. Embedding the 5,000-book sample takes hours, and the whole catalog is not practical. BE-14 should embed only the books its evaluation needs, or the owner can choose a paid plan.
- Traits are stored with a public analysis by the pipeline (BE-8). Until then, `traits:sample` writes results to `data/derived/` (git-ignored) for review and the H2 comparison.

## D-016 Authentication implementation details
Status: **DECIDED** (backend role, BE-3; within the scope fixed by D-001)
Date: 2026-10-21
Affects: FE-1, BE-3, BE-6, BE-7, BE-8, BE-10; CONTRACT 4.1
Context: D-001 fixed what authentication does. These are the choices made while building it.
Decision:
- **Access tokens** are HS256 JWTs signed with `AUTH_TOKEN_SECRET`, holding only the user id, a token version, and issue and expiry times. Only this exact header is accepted, so a token cannot pick another algorithm.
- **Ending sessions on password reset:** users get a `token_version` column (new migration). A reset raises it, and the guard rejects access tokens that carry an older value. Every earlier session therefore ends at once instead of up to 15 minutes later, which the contract asks for. The guard reads the user row on each request; that also cuts off deleted users at once.
- **Every route is closed by default (SEC-2):** a global guard needs a valid access token unless the route is marked `@Public()`. A test fails if `@Public()` appears outside the auth and health controllers, and another calls every documented operation without a token and expects `401`.
- **Throttling** uses fixed windows in Redis, counted per action, per IP and per email. Email keys are hashed, so Redis never holds an address. If Redis is down, counting continues in the API process's memory (spec 10: continue without the cache layer) instead of letting every request through. The same limiter will serve scans and analyses.
- **Reset links** put the token in the URL fragment (`/reset-password#token=...`), which browsers never send to a server or in a Referer header. Requesting a reset sends the email in the background, so response time does not reveal whether the email has an account. A successful reset also voids the account's other unused links.
- **Login timing:** an unknown email still costs one argon2id check against a dummy hash, so it takes as long as a wrong password.
- **`GET /me`** was added so the frontend can load the user after a page reload (refresh, then `/me`). Proposed in CONTRACT 4.5; approved by the owner on 2026-10-21.
- **Refresh races:** with rotation and no token families (D-001), two parallel refreshes with the same cookie cannot both succeed. The frontend runs one refresh at a time (CONTRACT 4.1).
- **Accepted risk:** per-email login throttling means someone who knows a reader's email can keep that reader from logging in for up to one window (default 15 minutes) by sending wrong passwords. This is the trade-off of throttling without lockout or CAPTCHA, and fits a portfolio deployment.
- **Behind a reverse proxy**, set `TRUST_PROXY=true` so per-IP throttling sees the real client address.

## D-017 Search and cover identification
Status: **DECIDED** (backend role, BE-6; thresholds are configurable hypotheses, to be measured)
Date: 2026-10-21
Affects: FE-3, FE-4, BE-6, BE-7 (import matching uses the same search), BE-8; spec section 6; CONTRACT 4.3
Context: spec 6 asks for normalized, fuzzy matching against stored books first, then external metadata; at most three candidates; a confidence value with an uncertain state below a threshold; and never auto-selecting between plausible matches.
Decision:
- **Catalog search** uses the trigram indexes from the first migration. A match score (0 to 1) is the best of: title similarity, the query appearing inside the title, the query appearing inside the author names, and similarity to title plus authors (so "hunger games collins" works). Dataset rating counts lift popular books a little (`SEARCH_POPULARITY_WEIGHT`). Valid ISBN-10 and ISBN-13 queries are looked up exactly first. Measured on the 5,000-book dev catalog: about 3 ms in the database; typos like "hary poter" still find Harry Potter. Speed on the full 2.3m-book catalog is not measured yet; `SEARCH_TIMEOUT_MS` caps each query.
- **One candidate per work.** Three cards are three different books. Within a work, the edition with the most dataset ratings is shown, because it carries the most reviews. The candidate names that edition (language, year, publisher, format), and the analysis will name it too (DISC-5, finished in BE-8). Choosing among other editions of the same work is not offered in v2.
- **Open Library fallback** when no catalog book scores at least `SEARCH_EXTERNAL_BELOW_SCORE`: up to five works, each with Open Library's best edition for the reader's language. They are added to the catalog with name-based IDs, so they get an `editionId` and the same ranking. A result is not added when the catalog already has the book (same ISBN, or near-identical title and author); the Open Library work ID is linked to the existing work instead, for its ratings in BE-5. Outcomes are remembered in Redis: about a day for results and empty answers, minutes for failures (spec 10). A failure is reported as `failed` or `rate_limited`, never as no results. The User-Agent names the app and its GitHub page but no email, so the limit stays at 1 request per second.
- **Cover reading** uses `gemini-3.5-flash-lite` with the photo and a prompt asking only for what is printed: whether it is a book, title, subtitle, authors, and a certainty word (high, medium, low). Text in the photo is treated as data. Invalid output is retried once. Measured on 2026-10-21 with three images: two real covers read correctly with high certainty, a plain image reported as not a book; about 1,300 input tokens and 1.3 to 2.2 seconds each.
- **Identified or uncertain is decided in code, not by the model.** The spec's "confidence value" is the model's certainty plus code-computed match scores. A scan is identified only when the model read title and author with high certainty and exactly one catalog book matches the title (`SCAN_MIN_CONFIDENCE`, trigram similarity) and the author (`SCAN_AUTHOR_MIN_MATCH`). Everything else is uncertain and goes to confirmation (DISC-2).
- **Upload handling (DISC-3, DISC-4):** multer keeps the file in memory with a size limit that stops the upload once exceeded. The type is taken from the file's bytes; only JPEG and PNG are accepted (the client sends JPEG). The file must parse; EXIF, XMP, comments and PNG text chunks are removed before the photo is sent to the vision model, since they can hold the reader's location. Nothing is written to disk or the database; `scan_usages` holds only the reader and the time.
- **Scan quota:** `SCAN_DAILY_QUOTA` scans in any 24 hours, counted in the database under a per-reader lock. Rejected uploads do not count. A scan is given back when identification fails on our side (service down, quota, invalid output), not when the photo is the problem (not a book, unreadable).
- **Search rate limit** per reader (`SEARCH_RATE_LIMIT_PER_MINUTE`), mainly to protect Open Library.
- **Contract additions** (CONTRACT 4.3, approved by the owner on 2026-10-21): `publisher` and `format` on `Candidate`, nullable fields, `external` on search and scan, `recognized` on scan.
Known limits: "gone girl" also lists "Julie and Julia" (its long title contains "one girl"): the word-inside-title score is generous. Ranking quality should be measured with a small labelled query set later (BE-15).

## D-018 Taste capture: versions, import matching and onboarding
Status: **DECIDED** (backend role, BE-7; thresholds are configurable hypotheses)
Date: 2026-10-21
Affects: FE-2, BE-7, BE-8 (`isOutdated`), BE-13 (reads profile versions); spec section 6; CONTRACT 4.2
Context: spec 6 asks for import, quick rate and an optional questionnaire, each save an immutable profile version, import matching with the same confirmation rules as search, unmatched rows listed, and unknown answers stored as unknown.
Decision:
- **Every save writes a whole new version** (ratings, genre preferences, theme avoidances, pace), copied from the previous one with the change applied, in one transaction under a per-reader lock. The database already refuses changes to old versions and child rows added later. A save that changes nothing writes nothing. The cost is copying all ratings on each save (about 1,000 rows for a big import); fine for v2, and saves are limited per minute (`RATING_SAVES_PER_MINUTE`).
- **`isOutdated`** is computed when read: a result is outdated when its profile version is not the reader's latest (ONB-4). Nothing is stored that could go stale.
- **Import formats:** Goodreads and StoryGraph CSV exports, recognised by their header. Only title, author and rating are kept; reviews, notes, shelves and dates are never read into memory beyond parsing, and never stored. Unrated rows (Goodreads 0, StoryGraph empty, "to-read") are counted as ignored and reported. StoryGraph quarter stars are rounded to whole stars, halves up, at least 1.
- **Import matching**, most certain first: (1) the Goodreads book id, which is the dataset's own id, so a Goodreads row matches exactly when the book is in the catalog; (2) ISBN-13 or ISBN-10; (3) catalog search with title and author, accepted only when exactly one book matches title (`IMPORT_MIN_TITLE_MATCH`, default 0.8, stricter than a scan because nobody looks at it) and author (`IMPORT_MIN_AUTHOR_MATCH`). Everything else is listed with up to three candidates. Open Library is not asked during import (hundreds of rows at 1 request per second); the reader can search for an unmatched book, which does use it. Checked live on 2026-10-21 with a five-row Goodreads export: Hunger Games by book id, Harry Potter, Pride and Prejudice and The Employees by title, the unrated row ignored.
- **Background matching:** exact matches happen during upload; title matching runs after the `202`. An import still `processing` after `IMPORT_STALE_SECONDS` (for example after a restart) is picked up again on the next read, since title, author and rating are stored.
- **Confirm:** rows the reader resolves get the chosen edition; rows left out are skipped. Imported ratings replace earlier ratings of the same edition. Confirming twice is `409`.
- **Onboarding (D-002):** `POST /onboarding/skip` sets `skipped` (never undoing `completed`); any taste save sets `completed`. With `ONBOARDING_ALLOW_SKIP=false` skipping is refused with `409`.
- **Questionnaire:** a `PUT` replaces all four answers. Missing or `null` fields, and empty lists, are stored as nothing and read back as `null`: unknown, never a dislike (ONB-3). Names must come from `GET /questionnaire/options`; a genre cannot be both liked and disliked.
- **Quick rate list:** `GET /catalog/search` without `q` lists the most-rated books (cached 10 minutes); with `q` it is the discovery search with more results. Each item carries the reader's current rating.
Not covered here: ONB-3's "never affect the score" is proven where the score is computed (BE-13, MODEL-2). ONB-2's invitation card comes from the analysis (`personalMatch.status = needs_taste_data`, BE-8).

## D-019 The Analysis object (result screen and history)
Status: **DECIDED** (approved by the owner for both roles on 2026-10-21)
Date: 2026-10-21
Affects: BE-8, BE-10, BE-13, FE-5, FE-6, FE-7, FE-8; spec sections 6 to 8; CONTRACT 4.4
Context: the v0.2 draft of the `Analysis` object predates the decisions on sources (D-003), traits (D-015) and taste versions (D-018), and could not drive the result-screen mockup without the browser computing things (retry availability, which rating covers which edition, which traits were not factored in).
Options:
- A. Keep the v0.2 draft and fill gaps during BE-8 and FE-5.
- B. Agree the full shape now, published as schemas and planned fixtures before the endpoints exist, so FE-5 can build against fixtures while BE-8 builds the pipeline.
Decision: **B.** Main choices, all in CONTRACT 4.4:
- **Cited evidence travels with the analysis**, replacing the per-item evidence endpoint. The screen needs every excerpt anyway (quotes under praises, the excerpts section), one request is simpler than dozens, and including exactly the cited items makes RES-5 checkable on every response. Size is bounded by the 75-review evidence set and 1,000-character excerpts.
- **One `sources` list** with outcome and rating per source, instead of separate `ratings` and `sources`. `ratingScope` says when a rating covers the whole work (Open Library), since spec 4 says reviews of one edition are not assumed to apply to another.
- **"Not factored in" is a trait fit of `unknown`**, with `bookValues` and `yourValues` saying which side is missing, instead of free-text `notFactoredIn` strings. Explanations stay model output, not prose (spec 7). The `personal_analyses.not_factored_in` column is then unused; BE-8 may drop it.
- **The server decides, the browser displays:** `canRetry`, `isFallback`, `isOutdated` with `currentTasteProfileVersion`, the score already rounded to one decimal, and the thresholds for the below-floor message.
- **Rules a JSON schema cannot express are checked in code** by the `Analysis` schema (`apps/api/src/analysis/analysis.schemas.ts`): citations resolve, no summary without evidence, no score below the floor, fallback means low confidence, and others. BE-8 validates its output against the same schema.
Consequences: FE-5 to FE-8 can start against `contract/fixtures/analyses-*.json`. The fixture test accepts `"planned"` fixtures until their endpoint exists, and fails if the mark stays after it is built.

## D-020 Live rating adapters: matching, scope and Google Books
Status: **DECIDED** (backend role, BE-5; the Google Books switch decided by the owner on 2026-10-21; thresholds are configurable hypotheses)
Date: 2026-10-21
Affects: BE-5, BE-8, BE-9, BE-11; spec sections 5, 8, 10, 11; CONTRACT 4.4 (`sources`)
Context: the three live sources from D-003 return fuzzy results. Hardcover search always returns something, Open Library's ISBN lookup returned an exhibition catalogue for an ISBN that does not exist, and Google Books' `isbn:` search returned nothing for valid ISBNs. The code has to decide which result is the reader's book, which edition a rating covers, and how long each answer may be kept.
Decision:
- **Matching in code** (`apps/api/src/sources/book-match.ts`): a result is the reader's book only when the title (with or without subtitle, series marker or alternative title such as "The Hobbit, or There and Back Again") reaches `SOURCE_MATCH_MIN_TITLE` (default 0.75) **and** an author reaches `SOURCE_MATCH_MIN_AUTHOR` (0.5). Similarity is computed like PostgreSQL `pg_trgm`. An ISBN match ranks a result higher but never replaces the title and author check. 0.75 keeps box sets out ("The Hunger Games Trilogy" scores 0.71).
- **Lookup order:** Open Library uses the work key the catalog already has (BE-6), then an ISBN search, then title plus author. Hardcover tries ISBN-13 or ISBN-10, then search. Hardcover's `compilation` flag is only a preference, because it is wrong for some single novels (Divergent).
- **Scope:** Open Library and Hardcover ratings cover the whole work (`ratingScope: work`). Google Books ratings belong to one volume, so only the volume with this edition's ISBN is used (`ratingScope: edition`), in line with D-013.
- **Outcomes:** `ok` with average and count; `empty` with a reason (`not_found`, `no_ratings`, `no_isbn`); `failed` or `rate_limited` with a code (`timeout`, `unauthorized`, `bad_response`, `http_NNN`, `network`, `internal`). A failure never becomes `empty` (RES-4). A refused Hardcover token is `failed`/`unauthorized`.
- **Parallel with a deadline:** `RatingSourcesService` asks every source whose `review_sources` row is enabled and whose key is set, all at once, each within `SOURCE_DEADLINE_MS` (default 12 s). A source that misses the deadline is `failed`/`timeout`.
- **Expiry:** `ok` lasts `CACHE_REVIEWS_TTL_DAYS`, `empty` lasts `CACHE_SOURCE_EMPTY_TTL_HOURS`, and a failure lasts `CACHE_SOURCE_FAILURE_TTL_MINUTES` (spec 10). For a source that may not be stored (Google Books), `ok` expires when its HTTP cache header says, or at once when it sends none (it sent none on 2026-10-21).
- **Google Books is built but off by default** (`GOOGLE_BOOKS_ENABLED=false`; owner, 2026-10-21). With the same-edition rule it matched 0 of the 12 most-rated catalog books, because ISBN search returns nothing and title search returns other editions. Turning it on costs about 3 seconds and up to 2 requests per book.
- **Open Library is one client for the whole app** (`SourcesModule`), so search (BE-6) and ratings share the one-request-per-second spacing.

Measured (2026-10-21, `sources:check`): the 40 most-rated catalog books gave Open Library 40 of 40 (all by ISBN) and Hardcover 40 of 40 after the compilation fix (37 by ISBN, 3 by title and author). The five audit books (popular, niche, non-English, several editions, non-existent) were all right, and the non-existent one was `empty` on both sources. Time per source: median about 1.5 s, 95th percentile about 2.2 s. The two sources can disagree a lot: Twilight 3.69 vs 2.94, Fifty Shades of Grey 3.93 vs 2.68, both matched by exact ISBN. That is a difference in reception, which is why the contract shows each source separately and never one combined number (D-010). Wrong matches were checked only by eye (big gaps between sources); no labeled set exists yet.

Consequences:
- BE-8 records each `SourceRating` as a `review_fetches` row and shows it in `Analysis.sources`. Rows from a source that may not be stored (`storageAllowed = false`) are kept with their outcome only, never their numbers past `expiresAt`. If Google Books is ever turned on, its numbers must be fetched live for display and must not be copied into a stored analysis.
- Matches are not written back to the catalog (no new `work_external_ids`), so a wrong match never becomes permanent. Lookups are cached per edition by BE-8 and BE-9.
- Hardcover data is never sent to a language model (its terms forbid training LLMs on it, and rating-only sources supply no text).
- Thresholds are hypotheses: rerun `pnpm --filter @bookie/api sources:check --limit N` after changing them, and record the counts here.

## D-021 Analysis pipeline: running, storing, statuses and the personal step
Status: **DECIDED** (backend role, BE-8; the personal-step behaviour and `MODEL_UNAVAILABLE` approved by the owner for both roles on 2026-10-21; thresholds are configurable hypotheses)
Date: 2026-10-21
Affects: BE-8, BE-9, BE-10, BE-11, BE-13, FE-5, FE-7; spec sections 7, 8, 10, 11; CONTRACT 2 and 4.4
Context: spec 8 lists eight steps with their own statuses, retries that never repeat done steps (RES-2), and analyses that survive the reader leaving (RES-1). The taste models (BE-13) do not exist yet, so the personal step has nothing to score with.
Decision:
- **Background runner in the API process** (`AnalysisRunner`): `POST /analyses` creates the analysis with eight pending steps and returns at once; the reader polls. At most `ANALYSIS_MAX_CONCURRENT` (2) run at a time, the rest wait in order. No queue service is added. On start-up, analyses left `running` are resumed from their first unfinished step (a step cut off mid-way runs again); test apps never do this, because they share one database. If the pipeline itself breaks (for example the database goes away mid-step), the analysis is marked `failed` with `INTERNAL_ERROR`, so it can be retried and is never stuck as running. One API process is assumed; several processes would need a shared lock (BE-9).
- **Each step stores its output** (`analysis_steps.output`, new migration): source outcomes, the IDs and numbers of the selected reviews, traits, the written summary, the confidence. A retry reruns only failed steps and the steps skipped because of them, reading the rest from storage (RES-2). Outputs hold IDs, numbers and model-written text, never review text (D-004).
- **Shared public analysis:** the public steps build one `public_analyses` row per edition and reviews version, saved in one transaction with its evidence items, cited claims, traits and live-source outcomes (database foreign keys make a citation to missing evidence impossible, RES-5). A fresh one (`CACHE_REVIEWS_TTL_DAYS`, 30 days) is reused by later analyses of the book, with no source or model asked again. One built while a source failed or was empty expires when that outcome does (10 minutes, 24 hours), so it is rebuilt then. Two simultaneous first analyses of a book may still both build one; sharing a single build is PERF-2 (BE-9).
- **Sources:** the dataset counts as a source (its stored reviews and Goodreads' rating summary); a read error makes it `failed` like any other. The live sources come from BE-5 (D-020). Every source failing is `SOURCES_UNAVAILABLE`: the analysis fails with retry, never "no reviews" (RES-4). The list of sources asked, with outcomes, is stored with the public analysis.
- **Evidence state and public confidence in code** (`evidence-confidence.ts`): insufficient with no usable review text; limited below `EVIDENCE_SUFFICIENT_REVIEWS` (10) or when any source failed; otherwise sufficient. Confidence starts at high for `PUBLIC_CONFIDENCE_HIGH_REVIEWS` (40) reviews with text, medium for 10, else low; it drops one level per failed source and is capped at medium when only praise or only complaints are present. Reasons are plain sentences. No number is stored or sent (D-010).
- **Written summary** (`public-summary.ts`, prompt `summary-v1`, `GEMINI_SUMMARY_MODEL`, the small model by default): 2 to 4 sentences plus up to 5 praises and 5 complaints, each citing review numbers. Reviews are delimited and tag-like text in them is neutralised (RES-6); citations are checked in code, the description may not be cited as a reader's view, and invalid output is retried once, then the step fails with `INVALID_MODEL_OUTPUT`. With no usable reviews the summary step is done without a model call and no summary exists (RES-3).
- **Step errors:** a used-up model quota is `LLM_QUOTA_EXHAUSTED`; a refusal is `INVALID_MODEL_OUTPUT`; other model or server failures are `INTERNAL_ERROR`. All are retryable.
- **Overall status** (`finalize`, always runs): `failed` when any public step failed; `partial` when evidence is limited or insufficient or the personal match failed; otherwise `complete`.
- **Personal match until BE-13** (owner's choice of the "not available yet" option): no profile or no rated books is `needs_taste_data`; fewer than `TASTE_HARD_FLOOR` rated books is `below_floor` (MODEL-4); otherwise the step fails with the new code `MODEL_UNAVAILABLE` (503 in CONTRACT 2, used only as a step `errorCode`). The public reception is unaffected (RES-7) and the analysis is `partial`. `canRetry` is false for it until a model can score (`PersonalScorer.available()`), and BE-13 replaces the `NoModelScorer` provider. No B0 placeholder score is shown, because B0 has no evaluation numbers yet and would mostly repeat the public rating.
- **Recalculate** makes a new analysis for the current profile version (`409` when it already uses it) and reuses the fresh public analysis. **History** pages by creation time and ID; an unreadable cursor or limit falls back to the default. Starting, retrying and recalculating share `RATE_LIMIT_ANALYSES_PER_HOUR` per reader.
Measured (2026-10-21, dev catalog, real Gemini, Open Library and Hardcover, free tier): Harry Potter and the Sorcerer's Stone complete in 21 s (two model calls, about 9,000 input tokens each, 13 s of model time); Twilight partial in 54 s (Open Library timed out after 8 s; 25 s spent waiting under the free-tier token cap after the previous book). Both summaries were balanced and every citation resolved. That is above the spec's 10 to 15 s cold target; two runs are not a measurement of p50 and p95 (H4, BE-11).
Consequences:
- FE-5 shows `MODEL_UNAVAILABLE` as "personal matching is not available yet" and offers no retry; FE-4's `startAnalysis` can now use the typed client.
- BE-9: share one public build between simultaneous requests (PERF-2), a lock if several API processes run, and cold-latency work (for example running traits and summary together, or a smaller evidence set).
- BE-11: the pipeline already logs one line per step (duration, status, error code) and per model call (tokens, latency).
- BE-13: provide a `PersonalScorer` that scores and writes the explanation rows; the view then fills model, version, confidence and explanations.
- `personal_analyses.not_factored_in` stays unused (D-019).
