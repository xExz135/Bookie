'use client';

import type { Ref } from 'react';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { SEARCH_MAX_LENGTH } from '@/lib/config';

/** Typed search by title, author or ISBN (spec 6). */
export function SearchPanel({
  query,
  busy,
  error,
  inputRef,
  onQueryChange,
  onSearch,
}: {
  query: string;
  busy: boolean;
  error?: string;
  /** Lets the page move focus here, e.g. after a cover could not be read. */
  inputRef?: Ref<HTMLInputElement>;
  onQueryChange: (q: string) => void;
  onSearch: () => void;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-md border border-outline-variant bg-surface-container-lowest p-5">
      <form
        role="search"
        noValidate
        className="flex flex-col gap-3 sm:flex-row sm:items-start"
        onSubmit={(event) => {
          event.preventDefault();
          onSearch();
        }}
      >
        <div className="flex-1">
          <TextField
            ref={inputRef}
            label="Title, author or ISBN"
            type="search"
            name="q"
            autoComplete="off"
            enterKeyHint="search"
            maxLength={SEARCH_MAX_LENGTH}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            error={error}
          />
        </div>
        <Button type="submit" busy={busy} className="sm:mt-[1.375rem]">
          {busy ? 'Searching…' : 'Search'}
        </Button>
      </form>
    </section>
  );
}
