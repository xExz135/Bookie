'use client';

import { useEffect, useState } from 'react';
import type { Evidence, PublicReception } from '@/lib/analysis/api';
import { evidenceLabel, formatCount, formatDate } from '@/lib/analysis/labels';
import { ExpandableText } from './expandable-text';
import { Section } from './parts';

/** The page's `#fragment`, kept up to date, so a cited review can open in full. */
function useHash(): string {
  const [hash, setHash] = useState('');
  useEffect(() => {
    const update = () => setHash(window.location.hash);
    update();
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return hash;
}

/**
 * Every item the result cites, in the order the API sent them, each with the
 * anchor the citation links point to (RES-5). Excerpts are untrusted review
 * text: they are rendered as plain text only.
 */
export function EvidenceList({
  evidence,
  sources,
}: {
  evidence: Evidence[];
  sources: PublicReception['sources'];
}) {
  const sourceNames = new Map(sources.map((s) => [s.key, s.name]));
  const hash = useHash();
  return (
    <Section id="evidence" eyebrow="Citations" title="Cited reviews and sources">
      <ol className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
        {evidence.map((item) => (
          <li
            key={item.id}
            id={`evidence-${item.number}`}
            tabIndex={-1}
            className="flex scroll-mt-24 flex-col gap-2 rounded-sm border border-outline-variant/60 bg-surface-container-low px-4 py-3 target:ring-2 target:ring-secondary"
          >
            <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="font-mono text-label-md text-on-surface">{evidenceLabel(item)}</span>
              {item.rating !== null ? (
                <span className="text-label-md text-on-surface-variant">
                  Rated {item.rating} / 5
                </span>
              ) : null}
            </p>
            <EvidenceText item={item} cited={hash === `#evidence-${item.number}`} />
            <p className="text-body-sm text-on-surface-variant">
              {[
                item.source ? (sourceNames.get(item.source) ?? item.source) : null,
                item.postedAt ? formatDate(item.postedAt) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function EvidenceText({ item, cited }: { item: Evidence; cited: boolean }) {
  if (item.excerpt !== null) {
    return (
      <ExpandableText
        as="blockquote"
        text={item.excerpt}
        lines={4}
        forceOpen={cited}
        moreLabel={
          item.kind === 'description' ? 'Show the full description' : 'Show the full review'
        }
        className="whitespace-pre-line break-words font-serif text-body-md italic text-on-surface"
      />
    );
  }
  if (item.kind === 'source_aggregate') {
    return (
      <p className="text-body-sm text-on-surface-variant">
        Stands for{' '}
        {item.reviewCount !== null ? `${formatCount(item.reviewCount)} reviews` : 'many reviews'} at
        this source.
      </p>
    );
  }
  return (
    <p className="text-body-sm text-on-surface-variant">
      This source does not allow its review text to be shown here.
    </p>
  );
}
