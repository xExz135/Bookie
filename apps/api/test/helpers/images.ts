import { deflateSync } from 'node:zlib';

/** Small, structurally valid images for tests, optionally with metadata. */

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** A structurally valid JPEG with optional EXIF and comment segments. */
export function jpeg({ exif = false, comment = false } = {}): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    ...(exif ? [jpegSegment(0xe1, Buffer.from('Exif\0\0GPS 51.5074 N 0.1278 W', 'latin1'))] : []),
    ...(comment ? [jpegSegment(0xfe, Buffer.from('taken at home', 'latin1'))] : []),
    jpegSegment(0xdb, Buffer.alloc(65)), // Quantisation table.
    jpegSegment(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])), // Frame header.
    jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), // Start of scan.
    Buffer.from([0x12, 0x34, 0xff, 0xd9]), // Image data, end of image.
  ]);
}

function pngChunk(type: string, payload: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), payload, Buffer.alloc(4)]);
}

export function png({ text = false } = {}): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...(text ? [pngChunk('tEXt', Buffer.from('Location\0Home address', 'latin1'))] : []),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 1, 2, 3]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
