# Offline evaluation harness (BE-14)

Trains and evaluates the personal-match models B0 to B4 (spec 7) on the Goodreads dataset,
side by side, with intervals (spec 9). One command reproduces every number (EVAL-1), and every
model has a validation and a test result (EVAL-2). Decisions behind it: D-023.

Results: [`results/offline/report.md`](results/offline/report.md) (and `results.json`, the plots).

## Run it

```
pnpm eval:setup     # once: eval/.venv with the pinned packages (Python 3.12)
pnpm eval           # extract the snapshot if there is none, then run (about 2 minutes)
pnpm eval extract   # read the database and the trait cache into a new snapshot
pnpm eval run       # run on the existing snapshot only
pnpm eval:test      # harness tests on synthetic data (also in CI)
pnpm eval export    # run, then export B0 to B4 as a release for the API (D-024)
pnpm eval parity    # rewrite parity/model-parity.json, which the API's parity test scores (D-006)
```

Serving a release: `pnpm eval export`, then `pnpm --filter @bookie/api models:load` loads the
newest release in `data/derived/models/` and ships its chosen model.

The run reads only the **snapshot** in `data/derived/eval/snapshot-top1000/` (git-ignored: it
holds dataset reader IDs, D-004). Its `manifest.json` has a checksum per file, and the run
refuses a snapshot that does not match. With the same snapshot, parameters and code, the
output files are byte-identical (tested). Results name the snapshot checksum and a checksum of
the harness code and `params.toml`.

Building a snapshot needs the dev database with the dataset (`import:goodreads`), embeddings
for the books (`embed:books --limit 1000`) and traits (`traits:extract --limit 1000`, cached
per book in `data/derived/traits/`). Embeddings and traits come from Gemini, so a rebuilt
snapshot can differ slightly; the committed results say which snapshot they used.

## Method

All parameters are in [`params.toml`](params.toml), each with where it comes from.

- **Books:** the 1,000 most-rated editions in the dev catalog (the order `embed:books` uses),
  one edition per work (982 books), so a reader's two editions of one book cannot sit on both
  sides of a split.
- **Readers:** those with at least 20 ratings among these books. 5,000 of them are drawn with
  the seed and evaluated. All other readers form the **population**, the only data B0 and B3
  learn from, so nothing about an evaluated reader reaches training.
- **Split per evaluated reader** (seeded per reader): 20% test, 20% validation, the rest is the
  **profile**: the ratings the model sees, as if the reader had given them to the app. Both
  validation and test are predicted from the profile alone.
- **Tuning** uses validation only: B3's damping, B2's mapping to the scale, B4's blend. The
  tuned models' validation numbers use two-fold cross-fitting over readers, so no model is
  scored on the rows it was fitted on. Final coefficients use all of validation and are
  applied unchanged to test.
- **Choosing the shipped model:** best mean per-reader Spearman on validation, ties broken by
  NDCG (owner's choice). Test is never used to choose.
- **Metrics,** per reader then averaged over readers: Spearman correlation; NDCG@10 with gain
  2^(rating - 1) - 1; MAE in stars with predictions clipped to 1 to 5. Spearman leaves out a
  reader whose held-out ratings are all equal (for every model alike) and is 0 for a model that
  gives all held-out books the same score. Tied predictions get the expected NDCG over every
  order of the tie. 95% percentile bootstrap intervals resample readers (1,000 times); the same
  resamples are used for every model, so differences from B0 are paired.
- **Learning curve:** the profile cut to 5, 10, 20 and 40 ratings (seeded), predicting the same
  test books, for the readers who have that many.
- **Ablations:** embeddings only (B2), traits only (B2 with one-hot trait vectors), and B4 with
  and without the questionnaire prior (B1 added to the blend).
- **Calibration:** the shipped model's test predictions in half-star bins against the actual
  ratings, with the expected calibration error.

## Models

| ID | What it does here |
|---|---|
| B0 | The book's average rating in the population, shrunk toward the global mean |
| B1 | The v1 questionnaire and trait match: reader mean plus fixed-weight matches on genres, pace and themes to avoid. Dataset readers have no questionnaire, so one is **derived from their profile** (D-023); unknown answers and unknown book traits add nothing (MODEL-2) |
| B2 | Taste vector: profile embeddings weighted by rating minus the reader's mean, cosine similarity to the book, mapped to the scale by a regression on validation |
| B3 | Item-based collaborative filtering with baseline correction: population similarities applied to the reader's own ratings, as the API will do for a new reader; the neighbours' average is damped by a constant chosen on validation |
| B4 | Least-squares blend of B2 and B3 on validation |

`parity.py` holds the rules as served (D-024): live B1 uses the reader's real questionnaire, and B3
uses only ratings of books the release knows. The API scores the same fixture in TypeScript and
fails beyond 1e-6.

## Files

```
eval/
  params.toml           every parameter
  requirements.txt      pinned packages
  run.mjs               what pnpm eval runs
  bookie_eval/          snapshot, splits, metrics, models, experiment, report
  tests/                synthetic-data tests (metrics, splits, MODEL-2, no leakage, EVAL-1)
  results/offline/      results.json, report.md, learning-curve.png, calibration.png
```
