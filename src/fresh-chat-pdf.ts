import { extract } from './extract.ts';
import { toNumber } from './utils.ts';

export interface FreshChatPdf {
  id: string;
  timestamp: number;
  raw: any;
}

export function collectOlderChatMessages(
  messages: any[],
  targetJid: string,
  lidAliases: Map<string, string>,
  beforeTimestamp: number,
  alreadySeen: Set<string> = new Set(),
): any[] {
  const target = normalizedJid(targetJid);
  if (!target || !target.endsWith('@s.whatsapp.net')) {
    throw new TypeError('El chat objetivo debe ser un JID individual de WhatsApp');
  }
  if (!Number.isSafeInteger(beforeTimestamp) || beforeTimestamp <= 0) {
    throw new TypeError('La fecha ancla del historial no es válida');
  }

  const found = new Map<string, any>();
  const seen = new Set(alreadySeen);
  for (const raw of messages) {
    const key = raw?.key;
    const timestamp = toNumber(raw?.messageTimestamp);
    if (
      !matchesTarget(raw, target, lidAliases)
      || typeof key?.id !== 'string'
      || !key.id
      || timestamp <= 0
      || timestamp > beforeTimestamp
    ) continue;

    const identity = `${key.fromMe === true ? 1 : 0}|${key.id}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    found.set(identity, raw);
  }

  return [...found.values()].sort((first, second) =>
    toNumber(first.messageTimestamp) - toNumber(second.messageTimestamp)
    || first.key.id.localeCompare(second.key.id),
  );
}

function normalizedJid(jid: unknown): string | undefined {
  if (typeof jid !== 'string' || !jid) return undefined;
  return jid.replace(/:\d+(?=@)/, '');
}

function matchesTarget(message: any, target: string, lidAliases: Map<string, string>): boolean {
  const jids = [
    normalizedJid(message?.key?.remoteJid),
    normalizedJid(message?.key?.remoteJidAlt),
  ].filter((jid): jid is string => !!jid);

  return jids.some((jid) => jid === target || normalizedJid(lidAliases.get(jid)) === target);
}

export function collectFreshChatPdfs(
  messages: any[],
  targetJid: string,
  lidAliases: Map<string, string>,
): FreshChatPdf[] {
  const target = normalizedJid(targetJid);
  if (!target || !target.endsWith('@s.whatsapp.net')) {
    throw new TypeError('El chat objetivo debe ser un JID individual de WhatsApp');
  }

  const found = new Map<string, FreshChatPdf>();
  for (const raw of messages) {
    const key = raw?.key;
    if (!matchesTarget(raw, target, lidAliases) || typeof key?.id !== 'string' || !key.id) continue;

    const extracted = extract(raw);
    if (
      extracted?.kind !== 'document'
      || (extracted.mimetype?.split(';', 1)[0].trim().toLowerCase() !== 'application/pdf'
        && !/\.pdf$/i.test(extracted.fileName ?? ''))
    ) continue;

    const identity = `${key.fromMe === true ? 1 : 0}|${key.id}`;
    if (found.has(identity)) continue;
    found.set(identity, {
      id: key.id,
      timestamp: toNumber(raw.messageTimestamp),
      raw,
    });
  }

  return [...found.values()].sort((first, second) =>
    first.timestamp - second.timestamp || first.id.localeCompare(second.id),
  );
}
