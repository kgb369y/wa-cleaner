import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { config, ROOT } from './config.ts';
import { HistoryCapture } from './history-capture.ts';
import { qrMatrixToPng } from './qr-png.ts';
import { errMsg } from './utils.ts';
import { startWhatsApp } from './whatsapp.ts';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode') as new (
  version: number,
  errorCorrectionLevel: number,
) => {
  addData(value: string): void;
  make(): void;
  modules: boolean[][];
};
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel') as { L: number };

const freshLink = process.argv[2] === '--fresh-link';
if (process.argv.length > (freshLink ? 3 : 2)) {
  throw new Error('Uso: npm run capture-history [-- --fresh-link]');
}
const fileName = `history-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
const filePath = path.join(ROOT, 'data', 'history-captures', fileName);
const qrImagePath = path.join(path.dirname(filePath), `${path.parse(fileName).name}-pairing-qr.png`);
const authDir = freshLink ? path.join(ROOT, 'data', 'history-capture-auth') : config.authDir;
const MAX_WAIT_MS = config.checkMaxWaitMinutes * 60_000;
const HISTORY_IDLE_MS = 60_000;
const INITIAL_HISTORY_WAIT_MS = 180_000;
const CONNECTION_TIMEOUT_MS = 180_000;

function savePairingQr(payload: string) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(payload);
  qr.make();
  fs.writeFileSync(qrImagePath, qrMatrixToPng(qr.modules), { mode: 0o600 });
  fs.chmodSync(qrImagePath, 0o600);
  console.log(`Abre esta imagen QR para vincular WhatsApp: ${path.relative(ROOT, qrImagePath)}`);
}

async function main() {
  const capture = new HistoryCapture(filePath);
  let wa: Awaited<ReturnType<typeof startWhatsApp>> | undefined;
  let openedAt = 0;
  let lastHistoryAt = 0;
  let historyBatches = 0;
  let latestHistorySeen = false;
  let captureError: unknown;
  let fatal: string | undefined;

  console.log('Captura local de historial completa: guarda todos los mensajes de los bloques de historial recibidos.');
  console.log('No aplica rules.json, no descarga adjuntos y no envía datos a Telegram.');
  console.log(`Archivo local: ${path.relative(ROOT, filePath)}`);
  if (freshLink) {
    console.log('Usará una sesión de vinculación separada en data/history-capture-auth; la carpeta auth/ actual no se modifica.');
  }

  try {
    wa = await startWhatsApp({
      authDir,
      syncFullHistory: true,
      logLevel: config.logLevel,
      handlers: {
        onQr: savePairingQr,
        onOpen: () => {
          if (!openedAt) openedAt = Date.now();
          fs.rmSync(qrImagePath, { force: true });
          console.log('WhatsApp conectado; esperando bloques de historial…');
        },
        onMessages: (messages, source) => {
          if (source !== 'history') return;
          historyBatches++;
          lastHistoryAt = Date.now();
          try {
            const added = capture.append(messages);
            console.log(`Bloque de historial ${historyBatches}: ${added} mensajes capturados (${capture.count} en total).`);
          } catch (error) {
            captureError = error;
            console.error(`Error al escribir la captura de historial: ${errMsg(error)}`);
          }
        },
        onHistoryProgress: ({ progress, isLatest, messages }) => {
          if (messages > 0 || progress != null || isLatest) lastHistoryAt = Date.now();
          if (isLatest) latestHistorySeen = true;
          if (progress != null || isLatest) {
            console.log(`Sincronización de historial: ${progress ?? '?'}%${isLatest ? ' (último bloque)' : ''}.`);
          }
        },
        onFatal: (_code, reason) => {
          fatal = reason;
        },
      },
    });

    const connectionDeadline = Date.now() + CONNECTION_TIMEOUT_MS;
    while (!openedAt && !fatal && Date.now() < connectionDeadline) await sleep(500);
    if (fatal) throw new Error(fatal);
    if (!openedAt) throw new Error('WhatsApp no se conectó en 3 minutos.');

    while (!fatal && !captureError) {
      const now = Date.now();
      const reference = historyBatches ? lastHistoryAt : openedAt;
      const idleLimit = historyBatches ? HISTORY_IDLE_MS : INITIAL_HISTORY_WAIT_MS;

      if (now - reference >= idleLimit) break;
      if (now - openedAt >= MAX_WAIT_MS) {
        console.warn('Se alcanzó el tiempo máximo configurado; la captura puede estar incompleta.');
        break;
      }
      await sleep(500);
    }

    if (fatal) throw new Error(fatal);
    if (captureError) throw captureError;
  } finally {
    if (wa) await wa.stop();
    capture.close();
    fs.rmSync(qrImagePath, { force: true });
  }

  console.log(`Captura terminada: ${capture.count} mensajes, ${historyBatches} bloques.`);
  console.log(`Archivo: ${path.relative(ROOT, filePath)}`);
  if (historyBatches === 0) {
    console.warn('WhatsApp no entregó bloques de historial en esta sesión; la captura está vacía. Este comando no fuerza una nueva sincronización.');
  } else if (!latestHistorySeen) {
    console.warn('No se recibió la marca de último bloque; la captura puede ser parcial.');
  }
}

main().catch((error) => {
  console.error(`❌ No se pudo capturar el historial: ${errMsg(error)}`);
  process.exitCode = 1;
});
