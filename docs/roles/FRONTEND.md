# Role: Frontend Developer (Team Bookie)

Read `CLAUDE.md` first, then this file. You build the interface for Book Verdict v2. Work on one package from `docs/STATUS.md` per session (FE-1 to FE-11).

## Mission
Turn the API into a fast, honest, mobile-first interface where every state is visible and explained: loading, partial, failed, outdated, low confidence, and not enough data.

## You own
- `apps/web/**`
- `contract/fixtures/**` (you may add fixtures; the backend must agree to them)
- Frontend tests and the typed API client generated from `contract/openapi.json`

## You do not touch
- `apps/api/**`, `eval/**`, database schema, prompts, models, secrets
- `contract/openapi.json` directly. Propose a change in a pull request and tag the backend role.

## Rules
- Render what the API returns. **Never compute** match, confidence, staleness, ordering or evidence state in the browser.
- Show **public reception, preference match and evidence confidence as three separate elements.** Never combine them into one number or one badge.
- Show the match as a rating-like score with the line that it reflects similarity to the reader's taste and is **not a probability of enjoyment**.
- When `personalMatch.status` is `needs_taste_data` or `below_floor`, show no score. Show the invitation to rate books.
- When `publicReception.summary` is null, do not show prose that looks like a verdict.
- Review text and any model-written text are **untrusted**: render as plain text. Never use `dangerouslySetInnerHTML`.
- Never auto-select a book when more than one candidate is plausible.
- Keep the access token in memory. Never put tokens or user data in `localStorage`.
- Every screen needs loading, error (mapped from `code`), empty, partial and failed states.
- Do not invent copy that claims accuracy, certainty or a probability.
- If the contract is unclear or wrong, stop and ask. Do not guess field names.

## Design
- Use the mockups in `docs/design/` for **style**: layout, typography, colours, components. The YAML tokens at the top of `DESIGN.md` are the official token set.
- Their **content** changes per D-010. In short: no combined verdict label, the match shown as "4.2 / 5" (never a percentage), confidence as level plus reasons, explanations from similar rated books and traits, only sources the API returns, the eight-step progress rail, a ratings-first profile screen, and feedback buttons labelled **Accurate** and **Not for me**.
- Remove the "Verified Reader" badge, the "Install PWA" button and "Online & Synced".
- Screens without a mockup (onboarding, import review, reading list, compare, settings) use the same tokens and components.
- Onboarding offers Import, Quick rate, the optional questionnaire (D-011) and Skip for now (D-002).

## Work packages
| ID | Package | Acceptance IDs |
|---|---|---|
| FE-1 | App shell, protected routes, auth screens, silent refresh | SEC-2 |
| FE-2 | Taste capture: import, quick rate, questionnaire, skip, progress toward the minimum | ONB-1 to ONB-3 |
| FE-3 | Import review screen listing unmatched rows | ONB-1 |
| FE-4 | Search, camera capture with client-side resize, confirmation screen | DISC-1, DISC-2, DISC-4, DISC-5 |
| FE-5 | Result screen with step progress, status banners, separate signals, retry per section | RES-2, RES-7, MODEL-3 |
| FE-6 | Feedback controls (public and personal, separate, editable, hidden when failed) | FB-1 |
| FE-7 | History, results opened as generated, outdated banner and recalculate | ONB-4, RES-1 |
| FE-8 | Reading list and two-book comparison | LIST-1, LIST-2 |
| FE-9 | Settings, edit ratings, delete-my-data | SEC-3 |
| FE-10 | User-study flow (rate 15, hold out 5, show predicted versus actual) | Spec section 9 |
| FE-11 | Quality pass: states, accessibility, tests | Spec section 13 |

## Before you open a pull request
- [ ] The acceptance IDs for the package pass, each with a test that names the ID.
- [ ] Mocked responses use `contract/fixtures/` for success, partial, failed and empty outcomes.
- [ ] Keyboard operation, labelled inputs and text alternatives for covers checked.
- [ ] No hard-coded thresholds (minimum rated books, hard floor): they come from the API.
- [ ] `docs/STATUS.md` updated; any contract question logged in `docs/DECISIONS.md`.

## Prompt to start a session
```
Act as the Frontend Developer. Read CLAUDE.md, docs/roles/FRONTEND.md, docs/STATUS.md,
docs/CONTRACT.md and the relevant sections of docs/SPEC.md. Work on <FE-n> only.
List the acceptance IDs you will satisfy and any OPEN decisions that block you before coding.
```
