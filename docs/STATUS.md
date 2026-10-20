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
| FE-1 | App shell and auth screens | SEC-2 | todo | | Auth flows per D-001 and CONTRACT 4.1 |
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
| BE-3 | Custom authentication | SEC-1, SEC-2 | todo | | Scope fixed in D-001 |
| BE-4 | Catalog ingestion (Goodreads datasets) | n/a | todo | | Five files in `data/raw/` per D-004; stream-parse the `.gz` files |
| BE-5 | Source audit and adapters | n/a | in progress | | Audit done and D-003 decided 2026-10-20: Open Library, Google Books (live only), Hardcover (ratings only). Next: adapters, plus test calls once `GOOGLE_BOOKS_API_KEY` and `HARDCOVER_API_TOKEN` are in `.env` |
| BE-6 | Search and cover identification | DISC-1 to DISC-5 | todo | | |
| BE-7 | Taste capture API | ONB-1 to ONB-4 | todo | | |
| BE-8 | Analysis pipeline | RES-1 to RES-7 | todo | | |
| BE-9 | Caching and reliability | PERF-1 to PERF-3 | todo | | |
| BE-10 | History, feedback, lists, data deletion | FB-1, FB-2, LIST-1, LIST-2, SEC-3 | todo | | |
| BE-11 | Observability (timings, cost, source outcomes) | H4 | todo | | |

## Backend work packages: Personalization and Evaluation track

| ID | Package | Acceptance IDs | Status | Branch | Notes |
|---|---|---|---|---|---|
| BE-12 | Book representation (embeddings, traits with evidence) | n/a | todo | | |
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

## Session log (newest first)

| Date | Role and package | What changed | Left for next session |
|---|---|---|---|
| 2026-10-20 | Backend, BE-2 | Schema v2 with Prisma 7, first migration with constraints, triggers and seed rows, database tests, CI database service. Local dev database reset once with the owner's consent | Owner reviews; then BE-5 (source audit) or BE-4 (catalog import) |
| 2026-10-20 | Backend, BE-1 | Moved docs into `docs/` (design mockups to `docs/design/`, old schema to `docs/reference/`), removed the duplicate Stitch export, set up Git and BE-1 foundations. Contract: added `INTERNAL_ERROR` and the `/health` exception (frontend to approve) | Run `docker compose up -d` once Docker Desktop is open; next package BE-2 (schema v2) or BE-5 (source audit) |
| 2026-10-20 | Setup (D-004) | Owner confirmed non-commercial portfolio project and chose the five dataset files; D-004 decided, BE-4 unblocked | Owner downloads the files to `data/raw/` |
| 2026-10-20 | Setup (decisions) | Decided D-001, D-002, D-006, D-009; D-004 conditional; added D-010 (design rules) and D-011 (questionnaire). Updated SPEC notes, CONTRACT v0.2, role files, DATA_SOURCES | Owner confirms non-commercial use; fix folder layout; Stage 1 |
| 2026-10-20 | Setup | Project files created | Start Stage 1 |
