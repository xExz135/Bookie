-- BE-5 (D-003): Google Books and Hardcover add rating lines next to the
-- dataset reviews. Neither supplies review text. Terms from
-- docs/DATA_SOURCES.md, checked 2026-10-20, test calls 2026-10-21.
INSERT INTO "review_sources"
  ("key", "name", "provides_text", "storage_allowed", "display_allowed", "enabled", "terms_url", "terms_checked_at", "notes")
VALUES
  (
    'google_books',
    'Google Books',
    false, false, true, true,
    'https://developers.google.com/books/terms',
    '2026-10-20T00:00:00Z',
    'D-003: live only. Ratings and metadata fetched per analysis, kept no longer than the HTTP cache header allows (Google APIs terms 5e), shown with Google attribution. Ratings are per volume: only the volume with the edition ISBN is used (D-020).'
  ),
  (
    'hardcover',
    'Hardcover',
    false, true, true, true,
    'https://docs.hardcover.app/api/getting-started/',
    '2026-10-20T00:00:00Z',
    'D-003: derived data only. Average rating and rating count, always labelled as Hardcover data. No review text, no user data, no images, never sent to a language model.'
  )
ON CONFLICT ("key") DO NOTHING;
