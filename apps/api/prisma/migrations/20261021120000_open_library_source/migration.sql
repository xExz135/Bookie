-- BE-6 (D-003): Open Library supplies metadata and covers for books the
-- catalog does not have (spec 6), and later ratings (BE-5). It has no review
-- text. Terms from docs/DATA_SOURCES.md, checked 2026-10-20.
INSERT INTO "review_sources"
  ("key", "name", "provides_text", "storage_allowed", "display_allowed", "enabled", "terms_url", "terms_checked_at", "notes")
VALUES (
  'open_library',
  'Open Library',
  false, true, true, true,
  'https://openlibrary.org/developers/api',
  '2026-10-20T00:00:00Z',
  'D-003: metadata, covers and ratings, cached, at most 1 request per second, identified by a User-Agent. No bulk harvesting through the API.'
)
ON CONFLICT ("key") DO NOTHING;
