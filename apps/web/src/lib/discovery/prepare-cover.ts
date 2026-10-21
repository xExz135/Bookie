import { SCAN_JPEG_QUALITY, SCAN_MAX_BYTES, SCAN_MAX_PX } from '@/lib/config';
import { encodeJpeg } from './encode-jpeg';

export type CoverProblem = 'not_image' | 'unreadable' | 'too_large';

/** A photo the browser refused before anything was uploaded (DISC-4). */
export class CoverFileError extends Error {
  constructor(readonly problem: CoverProblem) {
    super(problem);
    this.name = 'CoverFileError';
  }
}

export const COVER_PROBLEM_MESSAGES: Record<CoverProblem, string> = {
  not_image: 'That file is not a photo. Choose a JPEG or PNG photo of the front cover.',
  unreadable: 'We could not open that photo. Try another photo, or type the title instead.',
  too_large: 'That photo is too large, even after resizing. Try another photo.',
};

/**
 * Turns the reader's photo into what the API expects (CONTRACT 4.3): a JPEG
 * at most SCAN_MAX_PX on its longest side and at most SCAN_MAX_BYTES. Files
 * that are not images never leave the device.
 */
export async function prepareCover(file: File): Promise<Blob> {
  // Phones may send HEIC and the like; anything the browser can decode is fine,
  // because it is re-encoded as JPEG. Files that are not images are refused here.
  if (!file.type.startsWith('image/')) throw new CoverFileError('not_image');
  let jpeg: Blob;
  try {
    jpeg = await encodeJpeg(file, { maxPx: SCAN_MAX_PX, quality: SCAN_JPEG_QUALITY });
  } catch {
    throw new CoverFileError('unreadable');
  }
  if (jpeg.size > SCAN_MAX_BYTES) throw new CoverFileError('too_large');
  return jpeg;
}
