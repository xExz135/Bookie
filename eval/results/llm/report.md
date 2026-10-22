# LLM evaluation (spec 9: trait extraction and summary faithfulness)

Trait reference: the owner's hand labels (100 of 100 books labelled; D-028), so trait scores are accuracy against a person. The reference model has not labelled every book, so it is not scored. Claims are judged by gemini-3.8-flash.

## Trait extraction (100 books)

| Trait | Metric | gemini-3.5-flash-lite (small) |
|---|---|---|
| pace | accuracy | 0.520 [0.430, 0.620] |
| pace | macroF1 | 0.506 [0.404, 0.603] |
| tone | accuracy | 0.680 [0.580, 0.770] |
| tone | macroF1 | 0.583 [0.445, 0.695] |
| contentIntensity | accuracy | 0.390 [0.300, 0.480] |
| contentIntensity | macroF1 | 0.381 [0.281, 0.475] |
| themes | macroF1 | 0.559 [0.488, 0.605] |
| themes | jaccard | 0.444 [0.406, 0.487] |
| all four | mean macro-F1 | 0.507 [0.454, 0.547] |
|  | cost per book (list price) | $0.00335 |
|  | failed (invalid twice) | 0 |

The large model has not answered every one of these books, so there is no small-versus-large comparison yet (free tier: run `llm-eval traits large` until it has).

## Summary faithfulness

No claims judged yet.

## Method

- Prompt versions: traits traits-v1, summary summary-v1; every model saw the same evidence, chosen as the pipeline chooses it.
- A model's "unknown" or failed answer counts as wrong where the reference knows the trait.
- 95% percentile bootstrap over books, 1000 resamples, seed 20261022; the same resamples for both models.
- Cost: recorded tokens (thinking tokens count as output) at paid-tier list prices from `eval/params.toml`; the free tier costs nothing.
