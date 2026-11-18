import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { unwrap } from './extract.ts';
import { reviver } from './serialize.ts';
import { toNumber } from './utils.ts';

export interface ChatAnchor {
  key: {
    id: string;
    remoteJid: string;
    fromMe: boolean;
    [key: string]: unknown;
  };
  timestamp: number;
  seenMessageIdentities: string[];
}

export interface ChatAttachment {
  id: string;
  timestamp: number;
  fromMe: boolean;
  fileName?: string;
  mimetype?: string;
  fileLength?: number;
  kind: string;
  raw: any;
}

function normalizedJid(jid: unknown): string | undefined {
  if (typeof jid !== 'string' || !jid) return undefined;
  return jid.replace(/:\d+(?=@)/, '');
}

function mediaDetails(message: any): Omit<ChatAttachment, 'id' | 'timestamp' | 'fromMe' | 'raw'> | undefined {
  const content = unwrap(message?.message);
  const fields: [string, string][] = [
    ['imageMessage', 'image'],
    ['videoMessage', 'video'],
    ['audioMessage', 'audio'],
    ['documentMessage', 'document'],
  ];
  for (const [field, kind] of fields) {
    const media = content?.[field];
    if (!media || typeof media !== 'object') continue;
    return {
      kind,
      fileName: typeof media.fileName === 'string' ? media.fileName : undefined,
      mimetype: typeof media.mimetype === 'string' ? media.mimetype : undefined,
      fileLength: toNumber(media.fileLength) || undefined,
    };
  }
  return undefined;
}

export function matchesPhoneChat(message: any, targetJid: string, lidAliases: Map<string, string>): boolean {
  const target = normalizedJid(targetJid);
  if (!target || !target.endsWith('@s.whatsapp.net')) return false;
  const jids = [message?.key?.remoteJid, message?.key?.remoteJidAlt]
    .map(normalizedJid)
    .filter((jid): jid is string => !!jid);
  return jids.some((jid) => jid === target || normalizedJid(lidAliases.get(jid)) === target);
}

export async function findNewestChatAnchor(
  capturePath: string,
  targetJid: string,
  lidAliases: Map<string, string>,
): Promise<ChatAnchor> {
  const target = normalizedJid(targetJid);
  if (!target || !target.endsWith('@s.whatsapp.net')) {
    throw new TypeError('El chat objetivo debe ser un JID individual de WhatsApp');
  }

  let newest: { key: any; timestamp: number } | undefined;
  const seenMessageIdentities = new Set<string>();
  const lines = createInterface({ input: createReadStream(capturePath), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    if (!line.trim()) continue;
    let message: any;
    try {
      message = (JSON.parse(line) as { message?: any }).message;
    } catch (error) {
      throw new Error(`Línea ${lineNumber} inválida en captura: ${error instanceof Error ? error.message : error}`);
    }

    const key = message?.key;
    const timestamp = toNumber(message?.messageTimestamp);
    if (
      !matchesPhoneChat(message, target, lidAliases)
      || typeof key?.id !== 'string'
      || !key.id
    ) continue;

    seenMessageIdentities.add(`${key.fromMe === true ? 1 : 0}|${key.id}`);
    if (timestamp <= 0 || (newest && timestamp <= newest.timestamp)) continue;
    newest = {
      key: {
        ...key,
        remoteJid: target,
      },
      timestamp,
    };
  }

  if (!newest) throw new Error('La captura no contiene un mensaje utilizable del contacto objetivo para anclar el historial.');
  return { ...newest, seenMessageIdentities: [...seenMessageIdentities] };
}

export async function readCapturedChatAttachments(
  capturePath: string,
  targetJid: string,
  lidAliases: Map<string, string>,
): Promise<ChatAttachment[]> {
  const found = new Map<string, ChatAttachment>();
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

    const key = message?.key;
    if (!matchesPhoneChat(message, targetJid, lidAliases) || typeof key?.id !== 'string' || !key.id) continue;
    const details = mediaDetails(message);
    if (!details) continue;

    const identity = `${key.fromMe === true ? 1 : 0}|${key.id}`;
    if (found.has(identity)) continue;
    found.set(identity, {
      id: key.id,
      timestamp: toNumber(message.messageTimestamp),
      fromMe: key.fromMe === true,
      ...details,
      raw: message,
    });
  }
  return [...found.values()].sort((first, second) =>
    first.timestamp - second.timestamp || first.id.localeCompare(second.id),
  );
}

export function collectOlderChatMessages(
  messages: any[],
  targetJid: string,
  lidAliases: Map<string, string>,
  beforeTimestamp: number,
  alreadySeen: Set<string>,
): any[] {
  const found = new Map<string, any>();
  for (const raw of messages) {
    const key = raw?.key;
    const timestamp = toNumber(raw?.messageTimestamp);
    const identity = typeof key?.id === 'string'
      ? `${key.fromMe === true ? 1 : 0}|${key.id}`
      : '';
    if (
      !identity
      || alreadySeen.has(identity)
      || !matchesPhoneChat(raw, targetJid, lidAliases)
      || timestamp <= 0
      || timestamp > beforeTimestamp
    ) continue;
    found.set(identity, raw);
  }
  return [...found.values()].sort((first, second) =>
    toNumber(first.messageTimestamp) - toNumber(second.messageTimestamp)
    || first.key.id.localeCompare(second.key.id),
  );
}

export function collectChatAttachments(
  messages: any[],
  targetJid: string,
  lidAliases: Map<string, string>,
): ChatAttachment[] {
  const found = new Map<string, ChatAttachment>();
  for (const raw of messages) {
    const key = raw?.key;
    if (
      !matchesPhoneChat(raw, targetJid, lidAliases)
      || typeof key?.id !== 'string'
      || !key.id
    ) continue;
    const details = mediaDetails(raw);
    if (!details) continue;

    const identity = `${key.fromMe === true ? 1 : 0}|${key.id}`;
    if (found.has(identity)) continue;
    found.set(identity, {
      id: key.id,
      timestamp: toNumber(raw.messageTimestamp),
      fromMe: key.fromMe === true,
      ...details,
      raw,
    });
  }
  return [...found.values()].sort((first, second) =>
    first.timestamp - second.timestamp || first.id.localeCompare(second.id),
  );
}

export interface DetectedFileType {
  extension: string;
  mimetype: string;
  description: string;
}

const SIGNATURE_TYPES: { match: (bytes: Buffer) => boolean; type: DetectedFileType }[] = [
  { match: (bytes) => bytes.subarray(0, 5).toString('ascii') === '%PDF-', type: { extension: 'pdf', mimetype: 'application/pdf', description: 'PDF' } },
  { match: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), type: { extension: 'png', mimetype: 'image/png', description: 'PNG' } },
  { match: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff, type: { extension: 'jpg', mimetype: 'image/jpeg', description: 'JPEG/JFIF' } },
  { match: (bytes) => ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')), type: { extension: 'gif', mimetype: 'image/gif', description: 'GIF' } },
  { match: (bytes) => bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP', type: { extension: 'webp', mimetype: 'image/webp', description: 'WebP' } },
  { match: (bytes) => bytes.subarray(4, 8).toString('ascii') === 'ftyp', type: { extension: 'mp4', mimetype: 'video/mp4', description: 'MP4' } },
  { match: (bytes) => bytes.subarray(0, 4).toString('ascii') === 'PK\u0003\u0004', type: { extension: 'zip', mimetype: 'application/zip', description: 'ZIP / contenedor Office' } },
  { match: (bytes) => bytes.subarray(0, 4).toString('ascii') === 'Rar!', type: { extension: 'rar', mimetype: 'application/vnd.rar', description: 'RAR' } },
  { match: (bytes) => bytes.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])), type: { extension: '7z', mimetype: 'application/x-7z-compressed', description: '7-Zip' } },
  { match: (bytes) => bytes.subarray(0, 3).toString('ascii') === 'ID3', type: { extension: 'mp3', mimetype: 'audio/mpeg', description: 'MP3' } },
  { match: (bytes) => bytes.subarray(0, 4).toString('ascii') === 'OggS', type: { extension: 'ogg', mimetype: 'audio/ogg', description: 'Ogg' } },
  { match: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), type: { extension: 'ole', mimetype: 'application/x-ole-storage', description: 'OLE / Office antiguo' } },
];

export function detectFileType(bytes: Buffer): DetectedFileType | undefined {
  return SIGNATURE_TYPES.find(({ match }) => match(bytes))?.type;
}

export function detectDeclaredFileType(attachment: ChatAttachment): DetectedFileType | undefined {
  const mimetype = (attachment.mimetype ?? '').split(';', 1)[0].trim().toLowerCase();
  const extension = attachment.fileName?.split('.').pop()?.trim().toLowerCase();
  const known: Record<string, DetectedFileType> = {
    pdf: { extension: 'pdf', mimetype: 'application/pdf', description: 'PDF (declarado por WhatsApp)' },
    jpg: { extension: 'jpg', mimetype: 'image/jpeg', description: 'JPEG (declarado por WhatsApp)' },
    jpeg: { extension: 'jpg', mimetype: 'image/jpeg', description: 'JPEG (declarado por WhatsApp)' },
    jfif: { extension: 'jpg', mimetype: 'image/jpeg', description: 'JPEG/JFIF (declarado por WhatsApp)' },
    png: { extension: 'png', mimetype: 'image/png', description: 'PNG (declarado por WhatsApp)' },
    webp: { extension: 'webp', mimetype: 'image/webp', description: 'WebP (declarado por WhatsApp)' },
    gif: { extension: 'gif', mimetype: 'image/gif', description: 'GIF (declarado por WhatsApp)' },
    mp4: { extension: 'mp4', mimetype: 'video/mp4', description: 'MP4 (declarado por WhatsApp)' },
    mp3: { extension: 'mp3', mimetype: 'audio/mpeg', description: 'MP3 (declarado por WhatsApp)' },
    ogg: { extension: 'ogg', mimetype: 'audio/ogg', description: 'Ogg (declarado por WhatsApp)' },
    doc: { extension: 'doc', mimetype: 'application/msword', description: 'Word DOC (declarado por WhatsApp)' },
    docx: { extension: 'docx', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', description: 'Word DOCX (declarado por WhatsApp)' },
    xls: { extension: 'xls', mimetype: 'application/vnd.ms-excel', description: 'Excel XLS (declarado por WhatsApp)' },
    xlsx: { extension: 'xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', description: 'Excel XLSX (declarado por WhatsApp)' },
    ppt: { extension: 'ppt', mimetype: 'application/vnd.ms-powerpoint', description: 'PowerPoint PPT (declarado por WhatsApp)' },
    pptx: { extension: 'pptx', mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', description: 'PowerPoint PPTX (declarado por WhatsApp)' },
    zip: { extension: 'zip', mimetype: 'application/zip', description: 'ZIP (declarado por WhatsApp)' },
  };
  if (extension && known[extension]) return known[extension];
  if (mimetype === 'application/pdf') return known.pdf;
  if (mimetype === 'image/jpeg') return known.jpg;
  if (mimetype === 'image/png') return known.png;
  if (mimetype === 'image/webp') return known.webp;
  if (mimetype === 'application/zip') return known.zip;
  return undefined;
}

export function isExpectedFileSignature(bytes: Buffer, type: DetectedFileType): boolean {
  const detected = detectFileType(bytes);
  if (detected) {
    if (type.extension === 'docx' || type.extension === 'xlsx' || type.extension === 'pptx') {
      return detected.extension === 'zip';
    }
    if (type.extension === 'doc' || type.extension === 'xls' || type.extension === 'ppt') {
      return detected.extension === 'ole';
    }
    return detected.extension === type.extension;
  }
  return false;
}

export function safeAttachmentBaseName(fileName: string | undefined, id: string): string {
  const base = (fileName ? fileName.replace(/[\\/]/g, '_').replace(/\.[^.]*$/, '') : '')
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 100);
  const safeId = id.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 40) || 'message';
  return `${safeId}-${base || 'attachment'}`;
}

export function unwrapMediaContent(message: any): any {
  const content = unwrap(message?.message);
  return content?.imageMessage
    ?? content?.videoMessage
    ?? content?.audioMessage
    ?? content?.documentMessage
    ?? undefined;
}
