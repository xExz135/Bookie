/**
 * Draws a photo at a smaller size and encodes it as JPEG. Re-encoding also
 * drops the photo's metadata (EXIF, including location) before upload.
 * Browser-only (canvas); tests replace this module.
 */
export async function encodeJpeg(
  file: Blob,
  size: { maxPx: number; quality: number },
): Promise<Blob> {
  // Honours the camera's orientation flag, so portrait photos stay upright.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, size.maxPx);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is not available');
    context.drawImage(bitmap, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the photo'))),
        'image/jpeg',
        size.quality,
      ),
    );
  } finally {
    bitmap.close();
  }
}

/** The size that fits within `maxPx` on the longest side, never enlarged. */
export function fitWithin(
  width: number,
  height: number,
  maxPx: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxPx / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
