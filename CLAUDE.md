# CLAUDE.md: Book Verdict v2 (Team Bookie)

Read this file first in every session. Keep it short and current.

## What this project is
Book Verdict helps a reader decide whether to read a book. They type a title or photograph a cover. The app shows **public reception** (what reviewers say) and, for readers with enough rated books, a **personal match** from a learned taste model that is evaluated against baselines. The evaluation numbers are part of the product, not an extra.

## Source of truth, in priority order
1. `docs/SPEC.md`: the requirements (converted from the original .docx).
2. `docs/CONTRACT.md` and `contract/openapi.json`: the agreement between frontend and backend.
3. `docs/DECISIONS.md`: choices made after the spec, and open conflicts.
4. `docs/STATUS.md`: what is done, in progress, blocked.
5. The code.

If two of these disagree, **stop and ask the owner**. Do not pick silently. Log the conflict in `docs/DECISIONS.md`.

## Your role
You are working as ONE role per session. Read your role file before anything else:
- Frontend Developer: `docs/roles/FRONTEND.md`
- Backend Developer (Platform or Personalization and Evaluation): `docs/roles/BACKEND.md`

Work on **one work package** per session (IDs like FE-4, BE-8 in `docs/STATUS.md`).

## Session start checklist
1. Read `docs/STATUS.md` and find your work package and its acceptance IDs.
2. Read the matching sections of `docs/SPEC.md` and `docs/CONTRACT.md`.
3. Check `docs/DECISIONS.md` for OPEN items that affect the package. If one blocks you, stop and ask.
4. State which acceptance IDs you intend to satisfy before writing code.

## Session end checklist
1. Tests for the package pass, including the failure cases the spec lists for it.
2. `docs/STATUS.md` updated (status, branch, notes, blockers).
3. Any contract change made in `contract/openapi.json` **and** `docs/CONTRACT.md` in the same pull request.
4. Any new decision or open question logged in `docs/DECISIONS.md`.

## Stack (decided)
- Frontend: Next.js (App Router) + TypeScript strict.
- Backend: NestJS + TypeScript, PostgreSQL, Redis, Gemini for LLM and vision.
- Python only for the offline evaluation harness and models.
- Local environment: Docker Compose.
- Models: trained in Python, exported as versioned artifacts, scored in TypeScript, with a Python/TypeScript parity test (D-006).
- Authentication: custom email and password, no email verification or lockout in v2 (D-001).

## Non-negotiable rules (from the spec)
- Public reception, preference match and evidence confidence are **three separate signals**. Never merge them into one number, in the API or the UI.
- **Evidence confidence, citation checks and match scores are computed in code**, never by the LLM.
- Review text is **untrusted**. Delimit it for the LLM, ignore instructions inside it, render it as plain text only.
- Every claim cites evidence that exists. Invalid model output is retried once, then the step fails.
- A source failure is never evidence that no criticism exists.
- Unknown preferences never affect a score. Below the hard floor of rated books (default 3) no personal match is shown.
- The match is shown on a rating-like scale (1 to 5) and is **not a probability of enjoyment**. No percentages, no combined verdict label (D-010).
- The mockups in `docs/design/` are a **style** reference. Where they disagree with D-010, D-010 wins.
- Goodreads dataset (D-004): non-commercial portfolio use only, files live in `data/raw/` and are never committed, nor is review text. Revisit D-004 before any public deployment.
- Do not store uploaded photos. Parse imported rating files in memory and keep only the ratings.
- Check a source's terms before storing or showing its content (`docs/DATA_SOURCES.md`).
- Parameters (thresholds, quotas, sizes, TTLs) are **configurable defaults, not facts**. Put them in config, not in code.
- Never invent metrics. Every reported number needs a baseline, a method, a seed and an interval. Report unfavorable results too.

## Working agreement
- Small pull requests, one work package per branch (`fe-4-discovery`, `be-8-pipeline`).
- Reference spec IDs (ONB-1, DISC-2, RES-5, MODEL-2, EVAL-1, ...) in tests and commit messages.
- A work package is complete only when behavior works end to end, its acceptance IDs pass, its failure rows are implemented, and its parameters are documented (spec section 13).
- Error handling is built and tested inside each stage, not afterwards.
- Never commit secrets. Use `.env` locally and keep `.env.example` current.
- Do not edit files owned by the other role (see role files). Propose a contract change instead.

## Repository layout
```
apps/api/            NestJS backend (BE-1 foundations done)
apps/web/            Next.js frontend (not started)
eval/                Python evaluation harness, labeled sets, results (not started)
contract/            openapi.json (generated, never edited by hand) and fixtures/
docs/                SPEC, CONTRACT, STATUS, DECISIONS, DATA_SOURCES, roles/, design/ (mockups), reference/ (old v1 schema)
data/raw/            Dataset files: git-ignored, never committed (D-004)
```

## Commands
```
docker compose up -d     # PostgreSQL (pgvector), Redis, Mailpit (mail UI on :8025)
pnpm test                # unit and end-to-end tests
pnpm typecheck           # TypeScript checks
pnpm generate            # regenerate contract/openapi.json and .env.example from the API code
pnpm generate:check      # CI: fail if the generated files are stale
pnpm --filter @bookie/api dev   # API on :3001, health at /health
pnpm --filter @bookie/api db:migrate   # create/apply a migration on the dev database
pnpm --filter @bookie/api db:deploy    # apply migrations (CI and fresh databases)
pnpm eval                # (planned, BE-14) one command reproduces every reported number (EVAL-1)
```

## Technical notes
- NestJS 12 is ESM-only. The API compiles to CommonJS and relies on Node's `require(esm)`; Jest runs with `--experimental-vm-modules` for the same reason. TypeScript is pinned to 5.9 because TypeScript 7 does not yet work with ts-jest and ts-node.
- Settings and tunable parameters live in `apps/api/src/config/params.ts`, each with its default and source. `.env.example` is generated from it.
- Enums and error codes in `apps/api/src/contract/` are tested against `docs/CONTRACT.md` sections 2 and 3. Change both together.
- Database: Prisma 7 (D-012). Schema and migrations in `apps/api/prisma/`. Tests rebuild a separate `bookie_test` database on every run, so `docker compose up -d` must be running for `pnpm test`.
