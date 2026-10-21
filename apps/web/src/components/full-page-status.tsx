/** Shown while the session is being restored, so protected content never flashes. */
export function FullPageStatus({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="flex min-h-dvh items-center justify-center">
      <p className="text-body-md text-on-surface-variant">{label}</p>
    </div>
  );
}
