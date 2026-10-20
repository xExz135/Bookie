# Data Sources Audit

Complete this **before** building any adapter or storing any source's content (BE-5, spec section 5). Nothing here is assumed: every cell starts as `UNVERIFIED` and is changed only after checking the source's documentation and terms yourself.

## How to audit one source
1. Read the current API documentation and terms of use. Paste the URLs below.
2. Call the real endpoint for the same five books (include one popular, one niche, one non-English, one with several editions, one that does not exist).
3. Record what came back: do you get **review text**, only ratings, or only metadata?
4. Record authentication, rate limits and cost (the project cannot depend on a paid plan).
5. Decide `storage_allowed` and `display_allowed` from the terms, not from what is technically possible.
6. Set the outcome: `use`, `derived data only`, or `exclude`. Log it in `docs/DECISIONS.md` (D-003).

## Live sources

| Source | Returns review text? | Auth | Rate limits | Cost | Terms URL | storage_allowed | display_allowed | Checked on | Outcome |
|---|---|---|---|---|---|---|---|---|---|
| StoryGraph | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | | UNVERIFIED | UNVERIFIED | | |
| Google Books | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | | UNVERIFIED | UNVERIFIED | | |
| Open Library | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | | UNVERIFIED | UNVERIFIED | | |
| LibraryThing | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | | UNVERIFIED | UNVERIFIED | | |
| Hardcover | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | | UNVERIFIED | UNVERIFIED | | |

## Datasets (primary data plan)

| Dataset | File | Content | Size per the spec | Terms | Allowed uses | Checked on |
|---|---|---|---|---|---|---|
| UCSD Goodreads reviews | `goodreads_reviews_dedup.json.gz` | Complete book reviews, multilingual | about 15.7m reviews, about 5 GB compressed (dataset page) | "Academic use only. Please do not redistribute them or use for commercial purposes." Cite RecSys'18 and ACL'19 papers | Bookie is a non-commercial portfolio project, outside the literal "academic" wording; owner accepted this (D-004). Store in the local database: yes. Show excerpts: local and private demos; revisit before public deployment. Commit to repo: no (labels and IDs only). Commercial: no | 2026-10-20 |
| UCSD Goodreads books | `goodreads_books.json.gz` | Detailed book metadata | about 2.3m books, about 2 GB | Same page, same terms | Same as above | 2026-10-20 |
| UCSD Goodreads authors | `goodreads_book_authors.json.gz` | Author names (the books file has only author IDs) | small | Same page, same terms | Same as above | 2026-10-20 |
| UCSD Goodreads works | `goodreads_book_works.json.gz` | Groups editions into works | small | Same page, same terms | Same as above | 2026-10-20 |
| UCSD Goodreads genres | `goodreads_book_genres_initial.json.gz` (the page's link text says "gooreads") | Fuzzy genre labels per book | small | Same page, same terms | Same as above | 2026-10-20 |
| UCSD Goodreads interactions (not used yet) | `goodreads_interactions.csv` + `book_id_map.csv` + `user_id_map.csv` | Ratings without text, for B3 only if needed | about 229m interactions, about 4.1 GB | Same page, same terms | Same as above | 2026-10-20 |

Terms source: https://mcauleylab.ucsd.edu/public_datasets/gdrive/goodreads/UCSD%20Book%20Graph.html (decision D-004).

Questions to answer for each dataset: may it be stored in the project's database? May excerpts be shown to readers? May labeled subsets (EVAL-3) be committed to a public repository? Is commercial use allowed?

## Per-source test log

Record each test call so the audit can be repeated.

| Date | Source | Book tested | Endpoint | Status | Fields returned | Review text present? | Notes |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

## Rules the code must follow after the audit
- The `source_policies` table is filled from this file, not from memory.
- An adapter is built only for a source with outcome `use` or `derived data only`.
- Where `storage_allowed` is false, store only derived data (counts, ratings, analysis output).
- Where `display_allowed` is false, the evidence endpoint returns `excerpt: null`.
- If no live source allows review text, the app runs on dataset reviews (spec section 5).
