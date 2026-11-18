import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { config, ROOT } from './config.ts';
import { chatAttachmentFileName, collectChatMessages } from './chat-export.ts';
import { phoneNumberToJid } from './chat-pdfs.ts';
import { qrMatrixToPng } from './qr-png.ts';
import { errMsg, MAX_MEDIA_BYTES } from './utils.ts';
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

const phone = process.argv[2];
if (!phone) {
  throw new Error('Uso: npm run export-chat -- +<teléfono internacional>');
}
if (process.argv.length > 3) {
  throw new Error('Solo se admite un argumento: el teléfono internacional del chat');
}

const targetJid = phoneNumberToJid(phone);
const phoneSuffix = targetJid.split('@')[0].slice(-4);
const exportName = `chat-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const exportDir = path.join(ROOT, 'data', 'chat-exports', exportName);
const transcriptPath = path.join(exportDir, 'transcript.jsonl');
const qrImagePath = path.join(exportDir, 'pairing-qr.png');
const maxWaitMs = config.checkMaxWaitMinutes * 60_000;

function savePairingQr(payload: string) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(payload);
  qr.make();
  fsSync.writeFileSync(qrImagePath, qrMatrixToPng(qr.modules), { mode: 0o600 });
  fsSync.chmodSync(qrImagePath, 0o600);
  console.log(`Abre la imagen QR local para vincular WhatsApp: ${path.relative(ROOT, qrImagePath)}`);
}

async function main() {
  await fs.mkdir(exportDir, { recursive: true, mode: 0o700 });
  await fs.chmod(exportDir, 0o700);
  const transcript = await fs.open(transcriptPath, 'wx', 0o600);
  let wa: Awaited<ReturnType<typeof startWhatsApp>> | undefined;
  let queue = Promise.resolve();
  let queueError: unknown;
  let openedAt = 0;
  let lastActivityAt = 0;
  let historyBatches = 0;
  let seenMessages = 0;
  let writtenMessages = 0;
  let downloadedFiles = 0;
  let failedFiles = 0;
  let fatal: string | undefined;
  const seenIds = new Set<string>();

  console.log(`Exportación local del chat terminado en …${phoneSuffix}. No se enviará nada a Telegram.`);
  console.log('Conectando a WhatsApp. Si aparece un QR, escanea solo si quieres iniciar/vincular esta sesión.');

  try {
    wa = await startWhatsApp({
      authDir: config.authDir,
      syncFullHistory: config.syncFullHistory,
      logLevel: config.logLevel,
      handlers: {
        onQr: savePairingQr,
        onOpen: () => {
          if (!openedAt) openedAt = Date.now();
          fsSync.rmSync(qrImagePath, { force: true });
          console.log('WhatsApp conectado; esperando el historial disponible del chat…');
        },
        onMessages: (messages, source, client) => {
          if (source !== 'history' && source !== 'notify' && source !== 'append') return;
          if (source === 'history') historyBatches++;
          lastActivityAt = Date.now();
          const matches = collectChatMessages(messages, targetJid);

          for (const message of matches) {
            if (seenIds.has(message.id)) continue;
            seenIds.add(message.id);
            seenMessages++;
            queue = queue.then(async () => {
              if (queueError) return;
              let attachment: { status: 'downloaded'; file: string } | { status: 'failed'; error: string } | undefined;

              if (message.hasMedia) {
                try {
                  const bytes = await client.download(message.raw, MAX_MEDIA_BYTES);
                  if (!bytes.length) throw new Error('WhatsApp devolvió un archivo vacío');

                  const attachmentsDir = path.join(exportDir, 'attachments');
                  await fs.mkdir(attachmentsDir, { recursive: true, mode: 0o700 });
                  await fs.chmod(attachmentsDir, 0o700);
                  const name = chatAttachmentFileName(message);
                  await fs.writeFile(path.join(attachmentsDir, name), bytes, { flag: 'wx', mode: 0o600 });
                  attachment = { status: 'downloaded', file: path.posix.join('attachments', name) };
                  downloadedFiles++;
                } catch (error) {
                  failedFiles++;
                  attachment = { status: 'failed', error: errMsg(error) };
                  console.error(`No se pudo descargar un adjunto (${message.kind}): ${errMsg(error)}`);
                }
              }

              const { raw: _raw, ...record } = message;
              await transcript.writeFile(`${JSON.stringify({ ...record, attachment })}\n`);
              writtenMessages++;
              if (writtenMessages % 25 === 0) {
                console.log(`Procesados ${writtenMessages} mensajes del chat; ${downloadedFiles} archivos descargados.`);
              }
            }).catch((error) => {
              queueError = error;
            });
          }
        },
        onHistoryProgress: ({ progress, messages }) => {
          if (messages > 0) lastActivityAt = Date.now();
          if (messages > 0 || progress != null) {
            console.log(`Historial: bloque de ${messages} mensajes${progress != null ? `, avance ${progress}%` : ''}.`);
          }
        },
        onFatal: (_code, reason) => {
          fatal = reason;
        },
      },
    });

    const connectionDeadline = Date.now() + 180_000;
    while (!openedAt && !fatal && Date.now() < connectionDeadline) await sleep(500);
    if (fatal) throw new Error(fatal);
    if (!openedAt) throw new Error('WhatsApp no se conectó en 3 minutos.');

    while (!fatal) {
      const now = Date.now();
      const idleLimit = historyBatches > 0 ? 45_000 : 60_000;
      if (now - (lastActivityAt || openedAt) >= idleLimit) break;
      if (now - openedAt >= maxWaitMs) {
        console.warn('Se alcanzó el tiempo máximo de espera configurado; el export puede estar incompleto.');
        break;
      }
      await sleep(500);
    }
    if (fatal) throw new Error(fatal);
  } finally {
    if (wa) await wa.stop();
    await queue;
    await transcript.close();
    fsSync.rmSync(qrImagePath, { force: true });
  }

  if (queueError) throw queueError;
  console.log('\nExportación terminada.');
  console.log(`Mensajes del chat guardados: ${writtenMessages}.`);
  console.log(`Archivos descargados: ${downloadedFiles}; fallidos: ${failedFiles}.`);
  console.log(`Resultado local: ${path.relative(ROOT, exportDir)}`);
  if (seenMessages === 0) {
    console.warn('No se recibieron mensajes de ese chat en esta sesión. WhatsApp puede no haber entregado su historial.');
  } else if (historyBatches === 0) {
    console.warn('No se recibió un bloque de historial; se guardaron solo mensajes observados durante esta sesión.');
  }
  console.warn('El export incluye solo mensajes e historial que WhatsApp entregó a Baileys; no garantiza el historial completo del chat.');
}

main().catch((error) => {
  console.error(`❌ No se pudo exportar el chat: ${errMsg(error)}`);
  process.exitCode = 1;
});
