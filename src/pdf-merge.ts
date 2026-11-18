import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';

export interface PdfInput {
  fileName: string;
  bytes: Uint8Array;
}

export interface PdfMergeResult {
  bytes: Uint8Array;
  includedFileNames: string[];
  duplicateFileNames: string[];
  pageCount: number;
}

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_MERGED_PDF_BYTES = 100 * 1024 * 1024;

function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function mergeUniquePdfs(inputs: PdfInput[], title: string): Promise<PdfMergeResult> {
  if (!inputs.length) throw new Error('No hay PDFs para unir');
  if (!title.trim()) throw new TypeError('El PDF unido necesita un título');

  const hashes = new Set<string>();
  const includedFileNames: string[] = [];
  const duplicateFileNames: string[] = [];
  const output = await PDFDocument.create();
  output.setTitle(title.trim());
  output.setProducer('wa-cleaner');

  for (const input of inputs) {
    if (!input.bytes.length) throw new Error(`El PDF "${input.fileName}" está vacío`);
    if (input.bytes.length > MAX_PDF_BYTES) {
      throw new Error(`El PDF "${input.fileName}" supera el límite de ${MAX_PDF_BYTES} bytes`);
    }

    const hash = contentHash(input.bytes);
    if (hashes.has(hash)) {
      duplicateFileNames.push(input.fileName);
      continue;
    }

    const source = await PDFDocument.load(input.bytes, { updateMetadata: false });
    const copiedPages = await output.copyPages(source, source.getPageIndices());
    if (!copiedPages.length) throw new Error(`El PDF "${input.fileName}" no contiene páginas`);
    for (const page of copiedPages) output.addPage(page);

    hashes.add(hash);
    includedFileNames.push(input.fileName);
  }

  if (!includedFileNames.length) throw new Error('No hay PDFs únicos válidos para unir');

  const bytes = await output.save({ useObjectStreams: true });
  if (bytes.length > MAX_MERGED_PDF_BYTES) {
    throw new Error(`El PDF unido supera el límite de ${MAX_MERGED_PDF_BYTES} bytes`);
  }

  return {
    bytes,
    includedFileNames,
    duplicateFileNames,
    pageCount: output.getPageCount(),
  };
}
