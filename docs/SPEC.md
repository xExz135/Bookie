# Book Verdict v2: Lean Specification with Evaluation Core

> **Source of truth for the Bookie team.** Converted from `Book_Verdict_v2_Lean_Specification_with_Evaluation_Core.docx` so Claude Code can read it. Section numbers were rebuilt from the Word numbering (15 sections), heading typos were fixed, and the content is otherwise unchanged. If this file and the .docx ever differ, the .docx is the original: fix this file in the same pull request. Open conflicts inside the spec are tracked in `docs/DECISIONS.md`.
>
> **Decision notes.** Where a DECIDED entry in `docs/DECISIONS.md` overrides a line below, the original line is kept and a "Decision note" is added under it. Follow the note.

A revision of the original specification. It trims the product to what can be built and demoed in a few weeks, and adds a learned personalization model whose quality is measured against baselines.

## 1. Purpose and what changed

Book Verdict helps a reader decide whether to read a book. The reader identifies a book by typing a title or photographing its cover. The app shows what reviewers say (public reception) and how well the book fits this reader's taste (personal match). The personal match comes from a model that is evaluated against baselines, not from a questionnaire alone.

The changes from v1 to v2 are:

| Area | v1 | v2 |
| --- | --- | --- |
| Personalization | Questionnaire compared trait by trait | Taste model learned from the reader's rated books, compared with baselines |
| Cold start | Required questionnaire | Rate or import a few books; questionnaire is an optional prior |
| Other users | Not used | Ratings and feedback feed a collaborative signal |
| Quality measurement | Behavioral acceptance tests only | Offline metrics, a user study, and labeled-set evaluation of the LLM steps |
| Authentication | Full custom system | Managed auth provider or magic link |
| Scope | Every requirement mandatory | Core scope plus an explicit deferred list |
| Data source | Assumed live review sources | Public datasets first; live sources only where terms allow |

**Scope rule:** everything in section 3 is mandatory for v2. Everything in section 14 is deferred on purpose.

**Parameter rule:** numeric values (thresholds, quotas, targets, sample sizes) are configurable defaults or hypotheses to be measured. They are not verified figures.

### Owner decisions

These are the owner's own decisions, written into the original file. Where they conflict with later sections, see docs/DECISIONS.md (D-001, D-002).

This app provides/has/follows these settings:

1. Personalization. It exists in two forms: a questionnaire and a taste model. Before the user is allowed to use the app, it is asked to build a questionnaire. This is done in order to get to know the reader’s trait. The taste model, however, is learned from the reader’s rated books, compared with baselines.

2. To improve the model even better, it will gather information from shared/public ratings and feedback, either from other websites (StoryGraph, Google Books, Open Library, Library Thing, and HardCover) or from the app itself. The book also gets its reviews from Public dataset like the UCSD goodreads dataset or LibraryThing data to build its initial database. Here, I use Goodreads Book Graph Datasets, specifically Complete book reviews (~15m multilingual reviews about ~2m books and 465k users): goodreads_reviews_dedup.json.gz

3. To measure its quality, it will rely on offline metrics / statistics and a specialized AI testing method where a golden dataset (a “labeled set” of human-verified data) is used to test the LLM. The system compares the LLM’s generated book summaries or sentiment analyses against this verified data to score its accuracy, tone, and reliability

4. The authentication is fully customed. The development team will write all the security code. They will build the databases to store passwords, manage the password reset emails, and handle the data encryption. Managed auth provider is not used to due to its subscription

> **Decision notes.**
> - Item 1: the questionnaire is **optional**. Readers may skip onboarding (D-002). Its fields are fixed in D-011.
> - Item 2: StoryGraph, Google Books, Open Library, LibraryThing and Hardcover are used only after the audit in `docs/DATA_SOURCES.md` (D-003, open). The Goodreads datasets are used for academic, non-commercial purposes only (D-004).
> - Item 4: custom email and password is confirmed (D-001). Email verification, lockout and token-family rotation stay deferred (section 14).

## 2. Goals and success hypotheses

Product goal: a reader can scan or type a book and within seconds see an honest public summary and a personal match with reasons.

Evaluation goal: every claim the project makes about quality is backed by a number, a baseline, and a described method. Results are reported even when they are unfavorable.

| ID | Hypothesis (to be tested, not assumed) |
| --- | --- |
| H1 | The learned taste model predicts a reader's held-out ratings better than the global average rating baseline. |
| H2 | LLM trait extraction reaches a useful accuracy against a hand-labeled set, and a smaller model is close enough to a larger one to justify the cost difference. |
| H3 | Most claims in generated summaries are supported by the review they cite. |
| H4 | Cold analysis latency and cost per analysis are measured and reported (p50 and p95). |
| H5 | Adding collaborative signal improves on the content-only model once enough users exist. |

## 3. Mandatory scope

- Sign-in through a managed provider or magic link

  > **Decision note:** replaced by custom email and password sign-in (D-001).

- Taste capture by rating or importing books (questionnaire optional)

- Book discovery by typed search and cover scan, with edition confirmation

- Public verdict with cited evidence and code-computed evidence confidence

- Personal match from the learned model, with reasons and evidence confidence

- Feedback (Accurate / Not for me) stored as labeled data

- Result history with timestamps and model version

- Reading list ranked by personal match, and a two-book comparison

- Caching, idempotent analyses, and partial-failure handling

- The evaluation plan in section 9, with results published in the README

## 4. Definitions

- **Work and edition:** a work is the book as a creative piece. An edition is a specific publication. Reviews for one edition are not assumed to apply to another.

- **Public reception:** what reviewers say, with ratings. Identical for every user.

- **Preference match:** a model-produced estimate of how well this book fits this reader's demonstrated taste. It is shown on a rating-like scale and is never presented as a probability of enjoyment.

- **Evidence confidence:** how reliable an assessment is. For public reception it depends on review count, source variety, and text versus rating-only data. For the personal match it depends on how many books the reader has rated and how much text exists for the book. Computed by code, never by the language model.

- **The three signals** (public reception, preference match, evidence confidence) are never merged into one number.

- **Taste profile:** the reader's ratings, optional questionnaire answers, and the derived taste vector. Each save creates an immutable version.

- **Analysis:** one request to analyze one edition for one user, made of independently tracked steps.

- **Source outcome:** the result of querying one source: ok, empty, failed, rate_limited, or not_permitted.

## 5. Data strategy

The project depends on data it is allowed to use, so this is decided first.

- Uses public interaction dataset as previously mentioned

- Live review sources. Before integrating one, record whether it provides review text, what authentication and limits apply, and whether its terms allow storing and redisplaying content (storage_allowed, display_allowed). Availability of any given source must be verified, not assumed. A source that is not permitted is excluded or limited to derived data

- Book metadata and covers come from open metadata sources, with the same terms check. Here, I use UCSD Goodreads Book Graph’s Detailed book graph (Meta-Data of Books Detailed book graph (~2gb, about 2.3m books): goodreads_books.json.gz)

- If no live source allows review text, the app runs on dataset reviews and apps (StoryGraph, Google Books, Open Library, Library Thing, and HardCover)

- Readers can import their own ratings from an exported file of the kind major reading sites let them download. Imported files are parsed in memory and only the ratings are kept.

## 6. User journeys

### Taste capture (onboarding)

#### Process

- After signing in, the reader chooses **Import ratings** (upload an export file), **Quick rate** (pick books they have read from a searchable list and rate them 1 to 5), or **Skip for now**.

- A progress indicator shows how many rated books are needed for a confident match (default 10) and what the reader gets at fewer.

- The questionnaire (liked genres, preferred pace, themes to avoid) remains available as an optional prior and is stored as unknown when unanswered. Unknown is never treated as a dislike.

#### System behavior

- Every save creates a new immutable taste-profile version.

- Matching book titles in imported files to catalog editions uses the same confirmation rules as search. Unmatched rows are listed, not silently dropped.

- A reader with fewer than the minimum rated books still gets public results and a personal match marked low confidence, or no personal match below a hard floor (default 3).

#### Acceptance criteria

- ONB-1: importing a valid file creates a profile version with the correct matched count and lists unmatched rows.

- ONB-2: skipping onboarding leads to public results plus a card inviting the reader to rate books.

- ONB-3: unknown questionnaire answers never affect the score, verified by test.

- ONB-4: editing ratings creates a new version, leaves old versions unchanged, and marks earlier results outdated.

### Discovery: typed search and cover scan

#### Process

- The reader types a title or author, or photographs the front cover.

- The app shows up to three candidates with cover, title, author, year, and edition or language.

- The reader confirms one, which starts an analysis.

#### System behavior

- Queries are normalized and fuzzy-matched against stored books first, then external metadata.

- For scans, the client resizes the image (default 1024 px, JPEG). The server validates type and size, applies a per-user quota, processes the image in memory, and stores no photo.

- Identification returns whether it is a book, a title, an author, and a confidence value. Below the threshold the result is treated as uncertain.

- The app never auto-selects when more than one plausible match exists.

#### Failure behavior

- Not a book or unreadable: dismissed with a prompt to type the title.

- Uncertain: show the top candidates and ask the reader to confirm.

- Identification service down or quota reached: say so, and typed search still works.

#### Acceptance criteria

- DISC-1: ambiguous queries show candidate cards with all available identifying fields.

- DISC-2: an uncertain scan always ends on the confirmation screen.

- DISC-3: no image file exists in storage after a scan completes.

- DISC-4: oversized or wrong-type uploads are rejected before processing.

- DISC-5: the result names the edition it analyzed.

### Result screen

Shows cover, edition, summary, common praises and complaints, ratings with sources, and public evidence confidence. For readers with a taste profile it also shows the personal match with its own evidence confidence, the model version used, why it matches (books the reader rated that are most similar, and aligned traits), possible mismatches, and traits that were not factored in. The UI states that the match reflects similarity to the reader's taste and is not a probability of enjoyment.

> **Decision note:** no combined verdict label, no percentages, match shown as a 1 to 5 rating (D-007, D-010).

### Feedback

The reader can mark the public reception and the personal match separately as **Accurate** or **Not for me**, and can change the choice later. Feedback is stored with the analysis, taste-profile version, and model version as labeled data. It is hidden on sections that failed or were not generated.

- FB-1: feedback is saved against the correct analysis and versions and can be changed.

- FB-2: one user cannot submit feedback on another user's analysis.

### Reading list and comparison

- **Reading list:** the reader saves books and sees them ranked by personal match, with confidence shown.

- **Compare:** two analyzed books are shown side by side for the same reader, including match, public reception, and the main differences in traits.

- LIST-1: the list order matches the stored match scores and updates only when a new analysis is generated.

- LIST-2: books with low or no personal match are labeled, not ranked as if confident.

## 7. Personalization model

**Inputs:** the reader's ratings (1 to 5), the optional questionnaire as a soft prior, and each book's representation.

**Book representation:** a sentence-embedding of the description and selected review text, plus LLM-extracted traits (pace, tone, themes, content intensity), each stored with the supporting evidence.

#### Models, always evaluated side by side

| ID | Model | Purpose |
| --- | --- | --- |
| B0 | Global average rating | Baseline every other model must beat |
| B1 | Questionnaire and trait match (the v1 method) | Shows whether learning adds value |
| B2 | Taste vector: weighted combination of embeddings of liked and disliked books, scored by cosine similarity and mapped to the rating scale by a fitted regression | Content-based model |
| B3 | Collaborative model (item-based or matrix factorization) trained on dataset interactions and applied to the reader's imported ratings | Uses other readers' behavior |
| B4 | Hybrid of B2 and B3, blend weights tuned on a validation split | Candidate shipped model |

The shipped model is the best on the validation metric. Each analysis records which model produced the score.

**Cold start:** below the minimum rated books, the app falls back to B1 or B0, labels the result accordingly, and shows low evidence confidence.

**Explanations** come from the model, not from free text: the most similar books the reader rated, and the traits that aligned or conflicted, each linked to evidence.

**Calibration check:** predicted scores are binned and compared with actual ratings, and the reliability plot is published.

- MODEL-1: with identical inputs and model version, the score is reproducible.

- MODEL-2: unknown preferences never contribute to the score.

- MODEL-3: the stored result records model version, profile version, and generation time.

- MODEL-4: below the hard floor of rated books, no personal match is shown.

## 8. Public verdict pipeline

**Steps** (each with its own status of pending, running, done, failed, or skipped)

- Resolve the edition and load metadata, cover, and description.

- Fetch reviews and ratings from every permitted source in parallel, each with a timeout.

- Select a bounded evidence set (default maximum 75 reviews): deduplicate, filter language and length, apply per-source limits, balance positive and negative, truncate.

- Extract traits with evidence.

- Generate the public summary.

- Compute evidence confidence in code.

- Compute the personal match when a usable taste profile exists.

- Finalize the overall status.

#### Rules

- Review text sent to the language model is untrusted data. It is delimited, and instructions inside it are ignored.

- Output must match a schema. Each claim cites the evidence supporting it, and the system verifies the citations exist. Invalid output is retried once, then the step is marked failed.

- A source failure is never treated as evidence that no criticism exists.

- Where terms do not allow storing review text, only derived data is stored and shown.

| Evidence state | Condition | Result status |
| --- | --- | --- |
| Sufficient | Enough usable reviews | Complete |
| Limited | Few usable reviews, or some sources failed | Partial, with a limited-evidence warning |
| Insufficient | Sources responded, no usable reviews | Partial, no written verdict |
| Unavailable | All sources failed | Failed, with retry |

- RES-1: closing the browser mid-analysis does not cancel it; the result appears in History.

- RES-2: each step's status is visible in the API response, and a failed step retries without repeating completed steps.

- RES-3: with zero usable reviews, no written verdict is generated.

- RES-4: with all sources failed, status is failed, not insufficient.

- RES-5: every cited evidence reference resolves to real data.

- RES-6: a review containing instructions does not change output format or rules, verified by test.

- RES-7: a personal failure never removes the public verdict.

## 9. Evaluation plan

This section is what turns the app into an experiment. Every item produces a number that is published in the README, including unfavorable ones.

### Offline recommender evaluation

- **Data:** a public interaction dataset, filtered to readers with at least 20 ratings (adjustable).

- **Split:** per-reader holdout (default 20% of each reader's ratings), with a separate validation split for tuning the hybrid blend.

- **Metrics:** mean per-reader Spearman correlation between predicted and actual ratings, NDCG10 on ranking liked books above disliked, and MAE.

- **Baselines:** B0 through B4 from section 7.

- **Uncertainty:** bootstrap confidence intervals over readers.

- **Learning curve:** performance with 5, 10, 20, and 40 rated books, which also justifies the cold-start threshold.

- **Ablations:** embeddings only, traits only, with and without the questionnaire prior.

### User study

- **Target:** about 30 readers (adjustable; report the real number).

- **Procedure:** each reader imports or rates at least 15 books they have read. Five are held out. The app predicts them. Compare against B0 on the held-out ratings.

- **Also report:** the share of Accurate versus Not for me feedback on live results.

- **Honesty rule:** with a small sample, report confidence intervals and avoid strong claims.

### LLM trait extraction

- **Labeled set:** about 50 books labeled by hand for pace, tone, themes, and content intensity, ideally by two labelers with agreement reported.

- **Metrics:** accuracy and macro-F1 per trait.

- **Model comparison:** a smaller model versus a larger one on the same set, with accuracy against cost.

### Summary faithfulness

- Sample about 100 generated claims and label each as supported or not supported by its cited review.

- Report the support rate and the rate at which the automated citation check catches unsupported claims.

### Cost and latency

- Measure tokens and cost per analysis, and p50 and p95 latency for cold and cached requests.

- Report cache hit rate and the cost saved by tiered model use.

### Regression suite

- A golden set of about 50 books with expected structured outputs and trait labels.

- Run on every prompt, model, or embedding change. Fail the change when a metric drops beyond a set threshold.

- This suite is designed to plug into the separate LLM regression-detection project.

### Reporting

The README contains one results table (model, metric, value, interval), the learning curve, the calibration plot, the extraction table, the faithfulness rate, the cost and latency table, and a section titled What did not work.

- EVAL-1: the offline harness reproduces every reported number from a single command and fixed seeds.

- EVAL-2: every shipped model has a recorded evaluation on the validation and test splits.

- EVAL-3: the labeled sets and labeling instructions are stored with the repository, subject to license terms.

- EVAL-4: the regression suite runs in continuous integration.

## 10. Caching, cost, and latency

| Data | Reuse policy (default) | Refresh |
| --- | --- | --- |
| Book metadata and cover | 30 to 90 days | On expiry or missing field |
| Reviews and public analysis | About 30 days, tracked as a reviews version | On expiry or user refresh |
| Source failure | 5 to 15 minutes | Retried after expiry; never stored as no reviews |
| Empty source result | About 24 hours | Retried after expiry |
| Personal analysis | Immutable once generated | Recalculation creates a new one |

- Concurrent requests for the same book share one fetch, and a reader's duplicate request joins the in-progress analysis.

- Successful steps are stored individually so retries reuse them.

- Use a small model for extraction and a larger one only where measured evaluation shows it is needed.

- If the language model quota is exhausted, serve cached results and mark affected steps failed with a retry.

- If the cache layer is down, continue from the database.

- **Targets (to be measured):** cold analysis in roughly 10 to 15 seconds, cached results under 1 second.

- PERF-1: a repeat request within the reuse window makes no external review calls.

- PERF-2: ten simultaneous requests for one uncached book cause one set of external calls.

- PERF-3: a failed refresh serves older data labeled with its date.

## 11. Failure handling (condensed)

| Situation | Required behavior |
| --- | --- |
| Some sources fail | Continue with the rest, disclose which failed, lower confidence |
| All sources fail | Failed status with retry, never no reviews |
| No usable reviews | Insufficient-evidence message, no written verdict |
| Personal match fails | Public verdict stays, personal section shows retry |
| Scan unreadable or not a book | Dismiss with typed-search prompt |
| Import file has unmatched rows | List them for confirmation |
| Profile changed | Old results marked outdated, recalculation offered |
| Duplicate requests | Join the in-progress analysis |

## 12. Security, privacy, and accounts (minimal)

- Use a managed authentication provider or magic-link sign-in instead of custom password handling.

  > **Decision note:** replaced by custom email and password with argon2id, hashed tokens and refresh-token rotation (D-001).

- Validate all input on the server, check ownership on every user-owned resource, keep API keys server-side, rate-limit scans and analyses, and render review text as plain text, never HTML.

- Do not store uploaded photos. Parse imported files in memory and keep only the ratings.

- Provide a single delete-my-data action that removes the reader's profile versions, ratings, analyses, and feedback. Log and backup retention rules are documented rather than engineered in v2.

- Structured logs with per-step timings and source outcomes, free of secrets.

- SEC-1: a user can open only their own history and profile.

- SEC-2: no endpoint except sign-in is reachable without authentication.

- SEC-3: delete-my-data removes all rows referencing the reader, outside documented exceptions.

## 13. Completion criteria

A feature is complete only when its behavior works end to end, its acceptance criteria pass, the failure rows that relate to it are implemented, tests cover the logic that is easy to get wrong (import matching, score reproducibility, unknown handling, review selection, citation verification, caching), and its configurable parameters are documented. The evaluation items in section 9 are part of completion, not extras.

## 14. Deferred on purpose

These are cut to protect the evaluation work. Add them only if the app gains real users.

- Custom authentication internals (refresh-token family rotation, lockout logic, email verification flows)

- A full account-deletion workflow with log and backup purge engineering

- PWA install polish and offline mode

- The extended error catalogue and per-source circuit breakers beyond basic timeouts and retries

- Multi-language editions and translation handling beyond showing the edition

- Automatic profile changes from feedback (feedback is used for evaluation first)

## 15. Implementation sequence

Durations are rough estimates to adjust to your available time. The evaluation harness comes before the interface so that model decisions are driven by numbers.

Error handling is built and tested within each stage.

> Note: the original .docx has no stage list under this heading. The proposed order lives in `docs/STATUS.md` until the owner adds one here.
