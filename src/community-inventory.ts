// Inventario de comunidades y grupos vinculados. Solo lectura; no guarda mensajes ni los borra.

import { config } from './config.ts';
import { normalizeText, sleep, shortJid } from './utils.ts';
import { printQr, startWhatsApp, type WaClient } from './whatsapp.ts';

const COMMUNITY_NAMES = [
  'TESLA CLUB MEDELLIN',
  'TESLA COLOMBIA MOTORS CLUB',
];
const CONNECTION_TIMEOUT_MS = 3 * 60_000;
const HISTORY_IDLE_MS = 45_000;
const NO_HISTORY_WAIT_MS = 60_000;

interface ChatRecord {
  id: string;
  name: string;
}

async function main() {
  const chats = new Map<string, ChatRecord>();
  const messageCounts = new Map<string, number>();
  let opened = false;
  let openedAt = 0;
  let lastHistoryAt = 0;
  let historyEvents = 0;
  let fatalReason: string | undefined;

  console.log('\nInventario de comunidades de WhatsApp (solo lectura)');
  console.log('No se guardarán mensajes en SQLite ni se enviarán a Telegram.');
  console.log('La sesión de vinculación se conserva en auth/.\n');

  const wa: WaClient = await startWhatsApp({
    authDir: config.authDir,
    syncFullHistory: config.syncFullHistory,
    logLevel: config.logLevel,
    handlers: {
      onQr: (qr) => {
        console.log('Escanea este QR desde WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo:');
        printQr(qr);
      },
      onOpen: () => {
        if (!opened) {
          opened = true;
          openedAt = Date.now();
          console.log('WhatsApp conectado; recopilando nombres de chats e historial disponible…');
        }
      },
      onClose: (code) => {
        opened = false;
        console.log(`Conexión cerrada (código ${code ?? '?'}); Baileys intentará reconectar.`);
      },
      onFatal: (_code, reason) => {
        fatalReason = reason;
      },
      onChats: (items) => {
        for (const item of items) {
          if (typeof item?.id !== 'string') continue;
          const name = item.name ?? item.displayName ?? item.subject;
          if (typeof name === 'string' && name.trim()) {
            chats.set(item.id, { id: item.id, name: name.trim() });
          }
        }
      },
      onMessages: (messages, source) => {
        if (source !== 'history') return;
        historyEvents++;
        lastHistoryAt = Date.now();
        for (const message of messages) {
          const jid = message?.key?.remoteJid;
          if (typeof jid === 'string') messageCounts.set(jid, (messageCounts.get(jid) ?? 0) + 1);
        }
      },
      onHistoryProgress: ({ progress }) => {
        if (progress != null) console.log(`Historial: ${progress}%`);
      },
    },
  });

  try {
    const connectionStartedAt = Date.now();
    while (!opened && !fatalReason && Date.now() - connectionStartedAt < CONNECTION_TIMEOUT_MS) {
      await sleep(500);
    }
    if (fatalReason) throw new Error(fatalReason);
    if (!opened) {
      throw new Error('WhatsApp no se conectó en 3 minutos. No se pudo consultar el inventario.');
    }

    const maxWaitMs = config.checkMaxWaitMinutes * 60_000;
    while (opened && Date.now() - openedAt < maxWaitMs) {
      const now = Date.now();
      if (historyEvents === 0 && now - openedAt > NO_HISTORY_WAIT_MS) break;
      if (historyEvents > 0 && now - lastHistoryAt > HISTORY_IDLE_MS) break;
      if (fatalReason) throw new Error(fatalReason);
      await sleep(1000);
    }

    const candidates = [...chats.values()].filter((chat) => {
      const normalized = normalizeText(chat.name);
      return COMMUNITY_NAMES.some((name) => normalized.includes(normalizeText(name)));
    });

    if (!candidates.length) {
      console.log('No encontré comunidades con esos nombres entre los chats recibidos por WhatsApp.');
      console.log('Comprueba que la cuenta vinculada tenga acceso y que Baileys haya recibido la lista de chats.');
      return;
    }

    const report: Array<{
      Comunidad: string;
      Grupo: string;
      JID: string;
      'Mensajes en historial recibido': number;
      'Destacados identificables': string;
    }> = [];
    const seenCommunities = new Set<string>();

    for (const candidate of candidates) {
      if (seenCommunities.has(candidate.id)) continue;
      seenCommunities.add(candidate.id);
      const result = await wa.fetchLinkedGroups(candidate.id);
      const communityName = chats.get(result.communityJid)?.name ?? candidate.name;
      if (!result.linkedGroups.length) {
        report.push({
          Comunidad: communityName,
          Grupo: '(sin grupos vinculados devueltos por WhatsApp)',
          JID: shortJid(candidate.id),
          'Mensajes en historial recibido': 0,
          'Destacados identificables': 'no verificable',
        });
        continue;
      }

      for (const group of result.linkedGroups) {
        const jid = group.id;
        report.push({
          Comunidad: communityName,
          Grupo: group.subject || '(sin nombre)',
          JID: jid ? shortJid(jid) : '(sin JID)',
          'Mensajes en historial recibido': jid ? messageCounts.get(jid) ?? 0 : 0,
          'Destacados identificables': 'no expuestos de forma fiable por Baileys',
        });
      }
    }

    console.log('\nGrupos vinculados detectados:');
    console.table(report);
    console.log(`Eventos de historial recibidos: ${historyEvents}. Los conteos son solo del historial observado en esta ejecución.`);
    console.log('No se borró ni persistió ningún mensaje. Este inventario no demuestra cuáles mensajes están destacados.');
  } finally {
    await wa.stop();
  }
}

main().catch((error) => {
  console.error('Error en inventario:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
