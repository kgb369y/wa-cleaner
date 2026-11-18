import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { phoneNumberToJid } from './chat-pdfs.ts';
import {
  collectChatAttachments,
  collectOlderChatMessages,
  detectDeclaredFileType,
  detectFileType,
  findNewestChatAnchor,
  isExpectedFileSignature,
  matchesPhoneChat,
  readCapturedChatAttachments,
  safeAttachmentBaseName,
  unwrapMediaContent,
  type ChatAttachment,
  type DetectedFileType,
} from './chat-attachment-tools.ts';
import { config, ROOT } from './config.ts';
import { loadLidAliases } from './lid-mapping.ts';
import { reviver, serializeMessage } from './serialize.ts';
import { errMsg, MAX_MEDIA_BYTES, MediaTooLargeError, sleep, toNumber } from './utils.ts';
import { startWhatsApp, type WaClient } from './whatsapp.ts';

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const positionalArgs = args.filter((argument) => argument !== '--preflight');
const phone = positionalArgs[0];
const captureArgument = positionalArgs[1];
const preflightOnly = args.includes('--preflight');
if (!phone || positionalArgs.length > 2 || args.some((argument) => argument.startsWith('--') && argument !== '--preflight')) {
  throw new Error('Uso: npm run download-chat-attachments -- +<teléfono-internacional> [data/history-captures/<captura>.jsonl] [--preflight]');
}

const targetJid = phoneNumberToJid(phone);
const captureRoot = path.resolve(ROOT, 'data', 'history-captures');

function resolveCapturePath(argument?: string): string {
  if (argument) {
    const resolved = path.resolve(ROOT, argument);
    const relative = path.relative(captureRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('La captura debe estar dentro de data/history-captures/');
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error('No existe el archivo de captura indicado.');
    }
    return resolved;
  }

  const candidates = fs.readdirSync(captureRoot)
    .filter((name) => /^history-.*\.jsonl$/.test(name))
    .map((name) => path.join(captureRoot, name))
    .filter((filePath) => fs.statSync(filePath).isFile())
    .sort((first, second) => fs.statSync(second).mtimeMs - fs.statSync(first).mtimeMs);
  if (!candidates.length) throw new Error('No hay capturas JSONL en data/history-captures para identificar un mensaje ancla.');
  return candidates[0];
}

const capturePath = resolveCapturePath(captureArgument);
const connectionTimeoutMs = 180_000;
const pageTimeoutMs = 90_000;
const pageIdleMs = 2_500;
const pageSize = 50;
const maxHistoryPages = 2_000;

interface HistoryPage {
  requestId?: string;
  earlyRequestId?: string;
  confirmed: boolean;
  messages: any[];
  lastEventAt: number;
}

interface SavedAttachment {
  messageId: string;
  timestamp: number;
  declaredName?: string;
  declaredMime?: string;
  detectedType?: string;
  detectedMime?: string;
  bytes: number;
  sha256: string;
  status: 'saved' | 'saved-unverified' | 'encrypted-fallback' | 'failed';
  path?: string;
  error?: string;
}

function safeError(error: unknown): string {
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
  if (!state.opened) throw new Error('WhatsApp no se conectó en 3 minutos.');
  if (!wa.sock()) throw new Error('La conexión de WhatsApp se cerró antes de leer adjuntos.');
}

async function waitForPage(
  page: HistoryPage,
  getActivePage: () => HistoryPage | undefined,
): Promise<void> {
  const deadline = Date.now() + pageTimeoutMs;
  while (Date.now() < deadline) {
    if (getActivePage() !== page) throw new Error('La solicitud de historial cambió inesperadamente.');
    if (page.confirmed && Date.now() - page.lastEventAt >= pageIdleMs) return;
    await sleep(200);
  }
  throw new Error('WhatsApp no confirmó la respuesta de una página de historial en 90 segundos.');
}

function safeMediaUrl(message: any): string | undefined {
  const media = unwrapMediaContent(message);
  let url: URL;
  try {
    if (typeof media?.url === 'string') {
      url = new URL(media.url);
    } else if (typeof media?.directPath === 'string' && media.directPath.startsWith('/')) {
      url = new URL(media.directPath, 'https://mmg.whatsapp.net');
    } else {
      return undefined;
    }
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || !/(^|\.)whatsapp\.(net|com)$/.test(url.hostname)) return undefined;
  return url.toString();
}

async function fetchEncryptedMedia(message: any): Promise<Buffer> {
  const url = safeMediaUrl(message);
  if (!url) throw new Error('No hay un enlace de medios válido para recuperar el contenido cifrado.');
  const response = await fetch(url, {
    headers: { Origin: 'https://web.whatsapp.com' },
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.body) throw new Error('La respuesta de medios llegó sin contenido.');

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MEDIA_BYTES) {
    await response.body.cancel();
    throw new Error(`El contenido cifrado supera el límite de ${MAX_MEDIA_BYTES} bytes.`);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > MAX_MEDIA_BYTES) {
        await reader.cancel();
        throw new Error(`El contenido cifrado supera el límite de ${MAX_MEDIA_BYTES} bytes.`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new Error('El servidor devolvió un archivo vacío.');
  return Buffer.concat(chunks, size);
}

function preferredType(attachment: ChatAttachment, bytes: Buffer): DetectedFileType | undefined {
  const actual = detectFileType(bytes);
  const declared = detectDeclaredFileType(attachment);
  if (actual?.extension === 'zip' && declared && ['docx', 'xlsx', 'pptx'].includes(declared.extension)) {
    return declared;
  }
  if (actual?.extension === 'ole' && declared && ['doc', 'xls', 'ppt'].includes(declared.extension)) {
    return declared;
  }
  return actual ?? declared;
}

async function validateSavedFile(filePath: string, type: DetectedFileType | undefined, bytes: Buffer): Promise<void> {
  const written = fs.readFileSync(filePath);
  if (!written.equals(bytes)) throw new Error('La verificación binaria después de escribir no coincide.');
  if (!type || !isExpectedFileSignature(written, type)) {
    throw new Error(`Los bytes no confirman el tipo ${type?.description ?? 'identificado'}.`);
  }
  if (type.extension === 'pdf') {
    await PDFDocument.load(written, { updateMetadata: false });
  } else if (['zip', 'docx', 'xlsx', 'pptx'].includes(type.extension)) {
    await execFileAsync('unzip', ['-t', filePath], { maxBuffer: 2 * 1024 * 1024 });
  }
}

function outputFilePath(directory: string, attachment: ChatAttachment, extension: string): string {
  const base = safeAttachmentBaseName(attachment.fileName, attachment.id);
  const direction = attachment.fromMe ? 'sent' : 'received';
  return path.join(directory, `${attachment.timestamp}-${direction}-${base}.${extension}`);
}

async function saveDecodedAttachment(
  directory: string,
  attachment: ChatAttachment,
  bytes: Buffer,
): Promise<SavedAttachment> {
  const type = preferredType(attachment, bytes);
  const pathToFile = outputFilePath(directory, attachment, type?.extension ?? 'bin');
  fs.writeFileSync(pathToFile, bytes, { mode: 0o600, flag: 'wx' });
  let status: SavedAttachment['status'] = 'saved-unverified';
  let error: string | undefined;
  try {
    await validateSavedFile(pathToFile, type, bytes);
    status = type ? 'saved' : 'saved-unverified';
  } catch (validationError) {
    error = safeError(validationError);
  }
  const declaredMime = attachment.mimetype;
  const actualMime = detectFileType(bytes)?.mimetype;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    messageId: attachment.id,
    timestamp: attachment.timestamp,
    declaredName: attachment.fileName,
    declaredMime,
    detectedType: type?.description,
    detectedMime: actualMime ?? type?.mimetype,
    bytes: bytes.length,
    sha256,
    status,
    path: pathToFile,
    error,
  };
}

async function saveEncryptedFallback(
  directory: string,
  attachment: ChatAttachment,
  bytes: Buffer,
  downloadError: string,
): Promise<SavedAttachment> {
  const pathToFile = outputFilePath(directory, attachment, 'enc');
  fs.writeFileSync(pathToFile, bytes, { mode: 0o600, flag: 'wx' });
  const written = fs.readFileSync(pathToFile);
  if (!written.equals(bytes)) throw new Error('No se pudo verificar el respaldo cifrado escrito.');
  return {
    messageId: attachment.id,
    timestamp: attachment.timestamp,
    declaredName: attachment.fileName,
    declaredMime: attachment.mimetype,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    status: 'encrypted-fallback',
    path: pathToFile,
    error: `No se pudo descifrar por Baileys (${downloadError}); se conservó el stream cifrado sin conversión.`,
  };
}

async function downloadAttachment(
  wa: WaClient,
  outputDirectory: string,
  attachment: ChatAttachment,
): Promise<SavedAttachment> {
  try {
    const bytes = await wa.download(attachment.raw, MAX_MEDIA_BYTES);
    if (!bytes.length) throw new Error('WhatsApp devolvió un archivo vacío.');
    return await saveDecodedAttachment(outputDirectory, attachment, bytes);
  } catch (downloadError) {
    const reason = safeError(downloadError);
    if (downloadError instanceof MediaTooLargeError) {
      return {
        messageId: attachment.id,
        timestamp: attachment.timestamp,
        declaredName: attachment.fileName,
        declaredMime: attachment.mimetype,
        bytes: 0,
        sha256: '',
        status: 'failed',
        error: reason,
      };
    }
    console.warn(`No se pudo descifrar por Baileys (${reason}); intentando guardar el stream original cifrado.`);

    let rawError: unknown;
    for (const candidate of [attachment.raw]) {
      try {
        const bytes = await fetchEncryptedMedia(candidate);
        return await saveEncryptedFallback(outputDirectory, attachment, bytes, reason);
      } catch (error) {
        rawError = error;
      }
    }

    try {
      const refreshed = await wa.sock().updateMediaMessage(attachment.raw);
      const bytes = await fetchEncryptedMedia(refreshed);
      return await saveEncryptedFallback(outputDirectory, attachment, bytes, reason);
    } catch (error) {
      rawError = error;
    }

    return {
      messageId: attachment.id,
      timestamp: attachment.timestamp,
      declaredName: attachment.fileName,
      declaredMime: attachment.mimetype,
      bytes: 0,
      sha256: '',
      status: 'failed',
      error: `${reason}; respaldo cifrado falló: ${safeError(rawError)}`,
    };
  }
}

async function main(): Promise<void> {
  const lidAliases = await loadLidAliases([
    config.authDir,
    path.join(ROOT, 'data', 'history-capture-auth'),
  ]);
  const anchor = await findNewestChatAnchor(capturePath, targetJid, lidAliases);
  const capturedAttachments = await readCapturedChatAttachments(capturePath, targetJid, lidAliases);
  console.log(`Ancla local del chat identificada. La captura contiene ${capturedAttachments.length} adjuntos conocidos.`);
  console.log('La ejecución no imprimirá ni exportará textos de mensajes; solo procesará claves, fechas y metadatos de adjuntos.');
  if (preflightOnly) {
    capturedAttachments.forEach((attachment, index) => {
      console.log(
        `  ${index + 1}. ${attachment.fileName || attachment.kind}` +
        ` | ${attachment.mimetype || 'tipo no declarado'}` +
        ` | ${attachment.fileLength == null ? 'tamaño no declarado' : `${attachment.fileLength} bytes`}`,
      );
    });
    console.log('Preflight terminado sin conectar a WhatsApp.');
    return;
  }

  const connection = { opened: false, fatal: undefined as string | undefined };
  const knownMessages = new Map<string, any>();
  const seenMessages = new Set(anchor.seenMessageIdentities);
  for (const attachment of capturedAttachments) {
    const identity = `${attachment.fromMe ? 1 : 0}|${attachment.id}`;
    knownMessages.set(identity, attachment.raw);
  }

  const capturedAnchorKey = {
    ...anchor.key,
    remoteJid: targetJid,
  };
  let cursorKey: any = capturedAnchorKey;
  let cursorTimestamp = anchor.timestamp;
  let activePage: HistoryPage | undefined;
  let historyPageCount = 0;
  let historyMessageCount = 0;
  let historyComplete = false;
  let wa: WaClient | undefined;
  let exportDirectory: string | undefined;

  seenMessages.add(`${capturedAnchorKey.fromMe ? 1 : 0}|${capturedAnchorKey.id}`);

  try {
    wa = await startWhatsApp({
      authDir: path.join(ROOT, 'data', 'history-capture-auth'),
      syncFullHistory: true,
      logLevel: 'silent',
      handlers: {
        onQr: () => {
          connection.fatal = 'La sesión secundaria necesita vincularse otra vez; se detiene sin mostrar ni guardar un QR.';
        },
        onOpen: () => {
          connection.opened = true;
        },
        onMessages: (messages, source) => {
          if (!activePage || source !== 'history') return;
          for (const message of messages) {
            if (!matchesPhoneChat(message, targetJid, lidAliases)) continue;
            const key = message?.key;
            if (typeof key?.id !== 'string' || !key.id) continue;
            activePage.messages.push(message);
          }
        },
        onHistoryProgress: ({ requestSessionId }) => {
          if (!activePage || !requestSessionId) return;
          activePage.earlyRequestId = requestSessionId;
          if (requestSessionId !== activePage.requestId) return;
          activePage.confirmed = true;
          activePage.lastEventAt = Date.now();
        },
        onFatal: (_code, reason) => {
          connection.fatal = reason;
        },
      },
    });

    await waitForConnection(wa, connection);
    console.log('Conectado. Solicitando el historial de ese chat hacia atrás en bloques de hasta 50 mensajes…');
    const seenCursors = new Set<string>();

    // No pedir historial adicional; trabajar solo con los adjuntos de la captura
    historyComplete = true;
    console.log(`Usando los ${capturedAttachments.length} adjuntos ya conocidos de la captura local.`);
    if (!historyComplete && historyPageCount >= maxHistoryPages) {
      throw new Error(`Se alcanzó el límite de seguridad de ${maxHistoryPages} páginas; no se marcará la lectura como completa.`);
    }
    activePage = undefined;

    const attachments = collectChatAttachments([...knownMessages.values()], targetJid, lidAliases);
    console.log(`Adjuntos detectados en la conversación: ${attachments.length}.`);
    if (!attachments.length) {
      console.log('WhatsApp no devolvió ningún mensaje con medio/archivo para ese chat.');
      return;
    }
    attachments.forEach((attachment, index) => {
      console.log(
        `  ${index + 1}. ${attachment.fileName || `${attachment.kind}-${attachment.id}`}` +
        ` | ${attachment.mimetype || 'tipo no declarado'}` +
        ` | ${attachment.fileLength == null ? 'tamaño no declarado' : `${attachment.fileLength} bytes`}`,
      );
    });

    fs.mkdirSync(path.join(ROOT, 'data', 'chat-exports'), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(ROOT, 'data', 'chat-exports'), 0o700);
    exportDirectory = path.join(
      ROOT,
      'data',
      'chat-exports',
      `attachment-scan-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    );
    fs.mkdirSync(exportDirectory, { mode: 0o700 });
    fs.chmodSync(exportDirectory, 0o700);

    const manifest: SavedAttachment[] = [];
    for (const [index, attachment] of attachments.entries()) {
      console.log(`Descargando adjunto ${index + 1}/${attachments.length}…`);
      const saved = await downloadAttachment(wa, exportDirectory, attachment);
      manifest.push(saved);
      if (saved.status === 'failed') {
        console.error(`  ❌ No se pudo guardar: ${saved.error}`);
      } else if (saved.status === 'encrypted-fallback') {
        console.warn(`  ⚠️ Se guardó el respaldo cifrado (no se pudo abrir/convertir): ${saved.path}`);
      } else {
        const state = saved.status === 'saved' ? 'tipo verificado' : 'bytes conservados, tipo sin verificar';
        console.log(`  ✅ ${state}: ${saved.path} (${saved.bytes} bytes)`);
      }
      await sleep(250);
    }

    const manifestPath = path.join(exportDirectory, 'attachments-manifest.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      historyPages: historyPageCount,
      olderMessagesRead: historyMessageCount,
      attachmentCount: attachments.length,
      results: manifest,
    }, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(manifestPath, 0o600);
    console.log(`\nResultado guardado en: ${exportDirectory}`);
    console.log(`Índice de archivos: ${manifestPath}`);
    console.log(`Resumen: ${manifest.filter((item) => item.status === 'saved').length} verificados, ${manifest.filter((item) => item.status === 'saved-unverified').length} conservados sin verificar, ${manifest.filter((item) => item.status === 'encrypted-fallback').length} respaldos cifrados y ${manifest.filter((item) => item.status === 'failed').length} fallidos.`);
    if (manifest.some((item) => item.status !== 'saved')) process.exitCode = 1;
  } finally {
    activePage = undefined;
    if (wa) await wa.stop();
  }
}

main().catch((error) => {
  console.error(`❌ No se pudieron leer los adjuntos del chat: ${safeError(error)}`);
  process.exitCode = 1;
});
