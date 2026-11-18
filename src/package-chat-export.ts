import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { chatAttachmentFileName } from './chat-export.ts';
import { mergeUniquePdfs } from './pdf-merge.ts';
import type { CapturedChatMessage } from './process-captured-chat.ts';
import { formatDate, MAX_MEDIA_BYTES } from './utils.ts';
import { MediaTooLargeError } from './utils.ts';

const execFileAsync = promisify(execFile);

export interface ChatMediaDownload {
  message: CapturedChatMessage;
  bytes?: Buffer;
  error?: string;
}

export interface PackagedChatResult {
  textPath: string;
  zipPath: string;
  mergedPdfPath: string;
  messageCount: number;
  attachmentCount: number;
  pdfCount: number;
  duplicatePdfCount: number;
  nonPdfAttachmentCount: number;
  originalPdfBytes: number;
  mergedPdfBytes: number;
  compressedPdfBytes: number;
  zipBytes: number;
}

function writePrivate(filePath: string, bytes: Uint8Array | string): void {
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function isPdf(message: CapturedChatMessage): boolean {
  const mime = (message.mimetype ?? '').split(';', 1)[0].trim().toLowerCase();
  return mime === 'application/pdf' || /\.pdf$/i.test(message.fileName ?? '');
}

function transcriptText(messages: CapturedChatMessage[], attachmentById: Map<string, ChatMediaDownload>, timeZone: string): string {
  const lines = [
    'Conversación exportada localmente desde el historial disponible de WhatsApp.',
    'Nota: los mensajes sin texto pueden ser medios, eventos o tipos que el extractor actual no interpreta.',
    '',
  ];

  for (const message of messages) {
    const timestamp = message.timestamp ? formatDate(message.timestamp, timeZone) : 'fecha desconocida';
    const author = message.fromMe ? 'Yo' : message.sender || 'Contacto';
    const body = message.text.trim() || (message.kind === 'other' ? '[mensaje sin texto reconocido]' : '');
    const attachment = attachmentById.get(`${message.fromMe ? 1 : 0}|${message.id}`);
    const attachmentDescription = message.hasMedia
      ? attachment?.bytes
        ? `[Adjunto: ${message.fileName || message.kind}; guardado]`
        : `[Adjunto: ${message.fileName || message.kind}; ${attachment?.error ?? 'no descargado'}]`
      : '';
    lines.push(`[${timestamp}] ${author}: ${body || attachmentDescription || `[${message.kind}]`}`);
    if (body && attachmentDescription) lines.push(`  ${attachmentDescription}`);
  }

  return `${lines.join('\n')}\n`;
}

function zipEntryName(message: CapturedChatMessage): string {
  const extension = path.extname(message.fileName ?? '');
  const base = chatAttachmentFileName(message);
  if (extension && !base.toLowerCase().endsWith(extension.toLowerCase())) return `${base}${extension}`;
  return base;
}

export async function packageChatExport(options: {
  messages: CapturedChatMessage[];
  downloads: ChatMediaDownload[];
  outputDir: string;
  title: string;
  timeZone: string;
  ghostscriptPath?: string;
}): Promise<PackagedChatResult> {
  const { messages, downloads, outputDir, title, timeZone } = options;
  if (!messages.length) throw new Error('La conversación no contiene mensajes para exportar');
  const failed = downloads.filter((item) => !item.bytes);
  if (failed.length) {
    throw new Error(`No se puede empaquetar: falló la descarga de ${failed.length} de ${downloads.length} adjuntos`);
  }

  fs.mkdirSync(path.dirname(outputDir), { recursive: true, mode: 0o700 });
  fs.mkdirSync(outputDir, { mode: 0o700 });
  fs.chmodSync(outputDir, 0o700);
  const attachmentsDir = path.join(outputDir, 'source-attachments');
  fs.mkdirSync(attachmentsDir, { mode: 0o700 });
  fs.chmodSync(attachmentsDir, 0o700);

  const attachmentById = new Map<string, ChatMediaDownload>();
  const pdfInputs: { fileName: string; bytes: Uint8Array }[] = [];
  const zipFiles: string[] = [];
  let originalPdfBytes = 0;
  let pdfCount = 0;
  let nonPdfAttachmentCount = 0;
  const seenFileHashes = new Set<string>();

  for (const item of downloads) {
    if (!item.bytes) throw new Error(`Adjunto sin contenido: ${item.message.id}`);
    if (item.bytes.length > MAX_MEDIA_BYTES) {
      throw new MediaTooLargeError(item.bytes.length, MAX_MEDIA_BYTES);
    }

    const identity = `${item.message.fromMe ? 1 : 0}|${item.message.id}`;
    attachmentById.set(identity, item);
    const fileName = zipEntryName(item.message);
    const sourcePath = path.join(attachmentsDir, fileName);
    writePrivate(sourcePath, item.bytes);
    if (isPdf(item.message)) {
      pdfInputs.push({ fileName, bytes: item.bytes });
      originalPdfBytes += item.bytes.length;
      pdfCount++;
    } else {
      const hash = createHash('sha256').update(item.bytes).digest('hex');
      if (seenFileHashes.has(hash)) continue;
      seenFileHashes.add(hash);
      zipFiles.push(sourcePath);
      nonPdfAttachmentCount++;
    }
  }

  if (!pdfInputs.length) throw new Error('No se encontraron PDFs válidos para crear el documento combinado');
  const merged = await mergeUniquePdfs(pdfInputs, title);
  const mergedPdfPath = path.join(outputDir, 'merged-documents.pdf');
  writePrivate(mergedPdfPath, merged.bytes);

  let compressedBytes = merged.bytes;
  let compressedPath = path.join(outputDir, '.merged-documents-compressed.pdf');
  await execFileAsync(options.ghostscriptPath ?? 'gs', [
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.7',
    '-dPDFSETTINGS=/printer',
    '-dNOPAUSE',
    '-dBATCH',
    '-dSAFER',
    `-sOutputFile=${compressedPath}`,
    mergedPdfPath,
  ]);
  if (!fs.existsSync(compressedPath) || fs.statSync(compressedPath).size === 0) {
    throw new Error('Ghostscript no produjo un PDF comprimido válido');
  }
  const compressedPdf = fs.readFileSync(compressedPath);
  const validation = await PDFDocument.load(compressedPdf, { updateMetadata: false });
  if (validation.getPageCount() !== merged.pageCount) {
    throw new Error(`La compresión cambió el número de páginas (${merged.pageCount} → ${validation.getPageCount()})`);
  }
  if (compressedPdf.length < merged.bytes.length) {
    compressedBytes = compressedPdf;
    writePrivate(mergedPdfPath, compressedPdf);
  }
  fs.rmSync(compressedPath, { force: true });

  const textPath = path.join(outputDir, 'conversation.txt');
  writePrivate(textPath, transcriptText(messages, attachmentById, timeZone));
  zipFiles.push(mergedPdfPath, textPath);

  const zipPath = path.join(outputDir, 'conversation-files.zip');
  await execFileAsync('zip', ['-q', '-X', '-j', zipPath, ...zipFiles], { maxBuffer: 8 * 1024 * 1024 });
  await execFileAsync('zip', ['-T', zipPath]);
  fs.chmodSync(zipPath, 0o600);

  return {
    textPath,
    zipPath,
    mergedPdfPath,
    messageCount: messages.length,
    attachmentCount: downloads.length,
    pdfCount,
    duplicatePdfCount: merged.duplicateFileNames.length,
    nonPdfAttachmentCount,
    originalPdfBytes,
    mergedPdfBytes: merged.bytes.length,
    compressedPdfBytes: compressedBytes.length,
    zipBytes: fs.statSync(zipPath).size,
  };
}
