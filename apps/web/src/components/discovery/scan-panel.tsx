'use client';

import { useId } from 'react';

/**
 * Photo input for the cover scan. "Take a photo" opens the camera on phones;
 * "Choose a photo" opens the file picker. The photo is resized and re-encoded
 * on the device before upload, and the API stores none (DISC-3).
 */
export function ScanPanel({ busy, onPhoto }: { busy: boolean; onPhoto: (file: File) => void }) {
  const cameraId = useId();
  const fileId = useId();
  const pick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared so choosing the same photo again still fires a change.
    event.target.value = '';
    if (file) onPhoto(file);
  };
  const buttonClass = (primary: boolean) =>
    `inline-flex cursor-pointer items-center justify-center rounded-sm px-4 py-2.5 text-label-lg has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-on-surface ${
      primary
        ? 'bg-primary text-on-primary hover:bg-primary-container'
        : 'border border-outline-variant bg-surface-container-lowest text-on-surface hover:bg-surface-container-low'
    } ${busy ? 'pointer-events-none opacity-60' : ''}`;

  return (
    <section
      aria-labelledby={`${cameraId}-heading`}
      className="flex flex-col gap-4 rounded-md border border-outline-variant bg-surface-container-low p-5"
    >
      <h2 id={`${cameraId}-heading`} className="text-label-md uppercase text-on-surface-variant">
        Scan a cover
      </h2>
      <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-outline-variant bg-surface-container-lowest px-4 py-6 text-center">
        <p className="font-serif text-headline-sm text-on-surface">Photograph the front cover</p>
        <p className="max-w-sm text-body-sm text-on-surface-variant">
          We read the title and author from the photo and find the book. The photo is not kept.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <label htmlFor={cameraId} className={buttonClass(true)}>
            Take a photo
            <input
              id={cameraId}
              type="file"
              accept="image/*"
              capture="environment"
              disabled={busy}
              onChange={pick}
              className="sr-only"
            />
          </label>
          <label htmlFor={fileId} className={buttonClass(false)}>
            Choose a photo
            <input
              id={fileId}
              type="file"
              accept="image/jpeg,image/png,image/*"
              disabled={busy}
              onChange={pick}
              className="sr-only"
            />
          </label>
        </div>
      </div>
    </section>
  );
}
