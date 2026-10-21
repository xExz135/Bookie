/** Where the API runs. The default matches `pnpm --filter @bookie/api dev`. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(
  /\/$/,
  '',
);

/**
 * Cover photos (CONTRACT 4.3, spec 6): the client resizes to this many pixels
 * on the longest side and sends JPEG. The defaults match the API's
 * SCAN_RESIZE_MAX_PX and SCAN_MAX_UPLOAD_BYTES; the API enforces its own
 * limits, these only avoid uploading a file it would refuse.
 */
export const SCAN_MAX_PX = Number(process.env.NEXT_PUBLIC_SCAN_MAX_PX ?? 1024);
export const SCAN_MAX_BYTES = Number(process.env.NEXT_PUBLIC_SCAN_MAX_BYTES ?? 2 * 1024 * 1024);
export const SCAN_JPEG_QUALITY = 0.85;

/** Typed search accepts 2 to 200 characters (CONTRACT 4.3). */
export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 200;

/**
 * Rating imports (CONTRACT 4.2): how often to ask whether matching has
 * finished, and the largest file to send. The API's default limit is 10 MB
 * (IMPORT_MAX_BYTES); it enforces its own, this only avoids a useless upload.
 */
export const IMPORT_POLL_MS = Number(process.env.NEXT_PUBLIC_IMPORT_POLL_MS ?? 1500);
export const IMPORT_MAX_BYTES = Number(
  process.env.NEXT_PUBLIC_IMPORT_MAX_BYTES ?? 10 * 1024 * 1024,
);
