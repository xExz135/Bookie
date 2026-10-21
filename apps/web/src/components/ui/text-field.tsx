import { useId, type ComponentPropsWithRef } from 'react';

/** A labelled input with its error message tied to it for screen readers. */
export function TextField({
  label,
  error,
  hint,
  ...props
}: ComponentPropsWithRef<'input'> & { label: string; error?: string; hint?: string }) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ');
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-label-md uppercase text-on-surface-variant">
        {label}
      </label>
      <input
        id={id}
        {...props}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`rounded-sm border bg-surface-container-lowest px-3 py-2.5 text-body-md text-on-surface outline-none focus:border-transparent focus:ring-[1.5px] focus:ring-on-surface ${
          error ? 'border-error' : 'border-outline-variant'
        }`}
      />
      {hint && !error ? (
        <p id={hintId} className="text-body-sm text-on-surface-variant">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-body-sm text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
