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
