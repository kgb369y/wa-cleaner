// Conexión a WhatsApp (Baileys). ÚNICO archivo que importa Baileys.
// Este programa SOLO LEE: nunca envía mensajes ni borra nada en WhatsApp.
//
// Si instalaste el paquete con scope (@whiskeysockets/baileys) en vez de "baileys",
// cambia el nombre en el import de abajo y en nada más.

import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from 'baileys';
import fs from 'node:fs';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { errMsg, log, MAX_MEDIA_BYTES, MediaTooLargeError, stripDevice } from './utils.ts';

export interface WaClient {
  sock(): any;
  /** Identificadores propios (número y LID), sin sufijo de dispositivo. */
  selfIds(): string[];
  /** Nombre conocido de un chat/contacto (viene del historial/contactos; puede faltar). */
  getName(jid: string): string | undefined;
  /** Igual que getName pero consulta los metadatos si es un grupo. */
  resolveChatName(jid: string): Promise<string | undefined>;
  /** Lista de grupos vinculados a una comunidad; no modifica la comunidad. */
  fetchLinkedGroups(jid: string): Promise<{
    communityJid: string;
    isCommunity: boolean;
    linkedGroups: { id: string | undefined; subject: string }[];
  }>;
  download(raw: any, maxBytes: number): Promise<Buffer>;
  stop(): Promise<void>;
}

export interface WaHandlers {
  onQr?(qr: string): void;
  onOpen?(c: WaClient): void;
  onClose?(code: number | undefined): void;
  /** source: 'history' | 'notify' | 'append' */
  onMessages?(msgs: any[], source: string, c: WaClient): void;
  onChats?(chats: any[], source: string): void;
  onHistoryProgress?(info: { progress?: number | null; isLatest?: boolean; messages: number }): void;
  /** Sesión cerrada desde el teléfono, reemplazada, etc.: no se reintenta. */
  onFatal?(code: number, reason: string): void;
}

export function printQr(qr: string) {
  qrcode.generate(qr, { small: true });
}

export async function startWhatsApp(opts: {
  authDir: string;
  syncFullHistory: boolean;
  logLevel?: string;
  handlers: WaHandlers;
}): Promise<WaClient> {
  const { handlers } = opts;
  fs.mkdirSync(opts.authDir, { recursive: true, mode: 0o700 });
  const logger = pino({ level: opts.logLevel ?? 'silent' });
  const { state, saveCreds } = await useMultiFileAuthState(opts.authDir);

  let current: any;
  let stopped = false;
  let attempts = 0;
  let timer: NodeJS.Timeout | undefined;
  const names = new Map<string, string>();
  const groupCache = new Map<string, string>();

  const safe = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      log('⚠️ Error en un handler:', errMsg(e));
    }
  };

  const remember = (ids: unknown[], name: unknown) => {
    if (typeof name !== 'string' || !name.trim()) return;
    for (const id of ids) if (typeof id === 'string' && id) names.set(id, name.trim());
  };

  const client: WaClient = {
    sock: () => current,
    selfIds: () =>
      [...new Set([current?.user?.id, current?.user?.lid, state.creds.me?.id, (state.creds.me as any)?.lid]
        .filter((x): x is string => typeof x === 'string' && x.length > 0)
        .map(stripDevice))],
    getName: (jid) => names.get(jid) ?? groupCache.get(jid),
    resolveChatName: async (jid) => {
      const known = names.get(jid) ?? groupCache.get(jid);
      if (known || !jid.endsWith('@g.us') || !current) return known;
      try {
        const md = await current.groupMetadata(jid);
        if (md?.subject) groupCache.set(jid, md.subject);
      } catch {
        /* sin nombre */
      }
      return groupCache.get(jid);
    },
    fetchLinkedGroups: async (jid) => {
      if (!current) throw new Error('WhatsApp no está conectado');
      return current.communityFetchLinkedGroups(jid);
    },
    download: async (raw, maxBytes) => {
      if (!current) throw new Error('WhatsApp no está conectado');
      const stream = await downloadMediaMessage(raw, 'stream', {}, {
        logger,
        reuploadRequest: current.updateMediaMessage,
      } as any);
      const chunks: Buffer[] = [];
      let size = 0;
      let exceedsConfiguredLimit = false;
      for await (const chunk of stream) {
        size += Buffer.isBuffer(chunk) ? chunk.length : chunk.byteLength;
        if (size > MAX_MEDIA_BYTES) {
          stream.destroy();
          throw new MediaTooLargeError(size, MAX_MEDIA_BYTES);
        }
        if (size > maxBytes) {
          exceedsConfiguredLimit = true;
          chunks.length = 0;
          continue;
        }
        if (!exceedsConfiguredLimit) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      }
      if (exceedsConfiguredLimit) throw new MediaTooLargeError(size, maxBytes);
      return Buffer.concat(chunks, size);
    },
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        current?.end(undefined);
      } catch {
        /* ya cerrado */
      }
    },
  };

  async function connect() {
    let version: any;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      /* se usa la versión que trae la librería */
    }

    const sock: any = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      // Navegador "escritorio": necesario para que el teléfono envíe más historial al vincular.
      browser: Browsers.macOS('Chrome'),
      syncFullHistory: opts.syncFullHistory,
      markOnlineOnConnect: false, // no apareces "en línea" por el bot
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    } as any);
    current = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u: any) => {
      if (u.qr) safe(() => (handlers.onQr ?? printQr)(u.qr));

      if (u.connection === 'open') {
        attempts = 0;
        safe(() => handlers.onOpen?.(client));
      }

      if (u.connection === 'close') {
        const code: number | undefined = u.lastDisconnect?.error?.output?.statusCode;
        safe(() => handlers.onClose?.(code));
        if (stopped) return;

        if (code === DisconnectReason.loggedOut) {
          safe(() =>
            handlers.onFatal?.(
              code,
              'La sesión fue cerrada (desvinculada desde el teléfono). Borra la carpeta auth/ y vuelve a vincular.',
            ),
          );
          return;
        }
        if (code === DisconnectReason.connectionReplaced) {
          safe(() =>
            handlers.onFatal?.(
              code,
              'Otra instancia usó la misma sesión (¿tienes dos procesos corriendo?). Cierra el otro y reinicia.',
            ),
          );
          return;
        }

        const delay = code === DisconnectReason.restartRequired ? 500 : Math.min(60_000, 2000 * 2 ** attempts++);
        log(`Conexión cerrada (código ${code ?? '?'}). Reintento en ${Math.round(delay / 1000)} s…`);
        timer = setTimeout(() => {
          if (!stopped) connect().catch((e) => log('⚠️ Error al reconectar:', errMsg(e)));
        }, delay);
      }
    });

    sock.ev.on('messaging-history.set', (h: any) => {
      for (const c of h.chats ?? []) remember([c.id, c.lidJid, c.pnJid], c.name ?? c.displayName);
      for (const c of h.contacts ?? []) remember([c.id, c.lid, c.phoneNumber], c.name ?? c.notify ?? c.verifiedName);
      safe(() => handlers.onChats?.(h.chats ?? [], 'history'));
      const msgs: any[] = h.messages ?? [];
      safe(() => handlers.onMessages?.(msgs, 'history', client));
      safe(() => handlers.onHistoryProgress?.({ progress: h.progress, isLatest: h.isLatest, messages: msgs.length }));
    });

    sock.ev.on('contacts.upsert', (list: any[]) => {
      for (const c of list ?? []) remember([c.id, c.lid, c.phoneNumber], c.name ?? c.notify ?? c.verifiedName);
    });
    sock.ev.on('chats.upsert', (list: any[]) => {
      for (const c of list ?? []) remember([c.id, c.lidJid, c.pnJid], c.name ?? c.displayName);
      safe(() => handlers.onChats?.(list ?? [], 'upsert'));
    });

    sock.ev.on('messages.upsert', ({ messages, type }: any) => {
      safe(() => handlers.onMessages?.(messages ?? [], type ?? 'notify', client));
    });
  }

  await connect();
  return client;
}
