'use client';

import { useState } from 'react';
import type { Confidence, Evidence } from '@/lib/analysis/api';
import { CONFIDENCE_LABELS, evidenceLabel } from '@/lib/analysis/labels';

/** A titled card for one part of the result. */
export function Section({
  id,
  title,
  eyebrow,
  children,
  className = '',
}: {
  id: string;
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={`flex min-w-0 flex-col gap-5 rounded-md border border-outline-variant bg-surface-container-lowest p-5 sm:p-6 ${className}`}
    >
      <header className="flex flex-col gap-1">
        {eyebrow ? <p className="text-label-sm uppercase text-secondary">{eyebrow}</p> : null}
        <h2 id={`${id}-title`} className="font-serif text-headline-sm text-on-surface">
          {title}
        </h2>
      </header>
      {children}
    </section>
  );
}

/** A small heading inside a section. */
export function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-label-md uppercase text-on-surface-variant">{children}</h3>;
}

/**
 * Evidence confidence: the level and the API's reasons, nothing else
 * (D-010 point 4). Each side of the result has its own.
 */
export function ConfidenceBlock({ label, confidence }: { label: string; confidence: Confidence }) {
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-outline-variant/70 bg-surface-container-low p-4">
      <p className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-label-md uppercase text-on-surface-variant">{label}</span>
        <span className="text-label-lg text-on-surface">{CONFIDENCE_LABELS[confidence.level]}</span>
      </p>
      {confidence.reasons.length > 0 ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm text-on-surface-variant">
          {confidence.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Links from a claim to the evidence it cites, further down the page
 * (RES-5). IDs that do not resolve are left out rather than shown broken.
 */
export function Citations({
  ids,
  evidence,
}: {
  ids: string[];
  evidence: ReadonlyMap<string, Evidence>;
}) {
  const items = ids.map((id) => evidence.get(id)).filter((e): e is Evidence => !!e);
  if (items.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {items.map((item) => (
        <a
          key={item.id}
          href={`#evidence-${item.number}`}
          className="rounded-sm border border-outline-variant px-1.5 py-0.5 font-mono text-label-sm text-on-surface-variant hover:border-secondary hover:text-secondary"
        >
          {evidenceLabel(item)}
        </a>
      ))}
    </span>
  );
}

/** A cover from an outside site, or a plain tile when there is none or it fails to load. */
export function Cover({
  url,
  title,
  className,
}: {
  url: string | null;
  title: string;
  className: string;
}) {
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      // Covers come from outside sites; a plain img avoids proxying them.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={`Cover of ${title}`}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={`rounded-sm bg-surface-container object-cover ${className}`}
      />
    );
  }
  return (
    <div
      role="img"
      aria-label={`No cover available for ${title}`}
      className={`flex items-center justify-center rounded-sm bg-surface-container px-2 text-center text-label-sm uppercase text-on-surface-variant ${className}`}
    >
      No cover
    </div>
  );
}
