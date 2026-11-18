import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { mergeUniquePdfs } from './pdf-merge.ts';

async function createPdf(pageCount: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) pdf.addPage();
  return pdf.save();
}

test('merges pages and excludes repeated identical PDF content', async () => {
  const first = await createPdf(2);
  const second = await createPdf(1);
  const result = await mergeUniquePdfs(
    [
      { fileName: 'first.pdf', bytes: first },
      { fileName: 'first-copy.pdf', bytes: first },
      { fileName: 'second.pdf', bytes: second },
    ],
    'Test bundle',
  );

  const merged = await PDFDocument.load(result.bytes);
  assert.equal(merged.getPageCount(), 3);
  assert.equal(result.pageCount, 3);
  assert.deepEqual(result.includedFileNames, ['first.pdf', 'second.pdf']);
  assert.deepEqual(result.duplicateFileNames, ['first-copy.pdf']);
  assert.equal(merged.getTitle(), 'Test bundle');
});

test('rejects invalid PDFs instead of silently omitting them', async () => {
  await assert.rejects(
    mergeUniquePdfs([{ fileName: 'broken.pdf', bytes: Buffer.from('not a PDF') }], 'Test bundle'),
  );
});
