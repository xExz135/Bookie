'use client';

import { useId, useLayoutEffect, useRef, useState } from 'react';

const CLAMP = { 4: 'line-clamp-4', 6: 'line-clamp-6' } as const;

/**
 * Long text cut to a few lines, with a button to show all of it. The button
 * appears only when the text is actually cut. `forceOpen` shows it in full,
 * for example when a citation link points at it. Plain text only.
 */
export function ExpandableText({
  text,
  lines,
  as: Tag = 'p',
  className = '',
  moreLabel,
  forceOpen = false,
}: {
  text: string;
  lines: keyof typeof CLAMP;
  as?: 'p' | 'blockquote';
  className?: string;
  moreLabel: string;
  forceOpen?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const expanded = open || forceOpen;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !expanded) setCut(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);

  return (
    <div className="flex flex-col items-start gap-1">
      <Tag
        id={id}
        ref={(el: HTMLElement | null) => {
          ref.current = el;
        }}
        className={`${className} ${expanded ? '' : CLAMP[lines]}`}
      >
        {text}
      </Tag>
      {(cut || open) && !forceOpen ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="text-label-md text-secondary underline underline-offset-4 hover:text-on-secondary-fixed-variant"
        >
          {expanded ? 'Show less' : moreLabel}
        </button>
      ) : null}
    </div>
  );
}
