'use client';

import { useEffect, useRef, useState } from 'react';

type CameraState = { kind: 'starting' } | { kind: 'live' } | { kind: 'error'; message: string };

/** Plain-language reason a camera could not start (getUserMedia error names). */
export function cameraErrorMessage(error: unknown): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Allow the camera for this site in your browser, or choose a photo instead.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device. Choose a photo instead.';
    case 'NotReadableError':
      return 'The camera is being used by another app. Close it and try again, or choose a photo instead.';
    default:
      return 'The camera could not start. Choose a photo instead.';
  }
}

/** True when the browser can show a live camera (needs a secure page, such as localhost or HTTPS). */
export function canUseCamera(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

/**
 * Live camera view for the cover scan. The frame is taken only when the
 * reader presses Capture, as it is (no filters or clean-up), and handed on
 * as a JPEG file; it is then resized like any other photo and never kept
 * (DISC-3). The camera is turned off when this closes.
 */
export function CameraCapture({
  onCapture,
  onCancel,
}: {
  onCapture: (file: File) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureRef = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<CameraState>({ kind: 'starting' });

  useEffect(() => {
    // Safe to run twice (Strict Mode): each run stops its own stream.
    let cancelled = false;
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
        audio: false,
      })
      .then(async (media) => {
        stream = media;
        if (cancelled) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = media;
        const video = videoRef.current;
        if (video) {
          video.srcObject = media;
          await video.play().catch(() => undefined);
        }
        setState({ kind: 'live' });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: cameraErrorMessage(error) });
      });
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (state.kind === 'live') captureRef.current?.focus();
  }, [state.kind]);

  const capture = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      setState({ kind: 'error', message: cameraErrorMessage(null) });
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        if (blob) onCapture(new File([blob], 'camera.jpg', { type: 'image/jpeg' }));
        else setState({ kind: 'error', message: cameraErrorMessage(null) });
      },
      'image/jpeg',
      0.92,
    );
  };

  return (
    <div className="flex w-full flex-col items-center gap-3">
      {state.kind === 'error' ? (
        <p role="alert" className="max-w-sm text-body-sm text-error">
          {state.message}
        </p>
      ) : (
        <>
          <video
            ref={videoRef}
            muted
            playsInline
            aria-label="Camera preview"
            className="aspect-[3/4] w-full max-w-xs rounded-sm bg-inverse-surface object-cover"
          />
          <p aria-live="polite" className="text-body-sm text-on-surface-variant">
            {state.kind === 'starting'
              ? 'Starting the camera…'
              : 'Hold the front cover inside the frame, then press Capture.'}
          </p>
        </>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {state.kind !== 'error' && (
          <button
            ref={captureRef}
            type="button"
            onClick={capture}
            disabled={state.kind !== 'live'}
            className="inline-flex items-center justify-center rounded-sm bg-primary px-4 py-2.5 text-label-lg text-on-primary hover:bg-primary-container focus-visible:ring-2 focus-visible:ring-on-surface disabled:opacity-60"
          >
            Capture
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center justify-center rounded-sm border border-outline-variant bg-surface-container-lowest px-4 py-2.5 text-label-lg text-on-surface hover:bg-surface-container-low focus-visible:ring-2 focus-visible:ring-on-surface"
        >
          {state.kind === 'error' ? 'Close camera' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}
