import fs from 'node:fs';
import path from 'node:path';
import { config, loadRules, ROOT } from './config.ts';
import { loadLidAliases } from './lid-mapping.ts';
import { listMatchedChats } from './matched-chats.ts';
import { readCapturedChat } from './process-captured-chat.ts';
import { collectFreshChatPdfs, collectOlderChatMessages } from './fresh-chat-pdf.ts';
import { errMsg, MAX_MEDIA_BYTES, sleep, toNumber } from './utils.ts';
import { serializeMessage } from './serialize.ts';
import { startWhatsApp, type WaClient } from './whatsapp.ts';

const captureArgument = process.argv[2];
if (!captureArgument || process.argv.length > 3) {
  throw new Error('Uso: npm run test-download-chat-pdf -- data/history-captures/<captura>.jsonl');
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
const pageTimeoutMs = 60_000;
const historyIdleMs = 3_000;
const historyPageSize = 50;

function matchesTarget(raw: any, targetJid: string, lidAliases: Map<string, string>): boolean {
  const target = targetJid.replace(/:\d+(?=@)/, '');
  const jids = [raw?.key?.remoteJid, raw?.key?.remoteJidAlt]
    .filter((jid): jid is string => typeof jid === 'string')
    .map((jid) => jid.replace(/:\d+(?=@)/, ''));
  return jids.some((jid) =>
    jid === target || lidAliases.get(jid)?.replace(/:\d+(?=@)/, '') === target,
  );
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
  if (!state.opened) throw new Error('WhatsApp no se conectó en 3 minutos');
  if (!wa.sock()) throw new Error('La conexión de WhatsApp se cerró antes de consultar el historial');
}

async function identifyTarget(
  aliases: Map<string, string>,
): Promise<{ jid: string; messages: Awaited<ReturnType<typeof readCapturedChat>> }> {
  const rules = loadRules();
  const candidates = await listMatchedChats(capturePath, rules.rescue.keywords, aliases);
  const matches: { jid: string; messages: Awaited<ReturnType<typeof readCapturedChat>> }[] = [];

  for (const candidate of candidates) {
    const jid = candidate.aliases.find((alias) => alias.endsWith('@s.whatsapp.net'));
    if (!jid) continue;
    const messages = await readCapturedChat(capturePath, jid, aliases);
    const media = messages.filter((message) => message.hasMedia);
    const pdfs = media.filter((message) =>
      message.mimetype?.split(';', 1)[0].trim().toLowerCase() === 'application/pdf'
      || /\.pdf$/i.test(message.fileName ?? ''),
    );
    const images = media.filter((message) => message.mimetype?.toLowerCase().startsWith('image/'));
    if (messages.length === 30 && media.length === 7 && pdfs.length === 6 && images.length === 1) {
      matches.push({ jid, messages });
    }
  }

  if (matches.length !== 1) {
    throw new Error(`No se identificó un único chat de prueba (candidatos con 30 mensajes, 6 PDFs y 1 imagen: ${matches.length}).`);
  }
  return matches[0];
}

interface HistoryPageState {
  requestSessionId?: string;
  receivedSessionId?: string;
  responseReceived: boolean;
  targetMessages: any[];
  lastResponseAt: number;
}

async function waitForHistoryPage(
  state: HistoryPageState,
  activePage: () => HistoryPageState | undefined,
): Promise<void> {
  const deadline = Date.now() + pageTimeoutMs;
  while (Date.now() < deadline) {
    if (activePage() !== state) throw new Error('La solicitud de historial cambió inesperadamente.');
    if (state.responseReceived && Date.now() - state.lastResponseAt >= historyIdleMs) return;
    await sleep(250);
  }
  throw new Error('WhatsApp no confirmó la respuesta de una página de historial en 60 segundos.');
}

async function main(): Promise<void> {
  const lidAliases = await loadLidAliases([
    config.authDir,
    path.join(ROOT, 'data', 'history-capture-auth'),
  ]);
  const target = await identifyTarget(lidAliases);
  const anchor = target.messages.at(-1);
  if (!anchor?.raw?.key?.id || !anchor.timestamp) {
    throw new Error('No hay un mensaje válido para usar como ancla del historial bajo demanda.');
  }

  const connection = { opened: false, fatal: undefined as string | undefined };
  const downloadedMessages = new Map<string, any>();
  const historyPages = { count: 0, messages: 0 };
  let activePage: HistoryPageState | undefined;
  let wa: WaClient | undefined;
  let outputPath: string | undefined;

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
        onMessages: (messages, source) => {
          if (!activePage || source !== 'history') return;
          for (const message of messages) {
            if (!matchesTarget(message, target.jid, lidAliases)) continue;
            const key = message?.key;
            if (typeof key?.id !== 'string' || !key.id) continue;
            const identity = `${key.fromMe === true ? 1 : 0}|${key.id}`;
            activePage.targetMessages.push(message);
            downloadedMessages.set(identity, message);
          }
        },
        onHistoryProgress: ({ requestSessionId }) => {
          if (!activePage || !requestSessionId) return;
          activePage.receivedSessionId = requestSessionId;
          if (requestSessionId !== activePage.requestSessionId) return;
          activePage.responseReceived = true;
          activePage.lastResponseAt = Date.now();
        },
        onFatal: (_code, reason) => {
          connection.fatal = reason;
        },
      },
    });

    await waitForConnection(wa, connection);
    console.log('WhatsApp conectado; solicitando páginas de hasta 50 mensajes anteriores, solo del chat objetivo…');
    let cursorRaw = anchor.raw;
    let cursorTimestamp = anchor.timestamp;
    const seenCursors = new Set<string>();
    const seenMessageIdentities = new Set(
      target.messages.map((message) => `${message.fromMe ? 1 : 0}|${message.id}`),
    );
    while (true) {
      const cursorIdentity = `${cursorRaw.key.fromMe === true ? 1 : 0}|${cursorRaw.key.id}`;
      if (seenCursors.has(cursorIdentity)) {
        throw new Error('La paginación repitió un mensaje ancla; se detiene para evitar un bucle.');
      }
      seenCursors.add(cursorIdentity);

      const page: HistoryPageState = {
        responseReceived: false,
        targetMessages: [],
        lastResponseAt: 0,
      };
      activePage = page;
      const requestSessionId = await wa.sock().fetchMessageHistory(
        historyPageSize,
        cursorRaw.key,
        toNumber(cursorRaw.messageTimestamp ?? cursorTimestamp),
      );
      if (typeof requestSessionId !== 'string' || !requestSessionId) {
        throw new Error('WhatsApp no devolvió un identificador para correlacionar la página de historial.');
      }
      page.requestSessionId = requestSessionId;
      if (page.receivedSessionId === requestSessionId) {
        page.responseReceived = true;
        page.lastResponseAt = Date.now();
      }
      historyPages.count++;
      console.log(`Consultando página ${historyPages.count} del historial del chat…`);
      await waitForHistoryPage(page, () => activePage);
      activePage = undefined;

      const newOlderMessages = collectOlderChatMessages(
        page.targetMessages,
        target.jid,
        lidAliases,
        cursorTimestamp,
        seenMessageIdentities,
      );
      if (!newOlderMessages.length) {
        console.log('WhatsApp no devolvió mensajes anteriores; se alcanzó el inicio disponible del chat.');
        break;
      }

      historyPages.messages += newOlderMessages.length;
      for (const message of newOlderMessages) {
        seenMessageIdentities.add(`${message.key.fromMe === true ? 1 : 0}|${message.key.id}`);
      }
      const oldest = newOlderMessages.reduce((currentOldest, message) => {
        const timestamp = toNumber(message.messageTimestamp);
        return timestamp < toNumber(currentOldest.messageTimestamp) ? message : currentOldest;
      });
      cursorRaw = oldest;
      cursorTimestamp = toNumber(oldest.messageTimestamp);
    }

    activePage = undefined;
    console.log(`Historial anterior recibido: ${historyPages.messages} mensajes en ${historyPages.count} páginas.`);

    const freshPdfs = collectFreshChatPdfs([...downloadedMessages.values()], target.jid, lidAliases);
    const firstPdf = freshPdfs[0];
    if (!firstPdf) {
      throw new Error('WhatsApp no devolvió PDFs dentro de las páginas de historial solicitadas.');
    }

    console.log(`Se encontraron ${freshPdfs.length} PDFs en los mensajes recibidos; se descargará solo el más antiguo.`);
    const bytes = await wa.download(firstPdf.raw, MAX_MEDIA_BYTES);
    if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('La descarga terminó, pero el contenido no tiene una cabecera PDF válida; se conserva fuera del destino final.');
    }

    const outputDirectory = path.join(ROOT, 'data', 'chat-exports');
    fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(outputDirectory, 0o700);
    const exportDirectory = path.join(outputDirectory, `single-pdf-test-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(exportDirectory, { mode: 0o700 });
    fs.chmodSync(exportDirectory, 0o700);
    outputPath = path.join(exportDirectory, 'first-pdf.pdf');
    fs.writeFileSync(outputPath, bytes, { mode: 0o600 });
    fs.chmodSync(outputPath, 0o600);

    const mergedHistory = new Map<string, any>();
    for (const message of target.messages.map((item) => item.raw)) {
      const key = message?.key;
      if (typeof key?.id !== 'string' || !key.id) continue;
      mergedHistory.set(`${key.fromMe === true ? 1 : 0}|${key.id}`, message);
    }
    for (const [identity, message] of downloadedMessages) mergedHistory.set(identity, message);
    const historyPath = path.join(exportDirectory, 'chat-history.jsonl');
    const historyLines = [...mergedHistory.values()]
      .sort((first, second) =>
        toNumber(first.messageTimestamp) - toNumber(second.messageTimestamp)
        || String(first.key.id).localeCompare(String(second.key.id)),
      )
      .map((message) => serializeMessage({ message }));
    fs.writeFileSync(historyPath, `${historyLines.join('\n')}\n`, { mode: 0o600 });
    fs.chmodSync(historyPath, 0o600);
  } finally {
    if (wa) await wa.stop();
  }

  console.log('✅ Prueba exitosa: WhatsApp volvió a entregar el PDF y el archivo se descargó correctamente.');
  console.log(`Archivo local: ${outputPath}`);
}

main().catch((error) => {
  console.error(`❌ No se pudo descargar el PDF de prueba: ${safeError(error)}`);
  process.exitCode = 1;
});
