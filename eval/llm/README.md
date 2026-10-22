# LLM evaluation set (BE-15, D-028)

What is measured: Bookie's trait extraction and its review summaries (spec 9 "LLM trait extraction" and "Summary faithfulness"), against reference labels from a stronger model. The labels come from a model, not from people: the owner's choice (D-028), so every score here is agreement with that reference.

Files (committed; labels, IDs and model output only, never review text, D-004 and EVAL-3):

| File | What it holds |
|---|---|
| `traits-instructions.md` | The labelling instructions for traits. The reference model gets exactly this text; a person could follow it too. |
| `claims-instructions.md` | The instructions for judging whether cited reviews support a summary claim. |
| `set.json` | The evaluation books: a seeded sample of the most-rated editions with enough review text (edition IDs, Goodreads book IDs, titles), and the books that get a golden summary. |
| `traits/<model>.json` | Each measured model's traits per book, with attempts and token use. |
| `hand-traits.json` | The owner's hand labels per book (D-028 update), imported from the labelling workbook by `pnpm eval label-import`: labels and edition IDs only. When present they are the trait reference, and the reference model is scored against them. |
| `reference-traits.json` | The reference model's labels per book, with the instructions' checksum; the trait reference while there are no hand labels. |
| `claims.json` | A seeded sample of golden-summary claims (model-written text), the dataset IDs of the reviews each cites, and the reference judgement. |
| `manifest.json` | The prompt versions, models and evidence settings that made these files. A test fails when the app's prompts or models no longer match (EVAL-4). |
| `baseline.json` | The accepted headline metrics; CI fails when one drops by more than `[llm.regression] max_drop` (EVAL-4). |

Rebuilding (needs the dev database with the dataset, and a Gemini key):

```
pnpm --filter @bookie/api llm-eval all   # every step, re-runnable; answers are cached in data/derived/llm-eval/
pnpm eval llm                            # metrics to eval/results/llm/
pnpm eval llm --accept                   # make them the baseline (after reviewing them)
pnpm eval llm --check                    # what CI runs
```

Every model sees the same evidence, chosen as the pipeline chooses it (description and up to 75 reviews). The review text is rebuilt from the local dataset copy each time.
