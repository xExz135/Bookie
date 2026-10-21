/**
 * Checks an uploaded cover photo in memory (spec 6, DISC-3, DISC-4).
 *
 * - The type comes from the file's bytes, not from the name or the declared
 *   content type. Only JPEG and PNG are accepted (the client sends JPEG).
 * - The file must parse as that format; otherwise it is unreadable.
 * - Metadata is removed before the image goes to the vision model: EXIF and
 *   XMP (which can hold GPS location), comments and text chunks. Pixels are
 *   not touched.
 */
export type ImageCheck =
  | { ok: true; mimeType: 'image/jpeg' | 'image/png'; data: Buffer }
  | { ok: false; reason: 'unsupported_type' | 'unreadable' };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function checkImage(data: Buffer): ImageCheck {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    const cleaned = stripJpegMetadata(data);
    return cleaned ? { ok: true, mimeType: 'image/jpeg', data: cleaned } : unreadable;
  }
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const cleaned = stripPngMetadata(data);
    return cleaned ? { ok: true, mimeType: 'image/png', data: cleaned } : unreadable;
  }
  return { ok: false, reason: 'unsupported_type' };
}

const unreadable: ImageCheck = { ok: false, reason: 'unreadable' };

/**
 * JPEG segments before the image data. Kept: APP0 (JFIF), APP2 (colour
 * profile), APP14 (Adobe colour) and every non-APP segment the decoder needs.
 * Dropped: APP1 (EXIF, XMP), the other APPn segments and comments (COM).
 * Returns null if the structure is broken.
 */
function stripJpegMetadata(data: Buffer): Buffer | null {
  const parts: Buffer[] = [data.subarray(0, 2)]; // SOI
  let offset = 2;
  let sawFrame = false;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1]!;
    if (marker === 0xff) {
      offset++; // Fill byte.
      continue;
    }
    const length = data.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > data.length) return null;
    const segment = data.subarray(offset, offset + 2 + length);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      sawFrame = true;
    }
    if (marker === 0xda) {
      // Start of scan: the rest is image data up to the end marker.
      if (!sawFrame) return null;
      parts.push(data.subarray(offset));
      return Buffer.concat(parts);
    }
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const keep = !isApp || marker === 0xe0 || marker === 0xe2 || marker === 0xee;
    if (keep && marker !== 0xfe) parts.push(segment);
    offset += 2 + length;
  }
  return null;
}

/** PNG chunks that can hold metadata (text, EXIF, time). Everything else is kept. */
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function stripPngMetadata(data: Buffer): Buffer | null {
  const parts: Buffer[] = [PNG_SIGNATURE];
  let offset = 8;
  let first = true;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (!/^[A-Za-z]{4}$/.test(type) || end > data.length) return null;
    if (first && type !== 'IHDR') return null;
    first = false;
    if (!PNG_DROP.has(type)) parts.push(data.subarray(offset, end));
    offset = end;
    if (type === 'IEND') return Buffer.concat(parts);
  }
  return null;
}
