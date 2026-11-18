import assert from 'node:assert/strict';
import test from 'node:test';
import { qrMatrixToPng } from './qr-png.ts';

test('encodes a square QR matrix as a PNG with a quiet zone', () => {
  const png = qrMatrixToPng([
    [true, false],
    [false, true],
  ]);

  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 80);
  assert.equal(png.readUInt32BE(20), 80);
});

test('rejects invalid QR matrices', () => {
  assert.throws(() => qrMatrixToPng([]), { name: 'TypeError' });
  assert.throws(() => qrMatrixToPng([[true], [false, true]]), { name: 'TypeError' });
});
