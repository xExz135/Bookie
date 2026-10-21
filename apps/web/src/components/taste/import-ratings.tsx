'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiRequestError, errorMessage } from '@/lib/api/errors';
import { IMPORT_MAX_BYTES, IMPORT_POLL_MS } from '@/lib/config';
import {
  confirmImport,
  getImport,
  type ProfileSaved,
  type RatingImport,
  startImport,
} from '@/lib/taste/api';
import { useTasteProfile } from './use-taste';

const FORMAT_NAMES = { goodreads: 'Goodreads', storygraph: 'StoryGraph' } as const;

type Stage =
  | { kind: 'choose' }
  | { kind: 'uploading' }
  | { kind: 'matching'; importId: string; progress: RatingImport | null }
  | { kind: 'review'; data: RatingImport }
  | { kind: 'saved'; data: RatingImport; saved: ProfileSaved }
  | { kind: 'failed' };

/**
 * Import ratings (spec 6, ONB-1): upload a Goodreads or StoryGraph export,
 * wait while the API matches the rows, then see what matched, what was
 * ignored, and every row that did not match before saving. Nothing is
 * dropped without being listed.
 */
export function ImportRatings() {
  const inputId = useId();
  const taste = useTasteProfile();
  const [stage, setStage] = useState<Stage>({ kind: 'choose' });
  const [fileError, setFileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function upload(file: File) {
    setFileError(null);
    if (file.size === 0) {
      setFileError('That file is empty.');
      return;
    }
    if (file.size > IMPORT_MAX_BYTES) {
      setFileError(
        `That file is larger than ${Math.round(IMPORT_MAX_BYTES / (1024 * 1024))} MB. Export only your read books, or split the file.`,
      );
      return;
    }
    setStage({ kind: 'uploading' });
    try {
      const { importId } = await startImport(file);
      setStage({ kind: 'matching', importId, progress: null });
    } catch (e) {
      setFileError(e instanceof ApiRequestError && e.fields.file ? e.fields.file : errorMessage(e));
      setStage({ kind: 'choose' });
    }
  }

  // Ask again until matching is done (CONTRACT 4.2: usually a few seconds).
  useEffect(() => {
    if (stage.kind !== 'matching') return;
    const { importId, progress } = stage;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        getImport(importId).then(
          (data) => {
            if (cancelled) return;
            if (data.status === 'processing')
              setStage({ kind: 'matching', importId, progress: data });
            else if (data.status === 'failed') setStage({ kind: 'failed' });
            else setStage({ kind: 'review', data });
          },
          (e: unknown) => {
            if (cancelled) return;
            setFileError(errorMessage(e));
            setStage({ kind: 'choose' });
          },
        );
      },
      progress ? IMPORT_POLL_MS : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [stage]);

  async function save(data: RatingImport) {
    setSaving(true);
    setSaveError(null);
    try {
      // Every listed row is skipped explicitly, so nothing is dropped silently.
      const saved = await confirmImport(
        data.importId,
        data.unmatched.map((row) => ({ rowIndex: row.rowIndex, skip: true as const })),
      );
      taste.saved(saved);
      setStage({ kind: 'saved', data, saved });
    } catch (e) {
      setSaveError(
        e instanceof ApiRequestError && e.code === 'CONFLICT'
          ? 'This import was already saved.'
          : errorMessage(e),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="import-title" className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link href="/taste" className="text-label-md text-secondary underline underline-offset-4">
          Your taste profile
        </Link>
        <h1
          id="import-title"
          className="font-serif text-headline-lg-mobile text-on-surface sm:text-headline-lg"
        >
          Import ratings
        </h1>
        <p className="text-body-md text-on-surface-variant">
          Upload the CSV export from Goodreads (My Books, then Import and export) or StoryGraph
          (Manage account, then Export). Only each book&rsquo;s title, author and your star rating
          are kept; reviews, notes, shelves and dates are not stored.
        </p>
      </header>

      {stage.kind === 'choose' || stage.kind === 'uploading' ? (
        <div className="flex flex-col items-start gap-3 rounded-md border border-outline-variant bg-surface-container-lowest p-5">
          <label htmlFor={inputId} className="text-label-md uppercase text-on-surface-variant">
            Export file (CSV)
          </label>
          <input
            id={inputId}
            type="file"
            accept=".csv,text/csv"
            disabled={stage.kind === 'uploading'}
            aria-describedby={fileError ? `${inputId}-error` : undefined}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void upload(file);
            }}
            className="text-body-md text-on-surface file:mr-3 file:rounded-sm file:border file:border-outline-variant file:bg-surface-container-low file:px-4 file:py-2 file:text-label-lg file:text-on-surface"
          />
          {stage.kind === 'uploading' ? (
            <p role="status" className="text-body-md text-on-surface-variant">
              Uploading…
            </p>
          ) : null}
          {fileError ? (
            <p id={`${inputId}-error`} role="alert" className="text-body-md text-error">
              {fileError}
            </p>
          ) : null}
        </div>
      ) : null}

      {stage.kind === 'matching' ? (
        <p role="status" className="text-body-md text-on-surface-variant">
          Matching your books to the catalog…
          {stage.progress
            ? ` ${stage.progress.matchedCount} of ${stage.progress.totalRows} rows matched so far.`
            : ''}
        </p>
      ) : null}

      {stage.kind === 'failed' ? (
        <div className="flex flex-col items-start gap-3">
          <Alert>
            Matching this file failed on our side. Nothing was saved. Please upload it again.
          </Alert>
          <Button variant="secondary" onClick={() => setStage({ kind: 'choose' })}>
            Upload again
          </Button>
        </div>
      ) : null}

      {stage.kind === 'review' ? (
        <ImportReview
          data={stage.data}
          saving={saving}
          error={saveError}
          onSave={() => void save(stage.data)}
          onCancel={() => setStage({ kind: 'choose' })}
        />
      ) : null}

      {stage.kind === 'saved' ? (
        <div className="flex flex-col items-start gap-3">
          <Alert tone="success">
            Saved {stage.data.matchedCount} {stage.data.matchedCount === 1 ? 'rating' : 'ratings'}.
            You now have {stage.saved.ratedCount} rated books (taste profile version{' '}
            {stage.saved.tasteProfileVersion}).
          </Alert>
          <div className="flex flex-wrap gap-4">
            <Link
              href="/taste"
              className="text-label-lg text-secondary underline underline-offset-4"
            >
              See your taste profile
            </Link>
            <Link href="/" className="text-label-lg text-secondary underline underline-offset-4">
              Find a book
            </Link>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ImportReview({
  data,
  saving,
  error,
  onSave,
  onCancel,
}: {
  data: RatingImport;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  if (data.status === 'confirmed') {
    return <Alert tone="success">This import was already saved.</Alert>;
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2 rounded-md border border-outline-variant bg-surface-container-lowest p-5">
        <h2 className="font-serif text-headline-sm text-on-surface">
          {data.format ? `${FORMAT_NAMES[data.format]} export` : 'Your export'} is ready
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body-md">
          <dt className="text-on-surface-variant">Rated rows</dt>
          <dd className="text-on-surface">{data.totalRows}</dd>
          <dt className="text-on-surface-variant">Matched to a book</dt>
          <dd className="text-on-surface">{data.matchedCount}</dd>
          <dt className="text-on-surface-variant">Not matched</dt>
          <dd className="text-on-surface">{data.unmatched.length}</dd>
          <dt className="text-on-surface-variant">Ignored, no rating</dt>
          <dd className="text-on-surface">{data.ignoredRows}</dd>
        </dl>
        {data.ignoredRows > 0 ? (
          <p className="text-body-sm text-on-surface-variant">
            Rows without a star rating (for example books on a to-read shelf) are not used.
          </p>
        ) : null}
      </div>

      {data.unmatched.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h2 className="text-label-md uppercase text-on-surface-variant">
            Not matched ({data.unmatched.length})
          </h2>
          <p className="text-body-sm text-on-surface-variant">
            We could not tell which book these rows mean, so they are skipped when you save. You can
            rate them afterwards with Quick rate.
          </p>
          <ul
            aria-label="Rows not matched"
            className="flex flex-col divide-y divide-outline-variant/60 rounded-sm border border-outline-variant/60"
          >
            {data.unmatched.map((row) => (
              <li
                key={row.rowIndex}
                className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5"
              >
                <span className="min-w-0">
                  <span className="text-body-md text-on-surface">{row.rawTitle}</span>
                  {row.rawAuthor ? (
                    <span className="text-body-sm text-on-surface-variant"> · {row.rawAuthor}</span>
                  ) : null}
                </span>
                <span className="text-body-sm text-on-surface-variant">
                  Your rating {row.rating} / 5
                  {row.candidates.length > 0
                    ? ` · ${row.candidates.length} possible ${row.candidates.length === 1 ? 'book' : 'books'}`
                    : ' · no close match'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col items-start gap-3">
        <div className="flex flex-wrap gap-3">
          <Button busy={saving} onClick={onSave} disabled={data.matchedCount === 0}>
            {saving
              ? 'Saving…'
              : `Save ${data.matchedCount} matched ${data.matchedCount === 1 ? 'rating' : 'ratings'}`}
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            Upload a different file
          </Button>
        </div>
        {data.matchedCount === 0 ? (
          <p className="text-body-sm text-on-surface-variant">
            No rows matched a book, so there is nothing to save.
          </p>
        ) : null}
        {error ? <Alert>{error}</Alert> : null}
      </div>
    </div>
  );
}
