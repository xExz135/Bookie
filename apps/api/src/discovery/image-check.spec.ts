import { jpeg, png } from '../../test/helpers/images';
import { checkImage } from './image-check';

describe('cover image check (DISC-4, DISC-3)', () => {
  it('accepts a JPEG and removes EXIF and comments', () => {
    const result = checkImage(jpeg({ exif: true, comment: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.data.toString('latin1')).not.toContain('GPS');
    expect(result.data.toString('latin1')).not.toContain('taken at home');
    // Same image data as a JPEG that never had metadata.
    expect(result.data.equals(jpeg())).toBe(true);
  });

  it('accepts a PNG and removes text chunks', () => {
    const result = checkImage(png({ text: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mimeType).toBe('image/png');
    expect(result.data.toString('latin1')).not.toContain('Home address');
    expect(result.data.equals(png())).toBe(true);
  });

  it('decides the type from the bytes, not the file name or declared type', () => {
    expect(checkImage(Buffer.from('GIF89a......'))).toEqual({
      ok: false,
      reason: 'unsupported_type',
    });
    expect(checkImage(Buffer.from('%PDF-1.7 pretending to be a cover'))).toEqual({
      ok: false,
      reason: 'unsupported_type',
    });
    expect(checkImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toEqual({
      ok: false,
      reason: 'unsupported_type',
    });
    expect(checkImage(Buffer.alloc(0))).toEqual({ ok: false, reason: 'unsupported_type' });
  });

  it('treats a truncated or broken file as unreadable', () => {
    const fullJpeg = jpeg();
    expect(checkImage(fullJpeg.subarray(0, 30))).toEqual({ ok: false, reason: 'unreadable' });
    expect(checkImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]))).toEqual({
      ok: false,
      reason: 'unreadable',
    });
    const fullPng = png();
    expect(checkImage(fullPng.subarray(0, fullPng.length - 12))).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });
});
