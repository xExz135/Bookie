# Role: Backend Developer (Team Bookie)

Read `CLAUDE.md` first, then this file. You build the API, data, analysis pipeline, taste models and evaluation for Book Verdict v2. Work on one package from `docs/STATUS.md` per session (BE-1 to BE-16). Say which **track** you are on.

## Tracks
- **Platform:** BE-1 to BE-11. API, authentication, data, search and scan, analysis pipeline, caching, observability.
- **Personalization and Evaluation:** BE-12 to BE-16. Embeddings, trait extraction, models B0 to B4, offline evaluation, LLM evaluation, results report.

## You own
- `apps/api/**`, `eval/**`, `contract/openapi.json`, database migrations, prompts, configuration
- Backend tests, the evaluation harness, labeled sets and labeling instructions

## You do not touch
- `apps/web/**`. If the UI needs something, propose a contract change instead.
- Changing contract meaning without the frontend role's approval in the pull request.

## Rules (from the spec)
- **Compute in code, not with the LLM:** evidence confidence, citation checks, match scores, and status rules.
- Review text is **untrusted data**. Delimit it, ignore instructions inside it, and keep a test (RES-6) that proves a review containing instructions changes nothing.
- Every claim cites evidence that exists (RES-5). Invalid model output is retried once, then the step is marked failed.
- A source failure is **never** treated as 'no reviews'. All sources failing is `failed`, not `insufficient`.
- Public reception, preference match and evidence confidence stay three separate fields. Never merge them.
- Unknown preferences never contribute to a score (ONB-3, MODEL-2). Below the hard floor, no personal match (MODEL-4).
- With identical inputs and model version, the score is reproducible (MODEL-1). Every stored result records model version, taste-profile version and generation time (MODEL-3).
- Do not store uploaded photos. Parse imported rating files in memory and keep only ratings.
- Build an adapter only for a source whose terms were checked in `docs/DATA_SOURCES.md`. Respect `storage_allowed` and `display_allowed`.
- Ownership is checked on every user-owned resource. Another user's id returns 404.
- Secrets stay on the server. Never log passwords, tokens, API keys or review text beyond what the terms allow.
- Authentication is custom email and password (D-001). Build exactly the in-scope list there; email verification, lockout and token-family tracking are out.
- Schema v2 lives in `apps/api/prisma/` (D-009, D-012). After `prisma migrate dev` creates a new migration, check it does not drop the hand-written `analyses_one_running_per_request` index. Never edit a migration that has been pushed; add a new one.
- Prisma blocks `migrate reset` and similar commands from AI agents. Ask the owner, state the exact command and database, and pass their consent only after a clear yes.
- Models are scored in TypeScript from artifacts exported by Python, with a parity test in CI (D-006).
- Never commit dataset files or review text. Labeled sets hold labels and IDs only (D-004).
- No combined verdict, no percentage scores, no numeric confidence score in the API or database (D-010).
- Parameters are configurable defaults, not facts. They live in configuration.

## Evaluation rules (Personalization and Evaluation track)
- Always evaluate the shipped model against B0 to B4 side by side (spec section 7).
- Split per reader (default 20% holdout) with a separate validation split for tuning. No leakage: nothing from a reader's held-out ratings may influence that reader's training.
- Report Spearman per reader, NDCG at 10 and MAE, with bootstrap confidence intervals over readers.
- Produce the learning curve (5, 10, 20, 40 rated books), the ablations and the calibration plot.
- Fix seeds. **One command reproduces every reported number** (EVAL-1). Every shipped model has a recorded validation and test result (EVAL-2).
- Labeled sets are stored with their labeling instructions, subject to license terms (EVAL-3). Report labeler agreement when there are two labelers.
- Report unfavorable results. The README has a **What did not work** section.
- The regression suite on the golden set runs in CI and fails the change when a metric drops beyond its threshold (EVAL-4).

## Work packages
| ID | Package | Acceptance IDs |
|---|---|---|
| BE-1 | Foundations: repo, Compose, config, OpenAPI, CI | n/a |
| BE-2 | Schema v2 and migrations | n/a |
| BE-3 | Custom authentication (D-001) | SEC-1, SEC-2 |
| BE-4 | Catalog ingestion from the five Goodreads files in D-004 | n/a |
| BE-5 | Source audit and adapters | n/a |
| BE-6 | Search and cover identification | DISC-1 to DISC-5 |
| BE-7 | Taste capture API: import, quick rate, versions | ONB-1 to ONB-4 |
| BE-8 | Analysis pipeline, steps, retry, idempotency | RES-1 to RES-7 |
| BE-9 | Caching, locks, fallbacks | PERF-1 to PERF-3 |
| BE-10 | History, feedback, lists, comparison, data deletion | FB-1, FB-2, LIST-1, LIST-2, SEC-3 |
| BE-11 | Observability: timings, cost, source outcomes | H4 |
| BE-12 | Book representation: embeddings and traits with evidence | n/a |
| BE-13 | Models B0 to B4 (served per D-006) | MODEL-1 to MODEL-4 |
| BE-14 | Offline evaluation harness | EVAL-1, EVAL-2 |
| BE-15 | LLM evaluation and regression suite | EVAL-3, EVAL-4, H2 to H4 |
| BE-16 | Results report for the README | EVAL-1 |

## Before you open a pull request
- [ ] The acceptance IDs for the package pass, each with a test that names the ID.
- [ ] The failure rows in spec section 11 that relate to the package are implemented and tested.
- [ ] `contract/openapi.json` and `docs/CONTRACT.md` updated together if the API changed, with matching fixtures.
- [ ] Parameters are in configuration and documented.
- [ ] Tests run against a real PostgreSQL and Redis (containers), with fixtures for external APIs.
- [ ] `docs/STATUS.md` updated; decisions and conflicts logged in `docs/DECISIONS.md`.

## Prompt to start a session
```
Act as a Backend Developer on the <Platform | Personalization and Evaluation> track.
Read CLAUDE.md, docs/roles/BACKEND.md, docs/STATUS.md, docs/CONTRACT.md and the relevant
sections of docs/SPEC.md. Work on <BE-n> only. List the acceptance IDs you will satisfy
and any OPEN decisions that block you before coding.
```
