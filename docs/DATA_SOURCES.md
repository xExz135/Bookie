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
| StoryGraph | Not through an official API: StoryGraph "publishes no public API" (Integuru page). Integuru's unofficial API can read reviews | Integuru logs in with **your own** StoryGraph account (2FA handled) | Free plan: 100 calls a month | Free plan $0; production from $499 a month | Integuru: https://www.integuru.com/integrations/the-storygraph. StoryGraph's terms (app.thestorygraph.com/terms-of-service) blocked automated reading (HTTP 403): UNVERIFIED | UNVERIFIED | UNVERIFIED | 2026-10-20 | **exclude** (D-003) |
| Google Books | **No.** `volumeInfo` has `averageRating` (1.0 to 5.0) and `ratingsCount`, plus metadata, an HTML `description`, covers. No field holds other users' review text | API key required in practice: all 5 test calls without a key got HTTP 429 | Not stated in the pages read; check the quota in Google Cloud console once a key exists | Free | Books terms https://developers.google.com/books/terms (2012): no fees to users. Google APIs terms https://developers.google.com/terms (2021) 5e: no "build databases, or otherwise create permanent copies"; no cache "longer than permitted by the cache header"; 6b: show required attribution | **No** (cache only, as long as the HTTP cache header allows) | Yes, with Google's attribution and branding | 2026-10-20 | **use, live only** (D-003): ratings and metadata fetched per analysis, never stored permanently. Test calls still to repeat with a key |
| Open Library | **No.** Metadata, covers, ratings (`/works/{id}/ratings.json`: average, count, 1 to 5 breakdown) and reading-log counts | None for reading | 1 request per second; 3 per second when identified by a User-Agent with contact email. No bulk downloading through the API; use the monthly dumps | Free | API https://openlibrary.org/developers/api; licensing https://openlibrary.org/developers/licensing ("does not assert any new copyright"); Internet Archive terms https://archive.org/about/terms.php. APIs are "not intended to serve as a data backend for third-party services" | Yes for metadata and ratings, with caching (no bulk harvesting through the API) | Yes | 2026-10-20 | **use** (D-003): metadata, covers and ratings, cached, rate-limited |
| LibraryThing | **No** (per the launch post). Talpa is a natural-language search that returns a result count and ISBNs/UPCs | LibraryThing account and token | "Low limits" (developer hub); numbers not published | Not published | Docs https://www.librarything.com/developer/documentation/talpa and developer hub blocked automated reading (HTTP 403); launch post https://blog.librarything.com/2024/08/talpa-api-released/ | UNVERIFIED | UNVERIFIED | 2026-10-20 | **exclude** (D-003): no reviews or ratings, aimed at library vendors |
| Hardcover | Exists in the API, but **not allowed**: "you can't use the API to access and use someone else's data", and public sites "may not use data owned by users" (reviews, ratings). Allowed: aggregates "if it's mentioned to be Hardcover data (ex: number of Hardcover Readers, average Hardcover rating)". Book fields include `rating` (average), `ratings_count`, `ratings_distribution`, `reviews_count` | Personal access token with chosen scopes and expiry (or OAuth for user sign-in). Server-side only. API is in beta: "could break", tokens "may reset without notice" | Free plan: 5,000 requests a day, 60 a minute, burst 10. Each top-level GraphQL field counts as one request | Free (Supporter plan 50,000 a day) | Getting started https://docs.hardcover.app/api/getting-started/ (read from its source, https://github.com/hardcoverapp/hardcover-docs, because the site blocked automated reading). Also: no training of public or commercial LLMs; a DMCA policy is needed if its user-uploaded images are shown publicly | Aggregates yes; review text no | Aggregates yes, labelled as Hardcover data; review text no | 2026-10-20 | **derived data only** (D-003): average rating, rating count and breakdown, labelled "Hardcover". No review text, no user data, no images. Test calls need a token |

**Audit result (2026-10-20):** none of the five audited sources offers usable review text, so the written verdict runs on the dataset reviews (spec section 5). Live sources can add **ratings** as separate rated sources (`ratings[]` in the contract): Open Library now, Google Books once an API key exists, Hardcover once a token exists. Outcomes confirmed by the owner in D-003 on 2026-10-20.

Notes for the adapters:
- Google Books `description` is HTML. Treat it as untrusted and render it as plain text.
- Open Library: send a User-Agent naming the app. Adding a contact email raises the limit to 3 per second; that needs the owner's choice of address.
- A failed or rate-limited live source is recorded as `failed` or `rate_limited`, never as "no reviews" (spec 8).

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
| 2026-10-20 | Google Books | Project Hail Mary (popular) | `GET /books/v1/volumes?q=intitle:..+inauthor:..` (no key) | 429 | none | n/a | Anonymous quota exhausted |
| 2026-10-20 | Google Books | The Employees, Olga Ravn (niche) | same | 429 | none | n/a | |
| 2026-10-20 | Google Books | Cien años de soledad (non-English) | same | 429 | none | n/a | |
| 2026-10-20 | Google Books | Pride and Prejudice (several editions) | same | 429 | none | n/a | |
| 2026-10-20 | Google Books | Zxqv Plorbing Meadows (does not exist) | same | 429 | none | n/a | |
| 2026-10-20 | Open Library | Project Hail Mary (popular) | `GET /search.json?title=..&author=..` | 200 | work OL21745884W, 32 editions, average 4.52 from 184 ratings, cover | No | `ratings.json`: average 4.53, 189 ratings, breakdown 1:1 2:4 3:11 4:51 5:122. `bookshelves.json`: want to read 1115, read 296 |
| 2026-10-20 | Open Library | The Employees, Olga Ravn (niche) | same | 200 | 0 results | No | Niche title not found by title and author |
| 2026-10-20 | Open Library | Cien años de soledad (non-English) | same | 200 | work OL274505W, 208 editions, average 4.10 from 89 ratings, cover | No | |
| 2026-10-20 | Open Library | Pride and Prejudice (several editions) | same | 200 | work OL66554W, 4042 editions, average 4.21 from 409 ratings, cover | No | Ratings are per work, not per edition (set `work_level_only`) |
| 2026-10-20 | Open Library | Zxqv Plorbing Meadows (does not exist) | same | 200 | 0 results | No | Correctly empty |

## Rules the code must follow after the audit
- The `source_policies` table is filled from this file, not from memory.
- An adapter is built only for a source with outcome `use` or `derived data only`.
- Where `storage_allowed` is false, store only derived data (counts, ratings, analysis output).
- Where `display_allowed` is false, the evidence endpoint returns `excerpt: null`.
- If no live source allows review text, the app runs on dataset reviews (spec section 5).
