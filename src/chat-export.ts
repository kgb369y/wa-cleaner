import { extract, unwrap, type Kind } from './extract.ts';
import { toNumber } from './utils.ts';

export interface ChatExportMessage {
  id: string;
  timestamp: number;
  fromMe: boolean;
  kind: Kind | 'other';
  text: string;
  fileName?: string;
  mimetype?: string;
  fileLength?: number;
  hasMedia: boolean;
  raw: any;
}

const MEDIA_FIELDS: Partial<Record<Kind, string>> = {
  image: 'imageMessage',
  video: 'videoMessage',
  audio: 'audioMessage',
  document: 'documentMessage',
  sticker: 'stickerMessage',
};

function normalizeJid(jid: unknown): string | undefined {
  if (typeof jid !== 'string' || !jid) return undefined;
  return jid.replace(/:\d+(?=@)/, '');
}

export function collectChatMessages(messages: any[], targetJid: string): ChatExportMessage[] {
  const normalizedTarget = normalizeJid(targetJid);
  if (!normalizedTarget || !normalizedTarget.endsWith('@s.whatsapp.net')) {
    throw new TypeError('El chat objetivo debe ser un JID individual de WhatsApp');
  }

  const found = new Map<string, ChatExportMessage>();
  for (const raw of messages) {
    const key = raw?.key;
    const messageJids = [normalizeJid(key?.remoteJid), normalizeJid(key?.remoteJidAlt)];
    if (!messageJids.includes(normalizedTarget) || typeof key?.id !== 'string' || !key.id || found.has(key.id)) {
      continue;
    }

    const content = unwrap(raw.message);
    const extracted = extract(raw);
    const kind = extracted?.kind ?? 'other';
    const mediaField = MEDIA_FIELDS[kind as Kind];
    const media = mediaField ? content?.[mediaField] : undefined;
    const isSticker = kind === 'sticker';

    found.set(key.id, {
      id: key.id,
      timestamp: toNumber(raw.messageTimestamp),
      fromMe: key.fromMe === true,
      kind,
      text: extracted?.text ?? '',
      fileName: extracted?.fileName,
      mimetype: extracted?.mimetype ?? (isSticker ? 'image/webp' : undefined),
      fileLength: extracted?.fileLength,
      hasMedia: Boolean(media),
      raw,
    });
  }

  return [...found.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}

function safeFilePart(value: string): string {
  const filePart = value.split(/[\\/]/).pop() ?? '';
  return filePart
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
}

const MIME_EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'text/plain': 'txt',
};

export function chatAttachmentFileName(message: ChatExportMessage): string {
  const original = safeFilePart(message.fileName ?? '');
  const mime = (message.mimetype ?? '').split(';', 1)[0].trim().toLowerCase();
  const extension = MIME_EXTENSIONS[mime] ?? 'bin';
  const baseName = original || `${message.kind}.${extension}`;
  const id = safeFilePart(message.id) || 'message';
  const timestamp = Number.isSafeInteger(message.timestamp) && message.timestamp > 0 ? message.timestamp : 0;
  return `${timestamp}-${id}-${baseName}`;
}
