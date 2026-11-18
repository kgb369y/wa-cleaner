import fs from 'node:fs';
import path from 'node:path';
import { config, loadRules, ROOT } from './config.ts';
import { phoneNumberToJid } from './chat-pdfs.ts';
import { loadLidAliases } from './lid-mapping.ts';
import { listMatchedChats } from './matched-chats.ts';
import { packageChatExport, type ChatMediaDownload } from './package-chat-export.ts';
import { readCapturedChat } from './process-captured-chat.ts';
import { errMsg, MAX_MEDIA_BYTES, sleep } from './utils.ts';
import { startWhatsApp, type WaClient } from './whatsapp.ts';

const argumentsList = process.argv.slice(2);
const captureArgument = argumentsList[0];
const phoneArgument = argumentsList.slice(1).find((argument) => argument !== '--preflight');
const preflightOnly = argumentsList.includes('--preflight');
if (!captureArgument || argumentsList.length > 3) {
  throw new Error('Uso: npm run process-captured-chat -- data/history-captures/<captura>.jsonl [teléfono-internacional] [--preflight]');
}

const captureRoot = path.resolve(ROOT, 'data', 'history-captures');
const capturePath = path.resolve(ROOT, captureArgument);
const relativeCapture = path.relative(captureRoot, capturePath);
if (!relativeCapture || relativeCapture.startsWith('..') || path.isAbsolute(relativeCapture)) {
  throw new Error('La captura debe estar dentro de data/history-captures/');
}
if (!fs.existsSync(capturePath) || !fs.statSync(capturePath).isFile()) {
  throw new Error('No existe el archivo de captura indicado');
}

const connectionTimeoutMs = 180_000;

function safeDownloadError(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as { output?: { statusCode?: unknown }; statusCode?: unknown };
    const status = candidate.output?.statusCode ?? candidate.statusCode;
    if (typeof status === 'number') return `HTTP ${status}`;
  }
  return errMsg(error).replace(/https?:\/\/\S+/g, '[enlace omitido]');
}

async function waitForConnection(
  wa: WaClient,
  state: { opened: boolean; fatal?: string },
): Promise<void> {
  const deadline = Date.now() + connectionTimeoutMs;
  while (!state.opened && !state.fatal && Date.now() < deadline) await sleep(250);
  if (state.fatal) throw new Error(state.fatal);
  if (!state.opened) throw new Error('WhatsApp no se conectó en 3 minutos');
  if (!wa.sock()) throw new Error('La conexión de WhatsApp se cerró antes de descargar los adjuntos');
}

async function main(): Promise<void> {
  const lidAliases = await loadLidAliases([
    config.authDir,
    path.join(ROOT, 'data', 'history-capture-auth'),
  ]);
  let targetJid: string;

  if (phoneArgument) {
    targetJid = phoneNumberToJid(phoneArgument);
  } else {
    const rules = loadRules();
    const candidates = await listMatchedChats(capturePath, rules.rescue.keywords, lidAliases);
    const matches = [];
    for (const candidate of candidates) {
      const phoneJid = candidate.aliases.find((jid) => jid.endsWith('@s.whatsapp.net'));
      if (!phoneJid) continue;
      const messages = await readCapturedChat(capturePath, phoneJid, lidAliases);
      const media = messages.filter((message) => message.hasMedia);
      const pdfs = media.filter((message) =>
        message.mimetype?.split(';', 1)[0].trim().toLowerCase() === 'application/pdf'
        || /\.pdf$/i.test(message.fileName ?? ''),
      );
      const images = media.filter((message) => message.mimetype?.toLowerCase().startsWith('image/'));
      if (messages.length === 30 && media.length === 7 && pdfs.length === 6 && images.length === 1) {
        matches.push(phoneJid);
      }
    }
    if (matches.length !== 1) {
      throw new Error(
        `No se pudo identificar sin ambigüedad la conversación esperada (30 mensajes, 6 PDFs y 1 imagen; candidatos: ${matches.length}). Indica el teléfono internacional como segundo argumento.`,
      );
    }
    targetJid = matches[0];
  }

  const messages = await readCapturedChat(capturePath, targetJid, lidAliases);
  if (!messages.length) throw new Error('La captura no contiene mensajes de la conversación indicada');
  const mediaMessages = messages.filter((message) => message.hasMedia);
  if (!mediaMessages.length) throw new Error('La conversación no contiene adjuntos descargables');

  console.log(`Conversación aislada: ${messages.length} mensajes y ${mediaMessages.length} adjuntos.`);
  const pdfCount = mediaMessages.filter((message) =>
    message.mimetype?.split(';', 1)[0].trim().toLowerCase() === 'application/pdf'
    || /\.pdf$/i.test(message.fileName ?? ''),
  ).length;
  const imageCount = mediaMessages.filter((message) => message.mimetype?.toLowerCase().startsWith('image/')).length;
  console.log(`Preflight de adjuntos: ${pdfCount} PDFs y ${imageCount} imágenes.`);
  console.log('No se leerán ni descargarán archivos de otras conversaciones; no se enviará nada a Telegram.');
  if (preflightOnly) {
    console.log('Preflight terminado sin conectar a WhatsApp.');
    return;
  }

  const connection = { opened: false, fatal: undefined as string | undefined };
  let wa: WaClient | undefined;
  const downloads: ChatMediaDownload[] = [];
  try {
    wa = await startWhatsApp({
      authDir: path.join(ROOT, 'data', 'history-capture-auth'),
      syncFullHistory: false,
      logLevel: 'silent',
      handlers: {
        onQr: () => {
          connection.fatal = 'La sesión secundaria necesita vincularse otra vez; no se mostrará ni guardará un QR automáticamente.';
        },
        onOpen: () => {
          connection.opened = true;
        },
        onFatal: (_code, reason) => {
          connection.fatal = reason;
        },
      },
    });

    await waitForConnection(wa, connection);
    for (const [index, message] of mediaMessages.entries()) {
      try {
        const bytes = await wa.download(message.raw, MAX_MEDIA_BYTES);
        downloads.push({ message, bytes });
        console.log(`Adjunto ${index + 1}/${mediaMessages.length}: descargado.`);
      } catch (error) {
        const reason = safeDownloadError(error);
        downloads.push({ message, error: reason });
        console.error(`Adjunto ${index + 1}/${mediaMessages.length}: falló la descarga: ${reason}`);
      }
    }
  } finally {
    if (wa) await wa.stop();
  }

  const failures = downloads.filter((item) => !item.bytes);
  if (failures.length) {
    throw new Error(`Falló la descarga de ${failures.length} adjunto(s); no se generará el ZIP final.`);
  }

  const date = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.join(ROOT, 'data', 'chat-exports', `single-chat-${date}`);
  const result = await packageChatExport({
    messages,
    downloads,
    outputDir,
    title: 'Documentos de la conversación de WhatsApp',
    timeZone: config.tz,
  });

  console.log(`Exportación local completa: ${result.messageCount} mensajes, ${result.attachmentCount} adjuntos.`);
  console.log(`PDFs unidos: ${result.pdfCount}; duplicados idénticos omitidos: ${result.duplicatePdfCount}.`);
  console.log(`Adjuntos no PDF incluidos en el ZIP: ${result.nonPdfAttachmentCount}.`);
  console.log(`PDF combinado: ${result.compressedPdfBytes} bytes (antes de comprimir: ${result.mergedPdfBytes} bytes).`);
  console.log(`TXT: ${path.relative(ROOT, result.textPath)}`);
  console.log(`ZIP: ${path.relative(ROOT, result.zipPath)} (${result.zipBytes} bytes).`);
}

main().catch((error) => {
  console.error(`❌ No se pudo procesar la conversación aislada: ${errMsg(error)}`);
  process.exitCode = 1;
});
