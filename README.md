# Book Verdict (Team Bookie)

Helps a reader decide whether to read a book. They type a title or photograph a cover, and the app shows three separate signals: **public reception** (what reviewers say), a **personal match** from a learned taste model (shown on a 1 to 5 scale, not a probability of enjoyment), and **evidence confidence** for each.

The evaluation results are part of the product. They will be published in this README, including what did not work (spec section 9).

> Status: early development. See `docs/STATUS.md`.

## Getting started

Requirements: Node 22 or later, pnpm 10, Docker Desktop.

```bash
pnpm install
cp .env.example .env          # then fill in the secrets you need
docker compose up -d          # PostgreSQL (with pgvector), Redis, Mailpit
pnpm --filter @bookie/api dev # API on http://localhost:3001 (health: /health)
```

Mailpit shows the emails the app sends at http://localhost:8025.

## Commands

| Command | What it does |
|---|---|
| `pnpm test` | Unit and end-to-end tests |
| `pnpm typecheck` | TypeScript checks in every package |
| `pnpm build` | Builds every package |
| `pnpm generate` | Regenerates `contract/openapi.json` and `.env.example` from the API code |
| `pnpm generate:check` | Fails if those generated files are out of date (runs in CI) |
| `pnpm format` / `pnpm format:check` | Prettier |

## Repository layout

```
apps/api/        NestJS backend
apps/web/        Next.js frontend (not started)
eval/            Python evaluation harness (not started)
contract/        openapi.json (generated) and fixtures/
docs/            SPEC, CONTRACT, STATUS, DECISIONS, DATA_SOURCES, roles/, design/, reference/
data/raw/        Dataset files (git-ignored, never committed)
```

Start with `CLAUDE.md`, then `docs/SPEC.md`.

## Data

Book metadata and reviews come from the UCSD Goodreads Book Graph, used for a non-commercial portfolio project (see `docs/DECISIONS.md`, D-004). The dataset files are not included in this repository and must be downloaded from the dataset page into `data/raw/`.

If you use this data, cite:

- Mengting Wan, Julian McAuley. "Item Recommendation on Monotonic Behavior Chains." RecSys 2018.
- Mengting Wan, Rishabh Misra, Ndapa Nakashole, Julian McAuley. "Fine-Grained Spoiler Detection from Large-Scale Review Corpora." ACL 2019.

## Results

Not measured yet. Every number reported here will have a baseline, a method, a seed and an interval (spec section 9).

### What did not work

Nothing to report yet.
