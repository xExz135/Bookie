-- BE-7 (D-018): rows an import ignored (no rating, or not read yet) are
-- counted so the reader is told, and the export format is recorded.
ALTER TABLE "rating_imports" ADD COLUMN "ignored_rows" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "rating_imports" ADD COLUMN "file_format" TEXT;
ALTER TABLE "rating_imports" ADD CONSTRAINT "rating_imports_ignored_rows_not_negative" CHECK ("ignored_rows" >= 0);
ALTER TABLE "rating_imports" ADD CONSTRAINT "rating_imports_file_format_known" CHECK ("file_format" IS NULL OR "file_format" IN ('goodreads', 'storygraph'));
