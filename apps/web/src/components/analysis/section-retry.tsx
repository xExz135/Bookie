import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/** The retry for one section's failed steps (RES-2), with its own error message. */
export function SectionRetry({
  label,
  busy,
  error,
  onRetry,
}: {
  label: string;
  busy: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3">
      <Button variant="secondary" busy={busy} onClick={onRetry}>
        {busy ? 'Starting again…' : label}
      </Button>
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}
