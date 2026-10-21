import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'link';

const STYLES: Record<Variant, string> = {
  // DESIGN.md buttons: solid dark primary, outlined secondary, brass text link.
  primary:
    'inline-flex items-center justify-center gap-2 rounded-sm bg-primary px-5 py-3 text-label-lg text-on-primary transition-colors hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-60',
  secondary:
    'inline-flex items-center justify-center gap-2 rounded-sm border border-outline-variant bg-surface-container-lowest px-5 py-3 text-label-lg text-on-surface transition-colors hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-60',
  link: 'text-label-lg text-secondary underline underline-offset-4 hover:text-on-secondary-fixed-variant',
};

export function Button({
  variant = 'primary',
  busy = false,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
      className={`${STYLES[variant]} ${className}`}
    >
      {children}
    </button>
  );
}
