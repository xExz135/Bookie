# Cost and latency (H4)

Window: 2026-10-22T07:05:22.939Z to 2026-10-22T07:23:30.310Z.

Finished analyses: 40 (cold 20, cached 20, shared 0); by status: complete 40. Left out of latency: 0 retried, 0 stale, 0 failed.

## Latency (server time, 95% bootstrap interval)

| Request | n | p50 | p95 |
|---|---|---|---|
| cold | 20 | 11.2 s (8.2 s to 12.8 s) | 14.9 s (13.0 s to 15.7 s) |
| cached | 20 | 0.2 s (0.2 s to 0.3 s) | 1.5 s (0.4 s to 1.6 s) |
| shared | 0 | n/a | n/a |

## Cold analyses in detail

| Part | p50 | p95 |
|---|---|---|
| Model time | 3.2 s (3.0 s to 3.4 s) | 4.0 s (3.7 s to 4.1 s) |
| Pacing wait (free-tier caps) | 4.8 s (2.6 s to 7.3 s) | 9.0 s (7.4 s to 9.9 s) |
| Total without pacing wait | 5.4 s (5.0 s to 5.7 s) | 6.9 s (5.9 s to 10.3 s) |

| Step | n | p50 | p95 |
|---|---|---|---|
| resolve | 20 | 0.0 s | 0.0 s |
| selectReviews | 20 | 0.5 s | 0.6 s |
| evidenceConfidence | 20 | 0.3 s | 0.6 s |
| personalMatch | 20 | 0.1 s | 0.1 s |
| finalize | 20 | 0.0 s | 0.0 s |
| fetchReviews | 20 | 1.4 s | 2.0 s |
| publicSummary | 20 | 5.3 s | 11.7 s |
| extractTraits | 20 | 3.3 s | 10.0 s |

## Tokens and cost per cold analysis (mean, 95% bootstrap interval)

| Measure | Value |
|---|---|
| Cold builds measured | 20 |
| Model calls | 2.00 (2.00 to 2.00) |
| Input tokens | 16,801 (15,901 to 17,685) |
| Output tokens | 802 (771 to 838) |
| Cost at list prices, models used | $0.00704 ($0.00678 to $0.00731) |
| Same tokens at gemini-3.8-flash | $0.01561 ($0.01495 to $0.01627) |
| Saved per analysis by the small model | $0.00856 |

The free tier used for these runs costs nothing; prices are paid-tier list prices.

## Reuse

| Measure | Value |
|---|---|
| Analyses that reused a public reception | 20 of 40 (0.50, 95% interval 0.35 to 0.65) |
| Source answers reused (PERF-1) | 0 of 40 (0.00, 95% interval 0.00 to 0.09) |
| Model outputs reused for unchanged evidence | 0 |
| Public builds avoided | 20 |
| Model calls avoided (estimate) | 40 |

## Model calls

40 calls: ok 40. Invalid output: 0 of 40 (0.00, 95% interval 0.00 to 0.09).

## Sources

| Source | Answers | Reused | Asked | Outcomes | Asked p50 | Asked p95 |
|---|---|---|---|---|---|---|
| hardcover | 20 | 0 | 20 | ok 20 | 1.0 s | 2.0 s |
| open_library | 20 | 0 | 20 | ok 20 | 1.3 s | 1.4 s |

## Method

- Analyses created in the window and finished; latency is server time from the request to the final status (the reader also waits for the first poll).
- Cold: the analysis built the public reception. Cached: it reused a fresh one at once. Shared: it waited for another analysis building the same book (PERF-2).
- Latency leaves out analyses with a retried step (their time includes the reader), stale fallbacks (PERF-3) and failed ones.
- Quantiles interpolate linearly (numpy default). Intervals are 95% percentile bootstrap over analyses, seeded; rates use the Wilson interval.
- Tokens and cost: cold builds that called the model and reused no earlier output; a book with no usable reviews makes only the trait call. Cost uses paid-tier list prices; the free tier used here costs nothing.
- Pacing wait: time our client held requests back for the free-tier per-minute caps; the two model steps run in parallel, so the longer step counts.

Seed 20261022, 1000 bootstrap resamples, shared after 500 ms of waiting.
