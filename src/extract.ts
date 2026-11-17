// Extracción de contenido de un mensaje crudo de WhatsApp. Módulo puro (sin dependencias).

export type Kind = 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker';

export interface Extracted {
  kind: Kind;
  /** Texto del mensaje o pie de foto/documento ('' si no hay). */
  text: string;
  fileName?: string;
  mimetype?: string;
  fileLength?: number;
  hasMedia: boolean;
}

const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
];

/** Quita las "envolturas" (mensajes temporales, ver una vez, etc.). */
export function unwrap(content: any): any {
  let cur = content;
  for (let i = 0; i < 5 && cur; i++) {
    const w = WRAPPERS.find((k) => cur[k]?.message);
    if (!w) break;
    cur = cur[w].message;
  }
  return cur;
}

const len = (x: any): number | undefined => {
  if (x == null) return undefined;
  if (typeof x === 'number') return x;
  if (typeof x === 'object' && 'low' in x) return (x.high >>> 0) * 4294967296 + (x.low >>> 0);
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
};

export function extract(raw: any): Extracted | null {
  const m = unwrap(raw?.message);
  if (!m) return null;

  if (typeof m.conversation === 'string' && m.conversation) {
    return { kind: 'text', text: m.conversation, hasMedia: false };
  }
  if (m.extendedTextMessage) {
    return { kind: 'text', text: m.extendedTextMessage.text ?? '', hasMedia: false };
  }
  if (m.imageMessage) {
    const x = m.imageMessage;
    return { kind: 'image', text: x.caption ?? '', mimetype: x.mimetype, fileLength: len(x.fileLength), hasMedia: true };
  }
  if (m.videoMessage) {
    const x = m.videoMessage;
    return { kind: 'video', text: x.caption ?? '', mimetype: x.mimetype, fileLength: len(x.fileLength), hasMedia: true };
  }
  if (m.audioMessage) {
    const x = m.audioMessage;
    return { kind: 'audio', text: '', mimetype: x.mimetype, fileLength: len(x.fileLength), hasMedia: true };
  }
  if (m.documentMessage) {
    const x = m.documentMessage;
    return {
      kind: 'document',
      text: x.caption ?? '',
      fileName: x.fileName ?? undefined,
      mimetype: x.mimetype,
      fileLength: len(x.fileLength),
      hasMedia: true,
    };
  }
  if (m.stickerMessage) {
    return { kind: 'sticker', text: '', hasMedia: false };
  }
  return null; // reacciones, protocolo, encuestas, etc.: no nos interesan en esta fase
}

const MIME_EXT: Record<string, string> = {
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

/** Nombre de archivo para Telegram. */
export function fileNameFor(ex: Extracted, tsSec: number): string {
  if (ex.fileName && ex.fileName.trim()) return ex.fileName.replace(/[\\/:*?"<>|]/g, '_');
  const mime = (ex.mimetype ?? '').split(';')[0].trim().toLowerCase();
  return `${ex.kind}-${tsSec}.${MIME_EXT[mime] ?? 'bin'}`;
}
