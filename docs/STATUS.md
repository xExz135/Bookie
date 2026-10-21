# Project Status

Update this file at the end of every session. It is how the next session (and the owner) knows where things stand.

**Last updated:** 2026-10-20 (initial) | **Current stage:** 1 | **Spec:** `docs/SPEC.md` | **Contract:** `docs/CONTRACT.md` (draft v0.2)

**Status values:** `todo`, `in progress`, `blocked`, `in review`, `done`. A package is `done` only when its acceptance IDs pass, the related failure rows are implemented and tested, and its parameters are documented (spec section 13).

## Stage plan

The spec says the evaluation harness comes before the interface, so model decisions are driven by numbers. The original file has no stage list, so this is a proposal to confirm.

| Stage | Backend | Frontend |
|---|---|---|
| 1 | BE-1, BE-2, BE-5 (audit) | FE-1 shell with mocked API |
| 2 | BE-4, BE-12, BE-13, BE-14 | FE-1 auth screens, result-screen design |
| 3 | BE-3, BE-6, BE-7 | FE-2, FE-3, FE-4 |
| 4 | BE-8, BE-9 | FE-5, FE-6 |
| 5 | BE-10, BE-11 | FE-7, FE-8, FE-9 |
| 6 | BE-15, BE-16 | FE-10, FE-11 |

## Frontend work packages

| ID | Package | Acceptance IDs | Status | Branch | Notes |
|---|---|---|---|---|---|
| FE-1 | App shell and auth screens | SEC-2 | done | fe-1-auth | Next.js 16 app in `apps/web`: sign in, create account, forgot and reset password, app shell with sign out, protected pages (SEC-2: signed-out readers go to sign in with a safe `?next=`). Access token in memory only; silent refresh on `TOKEN_EXPIRED`, one refresh at a time (shared in the tab, Web Lock across tabs); sign in and out follow across tabs. Typed client generated from `contract/openapi.json`; tests use the contract fixtures through MSW and run in Strict Mode. Design tokens generated from `docs/design/DESIGN.md`. Checked in a real browser (Edge) against the live API: refresh cookie flags, reload, two tabs, reset email from Mailpit, used link refused, old password refused |
| FE-2 | Taste capture (import, quick rate, questionnaire, skip) | ONB-1, ONB-2, ONB-3 | todo | | Skip allowed (D-002); questionnaire fields per D-011 |
| FE-3 | Import review screen (unmatched rows) | ONB-1 | todo | | |
| FE-4 | Discovery (search, scan, confirmation) | DISC-1, DISC-2, DISC-4, DISC-5 | todo | | |
| FE-5 | Result screen | RES-2, RES-7, MODEL-3 | todo | | |
| FE-6 | Feedback controls | FB-1 | todo | | |
| FE-7 | History and outdated results | ONB-4, RES-1 | todo | | |
| FE-8 | Reading list and comparison | LIST-1, LIST-2 | todo | | |
| FE-9 | Settings and delete-my-data | SEC-3 | todo | | |
| FE-10 | User-study flow | Spec 9 (user study) | todo | | |
| FE-11 | Quality pass (states, accessibility, tests) | Spec 13 | todo | | |

## Backend work packages: Platform track

| ID | Package | Acceptance IDs | Status | Branch | Notes |
|---|---|---|---|---|---|
| BE-1 | Foundations (repo, Compose, config, OpenAPI, CI) | n/a | done | main | Monorepo (pnpm), NestJS 12 API with health check, contract error format, typed config with every spec parameter, OpenAPI and `.env.example` generation with CI check, contract-sync tests, GitHub Actions CI. `docker compose up -d` verified 2026-10-20 (all three services healthy). Follow-up: ESLint; Redis in CI when caching arrives (BE-9) |
| BE-2 | Schema v2 | n/a | done | main (via be-2-schema) | Prisma 7 schema and first migration per D-009 (implementation notes there) and D-012. 25 database tests against real PostgreSQL: immutability (ONB-4, MODEL-3), citations (RES-5), no summary without evidence (RES-3), one running analysis per request, delete-a-reader (SEC-3 groundwork), feedback versions (FB-1). CI runs them with a PostgreSQL service |
| BE-3 | Custom authentication | SEC-1, SEC-2 | done | main (via be-3-auth) | Per D-001 and D-016: register, login, refresh (rotation), logout, forgot and reset password, `GET /me`. Global guard closes every route except `/auth/*` and `/health` (SEC-2 test calls every documented operation without a token). Throttling in Redis with an in-memory fallback. New migration: `users.token_version`. Fixtures for every auth outcome in `contract/fixtures/`, checked by a test. Checked live with Mailpit. SEC-1 here covers `GET /me`; each later endpoint with user data adds its own ownership test (BE-7, BE-10) |
| BE-4 | Catalog ingestion (Goodreads datasets) | n/a | done | main (via be-4-catalog-import) | Importer per D-014: streams the five files, bulk-loads with COPY, re-runnable. Sample run 2026-10-20 (5,000 most-rated books): 3,043 authors, 4,861 works, 5,000 editions, 18,098 genre links, 3,724,813 reviews in 17 minutes, 2.9 GB. Full import deferred by the owner (estimate about an hour and 15 GB); run `pnpm --filter @bookie/api import:goodreads` when needed |
| BE-5 | Source audit and adapters | n/a | in progress | | Audit done and D-003 decided 2026-10-20: Open Library, Google Books (live only), Hardcover (ratings only). Next: adapters, plus test calls once `GOOGLE_BOOKS_API_KEY` and `HARDCOVER_API_TOKEN` are in `.env` |
| BE-6 | Search and cover identification | DISC-1 to DISC-5 | done | main (via be-6-search) | Per D-017: `GET /books/search` (trigram catalog search, ISBN lookup, one candidate per work, Open Library fallback that adds books to the catalog, Redis cache of outcomes) and `POST /scan` (memory-only upload, type from bytes, metadata stripped, Gemini reads the cover, code decides identified or uncertain, daily quota in the database, scan given back on service failure). New migration: `open_library` source row. Checked live 2026-10-21: two real covers identified, a plain image rejected as not a book, books missing from the catalog found on Open Library. DISC-1 to DISC-4 tested; DISC-5 covered at the candidate level, the result screen part comes with BE-8. Search speed on the full catalog not measured yet |
| BE-7 | Taste capture API: import, quick rate, versions | ONB-1 to ONB-4 | done | main (via be-7-taste) | Per D-018: profile versions (whole copy per save, per-reader lock, no-op saves skipped), quick rate (`PUT`/`DELETE /ratings/:editionId`, `GET /ratings`, `GET /catalog/search` with `yourRating`), questionnaire with unknowns stored as nothing, onboarding skip, Goodreads and StoryGraph import (matched by Goodreads book id, ISBN, then unique title and author; the rest listed; confirm). New migration: `rating_imports.ignored_rows` and `file_format`. ONB-1, ONB-2 (skip recorded), ONB-3 (stored as unknown) and ONB-4 (new version, old unchanged, `isOutdated`) tested. Still to come elsewhere: ONB-2 invitation card (BE-8), ONB-3 score part (BE-13). Checked live with a Goodreads export on the dev catalog |
| BE-8 | Analysis pipeline | RES-1 to RES-7 | todo | | |
| BE-9 | Caching and reliability | PERF-1 to PERF-3 | todo | | |
| BE-10 | History, feedback, lists, data deletion | FB-1, FB-2, LIST-1, LIST-2, SEC-3 | todo | | |
| BE-11 | Observability (timings, cost, source outcomes) | H4 | todo | | |

## Backend work packages: Personalization and Evaluation track

| ID | Package | Acceptance IDs | Status | Branch | Notes |
|---|---|---|---|---|---|
| BE-12 | Book representation (embeddings, traits with evidence) | RES-5, RES-6 | done | main (via be-12-representation) | Per D-015: Gemini client with pacing and retries, evidence selection, embeddings (gemini-embedding-001, 768 dimensions, HNSW cosine index), trait extraction with fixed vocabularies, citation checks and one retry. Dev run 2026-10-21: 135 popular editions embedded (100 in 6 minutes at the free-tier token cap); neighbours look right (Harry Potter to the other Potter books, Pride and Prejudice to Sense and Sensibility and Jane Eyre). Trait sample, small model: 5 of 5 valid on the first try, about 8,700 input tokens per book, model latency about 2 s. Traits are stored by the public-analysis pipeline (BE-8). Note for BE-13: another edition of the same work can be a book's nearest neighbour (Gone Girl), so exclude same-work editions when recommending |
| BE-13 | Models B0 to B4 | MODEL-1 to MODEL-4 | todo | | Served per D-006 (Python artifacts, TypeScript scoring, parity test) |
| BE-14 | Offline evaluation harness | EVAL-1, EVAL-2 | todo | | |
| BE-15 | LLM evaluation and regression suite | EVAL-3, EVAL-4, H2 to H4 | todo | | |
| BE-16 | Results report for the README | EVAL-1 | todo | | Must include **What did not work** |

## Hypotheses tracker (spec section 2)

| ID | Hypothesis | Measured? | Result | Interval |
|---|---|---|---|---|
| H1 | Taste model beats the global-average baseline on held-out ratings | no | | |
| H2 | LLM trait extraction is useful against the hand-labeled set; the smaller model is close enough | no | | |
| H3 | Most claims in summaries are supported by the cited review | no | | |
| H4 | Cold latency and cost per analysis measured (p50, p95) | no | | |
| H5 | Collaborative signal improves the content-only model once enough users exist | no | | |

Record results as they are, including unfavorable ones.

## Blockers and risks

| # | Item | Owner | Since | Next step |
|---|---|---|---|---|
| 1 | D-003 (live sources) still open; waits for the audit | Backend | 2026-10-20 | Complete `docs/DATA_SOURCES.md` |
| 2 | Live sources may not offer usable review text | Backend | 2026-10-20 | Complete `docs/DATA_SOURCES.md` |
| 3 | Dataset terms say academic use only; Bookie is a non-commercial portfolio project (owner accepted, D-004) | Owner | 2026-10-20 | Revisit before any public deployment; optionally ask the dataset authors |
| 4 | Dataset files are large (reviews about 5 GB, books about 2 GB) | Backend | 2026-10-20 | BE-4: stream-parse; load a filtered subset first |
| 5 | Imported rows (title, author, rating) are kept after an import is confirmed; D-009 says raw rows are deleted on confirm | Backend | 2026-10-21 | BE-7 follow-up: delete the rows in the confirm transaction (or record why they stay in D-018) |

## Session log (newest first)

| Date | Role and package | What changed | Left for next session |
|---|---|---|---|
| 2026-10-21 | Frontend, FE-1 | Web app set up (Next.js, Tailwind tokens from DESIGN.md, typed API client, Vitest and MSW with contract fixtures). Auth screens and session handling per D-001, D-016 and CONTRACT 4.1; SEC-2 redirect. Browser check found the reset page lost its token when React ran its effect twice in development; fixed, and tests now render in Strict Mode. No contract changes | Owner reviews and merges. Next: agree the `Analysis` object with the result-screen mockup, then FE-2 (taste capture) and FE-4 (search and scan) against the live API, or BE-8 |
| 2026-10-21 | Owner, contract | Approved, for both roles, every pending contract addition: BE-1 (`INTERNAL_ERROR`, `/health`), BE-3 (4.1 session rules, `GET /me`), BE-6 (4.3 candidate fields, `external`, `recognized`), BE-7 (4.2). Recorded in the CONTRACT change log | Frontend: FE-1 (auth screens) can start against the live API; agree the `Analysis` object with the result-screen mockup before BE-8 |
| 2026-10-21 | Backend, BE-7 | Taste capture per D-018: versions, quick rate, questionnaire, onboarding skip, Goodreads and StoryGraph import with matching and confirm, contract fixtures | Owner reviews and merges; frontend approves CONTRACT 4.2; then BE-8 (analysis pipeline) or BE-13 (taste models) |
| 2026-10-21 | Backend, BE-6 | Typed search and cover scan per D-017, Open Library search client and catalog import, image checks, scan quota, contract fixtures | Owner reviews and merges; frontend approves CONTRACT 4.3 additions; then BE-7 (taste capture, reuses this search for import matching) or BE-5 (rating adapters) |
| 2026-10-21 | Backend, BE-3 | Custom authentication per D-001 and D-016, `GET /me`, Redis rate limiter with memory fallback, contract fixtures and their test, Redis in CI. BE-6 was started first and paused: search and scan need sign-in (owner chose BE-3 first) | Owner reviews and merges; frontend approves the CONTRACT 4.1 additions; then BE-6 (search and scan) |
| 2026-10-21 | Backend, BE-12 | Gemini client, evidence selection, book embeddings (new migration: vector(768) plus HNSW index), trait extraction with RES-5 and RES-6 checks, `embed:books` and `traits:sample` tools, D-015 | Owner reviews and merges; then BE-6 (search), BE-5 adapters or BE-13 (taste models) |
| 2026-10-20 | Backend, BE-4 | Goodreads importer with unit and database tests; sample import of the 5,000 most-rated books into the dev database; titles fixed on re-run (series markers) | Owner decides on the full import; then BE-12 (book representation) or BE-6 (search) |
| 2026-10-20 | Backend, BE-2 | Schema v2 with Prisma 7, first migration with constraints, triggers and seed rows, database tests, CI database service. Local dev database reset once with the owner's consent | Owner reviews; then BE-5 (source audit) or BE-4 (catalog import) |
| 2026-10-20 | Backend, BE-1 | Moved docs into `docs/` (design mockups to `docs/design/`, old schema to `docs/reference/`), removed the duplicate Stitch export, set up Git and BE-1 foundations. Contract: added `INTERNAL_ERROR` and the `/health` exception (frontend to approve) | Run `docker compose up -d` once Docker Desktop is open; next package BE-2 (schema v2) or BE-5 (source audit) |
| 2026-10-20 | Setup (D-004) | Owner confirmed non-commercial portfolio project and chose the five dataset files; D-004 decided, BE-4 unblocked | Owner downloads the files to `data/raw/` |
| 2026-10-20 | Setup (decisions) | Decided D-001, D-002, D-006, D-009; D-004 conditional; added D-010 (design rules) and D-011 (questionnaire). Updated SPEC notes, CONTRACT v0.2, role files, DATA_SOURCES | Owner confirms non-commercial use; fix folder layout; Stage 1 |
| 2026-10-20 | Setup | Project files created | Start Stage 1 |
