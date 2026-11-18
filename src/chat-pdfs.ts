import { unwrap } from './extract.ts';
import { toNumber } from './utils.ts';

export interface ChatPdfMessage {
  id: string;
  timestamp: number;
  fileName: string | undefined;
  mimetype: string | undefined;
  fileLength: number | undefined;
  message: any;
}

export function phoneNumberToJid(phone: string): string {
  const normalized = phone.trim();
  if (!/^\+?[\d\s().-]+$/.test(normalized)) {
    throw new TypeError('El teléfono debe contener solo dígitos y separadores internacionales comunes');
  }

  const digits = normalized.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) {
    throw new TypeError('El teléfono debe tener entre 8 y 15 dígitos en formato internacional');
  }

  return `${digits}@s.whatsapp.net`;
}

function isPdfDocument(document: any): boolean {
  const mimetype = typeof document?.mimetype === 'string'
    ? document.mimetype.split(';', 1)[0].trim().toLowerCase()
    : '';
  const fileName = typeof document?.fileName === 'string' ? document.fileName.trim() : '';
  return mimetype === 'application/pdf' || /\.pdf$/i.test(fileName);
}

function normalizeJid(jid: unknown): string | undefined {
  if (typeof jid !== 'string' || !jid) return undefined;
  return jid.replace(/:\d+(?=@)/, '');
}

export function collectPdfMessages(messages: any[], targetJid: string): ChatPdfMessage[] {
  const normalizedTarget = normalizeJid(targetJid);
  if (!normalizedTarget || !normalizedTarget.endsWith('@s.whatsapp.net')) {
    throw new TypeError('El chat objetivo debe ser un JID individual de WhatsApp');
  }

  const found = new Map<string, ChatPdfMessage>();
  for (const message of messages) {
    const key = message?.key;
    const messageJids = [normalizeJid(key?.remoteJid), normalizeJid(key?.remoteJidAlt)];
    if (!messageJids.includes(normalizedTarget) || typeof key?.id !== 'string' || !key.id) continue;

    const content = unwrap(message.message);
    const document = content?.documentMessage;
    if (!document || !isPdfDocument(document) || found.has(key.id)) continue;

    found.set(key.id, {
      id: key.id,
      timestamp: toNumber(message.messageTimestamp),
      fileName: typeof document.fileName === 'string' ? document.fileName : undefined,
      mimetype: typeof document.mimetype === 'string' ? document.mimetype : undefined,
      fileLength: toNumber(document.fileLength) || undefined,
      message,
    });
  }

  return [...found.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}
