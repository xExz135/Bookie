/** A message box. Errors are announced to screen readers as soon as they appear. */
export function Alert({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'info' | 'success';
  children: React.ReactNode;
}) {
  const styles = {
    error: 'border-error/30 bg-error-container text-on-error-container',
    info: 'border-outline-variant bg-surface-container-low text-on-surface',
    success: 'border-on-tertiary-container/30 bg-tertiary-fixed/40 text-on-tertiary-fixed-variant',
  }[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-sm border px-4 py-3 text-body-md ${styles}`}
    >
      {children}
    </div>
  );
}
