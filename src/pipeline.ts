// Flujo de rescate: (1) ingest = evalúa mensajes y los mete en cola; (2) processJob = descarga y envía a Telegram.
// No depende de Baileys: la descarga de media llega inyectada, así es fácil de probar.

import type { Rules } from './config.ts';
import type { Job, NewJob, Store } from './db.ts';
import { extract, fileNameFor } from './extract.ts';
import type { makeEvaluator } from './rules.ts';
import { parseMessage, serializeMessage } from './serialize.ts';
import { TelegramError, type Telegram } from './telegram.ts';
import {
  errMsg,
  formatDate,
  MAX_MEDIA_BYTES,
  MediaTooLargeError,
  log,
  shortJid,
  stripDevice,
  toNumber,
} from './utils.ts';

const isGroup = (jid: string) => jid.endsWith('@g.us');

export function isSelfChat(jid: string, alt: string | undefined, selfIds: string[]): boolean {
  const set = new Set(selfIds.map(stripDevice));
  return set.has(stripDevice(jid)) || (!!alt && set.has(stripDevice(alt)));
}

/** ID estable del mensaje (no depende de si el chat viene como número o como LID). */
export const messageId = (m: any): string => `${m.key?.fromMe ? 1 : 0}|${m.key?.id}`;

// ------------------------------------------------------------------ ingest

export interface IngestDeps {
  store: Store;
  evaluate: ReturnType<typeof makeEvaluator>;
  selfIds: string[];
  getName: (jid: string) => string | undefined;
}

export interface IngestStats {
  seen: number;
  matched: number;
  added: number;
  byRule: Record<string, number>;
}

export function ingest(deps: IngestDeps, msgs: any[]): IngestStats {
  const stats: IngestStats = { seen: 0, matched: 0, added: 0, byRule: {} };
  const jobs: NewJob[] = [];

  for (const m of msgs) {
    stats.seen++;
    const jid: string | undefined = m?.key?.remoteJid;
    if (!jid || !m.key?.id) continue;
    if (jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;

    const ex = extract(m);
    if (!ex) continue;

    const chatName = deps.getName(jid) ?? null;
    const decision = deps.evaluate(ex, {
      chatJid: jid,
      chatName,
      isSelfChat: isSelfChat(jid, m.key?.remoteJidAlt, deps.selfIds),
    });
    if (!decision) continue;

    stats.matched++;
    stats.byRule[decision.rule] = (stats.byRule[decision.rule] ?? 0) + 1;
    jobs.push({
      id: messageId(m),
      chat_jid: jid,
      chat_name: chatName,
      sender: m.pushName ?? null,
      ts: toNumber(m.messageTimestamp),
      rule: decision.rule,
      with_media: decision.withMedia,
      payload: serializeMessage(m),
    });
  }

  stats.added = deps.store.enqueueMany(jobs);
  return stats;
}

// -------------------------------------------------------------- processJob

export interface ProcessDeps {
  store: Store;
  tg: Telegram;
  rules: Rules;
  tz: string;
  download: (raw: any, maxBytes: number) => Promise<Buffer>;
  chatName: (jid: string) => Promise<string | undefined>;
}

export function buildCaption(header: string, text: string, limit = 1000): { caption: string; overflow?: string } {
  if (!text.trim()) return { caption: header };
  const full = `${header}\n\n${text}`;
  if (full.length <= limit) return { caption: full };
  return { caption: header, overflow: text };
}

export type JobResult = 'done' | 'skipped' | 'retry' | 'failed';

/** Procesa un trabajo. Lanza TelegramError solo si es fatal (el worker debe detenerse). */
export async function processJob(deps: ProcessDeps, job: Job): Promise<JobResult> {
  const { store, tg, rules } = deps;
  const maxAttempts = rules.limits.maxAttempts;

  try {
    const raw = parseMessage(job.payload);
    const ex = extract(raw);
    if (!ex) {
      store.markSkipped(job.id, 'sin_contenido');
      return 'skipped';
    }

    const chat = (await deps.chatName(job.chat_jid)) ?? job.chat_name ?? shortJid(job.chat_jid);
    const who = raw.key?.fromMe ? 'yo' : (raw.pushName ?? shortJid(raw.key?.participant ?? job.chat_jid));
    const header =
      `📥 ${chat}${isGroup(job.chat_jid) ? ` · ${who}` : ''}\n` +
      `🗓 ${formatDate(job.ts, deps.tz)} · 🏷 ${job.rule}`;

    if (job.with_media && ex.hasMedia) {
      const maxBytes = Math.min(rules.rescue.maxFileSizeMB * 1024 * 1024, MAX_MEDIA_BYTES);
      const tooBig = async (size: number) => {
        if (size > MAX_MEDIA_BYTES) {
          const warning = `ARCHIVO MAYOR A 100 MB OMITIDO: ${ex.fileName ?? ex.kind} (${(size / 1048576).toFixed(1)} MB)`;
          for (let i = 0; i < 10; i++) {
            log(`${'!'.repeat(24)} ${warning} ${'!'.repeat(24)}`);
          }
          store.markSkipped(job.id, 'archivo_mayor_a_100_mb');
          return 'skipped' as const;
        }
        await tg.sendText(
          `${header}\n\n⚠️ Archivo demasiado grande para Telegram (${(size / 1048576).toFixed(1)} MB). ` +
            `Sigue en WhatsApp: ${ex.fileName ?? ex.kind}`,
        );
        store.markSkipped(job.id, 'archivo_muy_grande');
        return 'skipped' as const;
      };
      const { caption, overflow } = buildCaption(header, ex.text);
      let tgId = job.telegram_message_id;
      if (tgId == null) {
        if (ex.fileLength && ex.fileLength > maxBytes) return await tooBig(ex.fileLength);

        let buf: Buffer;
        try {
          buf = await deps.download(raw, maxBytes);
        } catch (e) {
          if (e instanceof MediaTooLargeError) return await tooBig(e.sizeBytes);
          throw e;
        }
        if (buf.length > maxBytes) return await tooBig(buf.length);

        tgId = await tg.sendDocument(buf, fileNameFor(ex, job.ts), ex.mimetype, caption);
        store.markDeliveryProgress(job.id, tgId);
      }
      if (overflow) await tg.sendText(`${header}\n\n${overflow}`);
      store.markDone(job.id, tgId);
      return 'done';
    }

    const tgId = await tg.sendText(`${header}\n\n${ex.text}`);
    store.markDone(job.id, tgId);
    return 'done';
  } catch (e) {
    if (e instanceof TelegramError && e.fatal) throw e;
    store.markAttemptFailed(job.id, errMsg(e), maxAttempts);
    return job.attempts + 1 >= maxAttempts ? 'failed' : 'retry';
  }
}
