import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { extract, unwrap, type Kind } from './extract.ts';
import { reviver } from './serialize.ts';
import { toNumber } from './utils.ts';

export interface CapturedChatMessage {
  id: string;
  timestamp: number;
  fromMe: boolean;
  sender?: string;
  kind: Kind | 'other';
  text: string;
  fileName?: string;
  mimetype?: string;
  fileLength?: number;
  hasMedia: boolean;
  raw: any;
}

function normalizedJid(jid: unknown): string | undefined {
  if (typeof jid !== 'string' || !jid) return undefined;
  return jid.replace(/:\d+(?=@)/, '');
}

function messageAliases(message: any, lidAliases: Map<string, string>): string[] {
  const aliases = new Set(
    [normalizedJid(message?.key?.remoteJid), normalizedJid(message?.key?.remoteJidAlt)]
      .filter((jid): jid is string => !!jid),
  );
  for (const alias of [...aliases]) {
    const mapped = lidAliases.get(alias);
    if (mapped) aliases.add(mapped);
  }
  return [...aliases];
}

function restoreBase64MediaBytes(message: any): void {
  const content = unwrap(message?.message);
  const media = content?.imageMessage
    ?? content?.videoMessage
    ?? content?.audioMessage
    ?? content?.documentMessage
    ?? content?.stickerMessage;
  if (!media) return;

  for (const field of ['mediaKey', 'fileSha256', 'fileEncSha256', 'jpegThumbnail']) {
    const value = media[field];
    if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) continue;
    const bytes = Buffer.from(value, 'base64');
    if (field !== 'jpegThumbnail' && bytes.length !== 32) continue;
    media[field] = bytes;
  }
}

export async function readCapturedChat(
  capturePath: string,
  targetJid: string,
  lidAliases: Map<string, string>,
): Promise<CapturedChatMessage[]> {
  const target = normalizedJid(targetJid);
  if (!target || !target.endsWith('@s.whatsapp.net')) {
    throw new TypeError('El chat objetivo debe ser un JID individual de WhatsApp');
  }

  const allowedJids = new Set([target]);
  for (const [lid, phone] of lidAliases) {
    if (normalizedJid(phone) === target) allowedJids.add(normalizedJid(lid)!);
  }

  const found = new Map<string, CapturedChatMessage>();
  const lines = createInterface({ input: createReadStream(capturePath), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    if (!line.trim()) continue;

    let message: any;
    try {
      message = (JSON.parse(line, reviver) as { message?: any }).message;
    } catch (error) {
      throw new Error(`Línea ${lineNumber} inválida en captura: ${error instanceof Error ? error.message : error}`);
    }

    if (!message || !messageAliases(message, lidAliases).some((jid) => allowedJids.has(jid))) continue;
    const key = message?.key;
    if (typeof key?.id !== 'string' || !key.id) continue;

    const identity = `${key.fromMe === true ? 1 : 0}|${key.id}`;
    if (found.has(identity)) continue;

    restoreBase64MediaBytes(message);
    const extracted = extract(message);
    const content = unwrap(message.message);
    const sticker = Boolean(content?.stickerMessage);
    found.set(identity, {
      id: key.id,
      timestamp: toNumber(message.messageTimestamp),
      fromMe: key.fromMe === true,
      sender: typeof message.pushName === 'string' ? message.pushName : undefined,
      kind: extracted?.kind ?? 'other',
      text: extracted?.text ?? '',
      fileName: extracted?.fileName,
      mimetype: extracted?.mimetype ?? (sticker ? 'image/webp' : undefined),
      fileLength: extracted?.fileLength,
      hasMedia: Boolean(extracted?.hasMedia || sticker),
      raw: message,
    });
  }

  return [...found.values()].sort((first, second) =>
    first.timestamp - second.timestamp || first.id.localeCompare(second.id),
  );
}
