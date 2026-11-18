import { deflateSync } from 'node:zlib';

const PIXELS_PER_MODULE = 8;
const QUIET_ZONE_MODULES = 4;

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

export function qrMatrixToPng(matrix: boolean[][]): Buffer {
  const moduleCount = matrix.length;
  if (!moduleCount || matrix.some((row) => row.length !== moduleCount)) {
    throw new TypeError('La matriz QR debe ser cuadrada y no vacía');
  }

  const quietZone = QUIET_ZONE_MODULES * PIXELS_PER_MODULE;
  const width = (moduleCount + QUIET_ZONE_MODULES * 2) * PIXELS_PER_MODULE;
  const rowLength = 1 + width * 3;
  const raw = Buffer.alloc(rowLength * width, 255);

  for (let y = 0; y < width; y++) {
    const rowOffset = y * rowLength;
    raw[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const moduleY = Math.floor(y / PIXELS_PER_MODULE) - QUIET_ZONE_MODULES;
      const moduleX = Math.floor(x / PIXELS_PER_MODULE) - QUIET_ZONE_MODULES;
      const black =
        moduleX >= 0 &&
        moduleX < moduleCount &&
        moduleY >= 0 &&
        moduleY < moduleCount &&
        matrix[moduleY][moduleX];
      if (black) {
        const pixelOffset = rowOffset + 1 + x * 3;
        raw[pixelOffset] = 0;
        raw[pixelOffset + 1] = 0;
        raw[pixelOffset + 2] = 0;
      }
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(width, 4);
  header[8] = 8;
  header[9] = 2;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
