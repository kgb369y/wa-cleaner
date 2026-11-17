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
  let chatsReceived = 0;
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
        chatsReceived += items.length;
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

    const participatingGroups = await wa.fetchParticipatingGroups();
    const participatingGroupIds = new Set(participatingGroups.map((group) => group.id));
    const candidates = new Map<string, ChatRecord>();

    for (const chat of chats.values()) {
      if (participatingGroupIds.has(chat.id) &&
          COMMUNITY_NAMES.some((name) => normalizeText(chat.name).includes(normalizeText(name)))) {
        candidates.set(chat.id, chat);
      }
    }
    for (const group of participatingGroups) {
      if ((group.isCommunity || group.isCommunityAnnounce) && group.subject &&
          COMMUNITY_NAMES.some((name) => normalizeText(group.subject).includes(normalizeText(name)))) {
        candidates.set(group.id, { id: group.id, name: group.subject });
      }
    }

    if (candidates.size === 0) {
      console.log('No encontré esas comunidades en los eventos de chats ni en los grupos participantes devueltos por WhatsApp.');
      console.log(`Eventos de chats recibidos: ${chatsReceived}; grupos participantes consultados: ${participatingGroups.length}.`);
      const diagnosticGroups = participatingGroups.filter((group) =>
        group.isCommunity || group.isCommunityAnnounce || normalizeText(group.subject ?? '').includes('tesla'),
      );
      if (diagnosticGroups.length) {
        console.log('Comunidades y grupos con “Tesla” que sí devolvió WhatsApp:');
        console.table(diagnosticGroups.map((group) => ({
          Tipo: group.isCommunity ? 'Comunidad' : group.isCommunityAnnounce ? 'Anuncios' : 'Grupo',
          Nombre: group.subject || '(sin nombre)',
          'JID comunidad': group.linkedParent ? shortJid(group.linkedParent) : '(no aplica)',
        })));
      } else {
        console.log('WhatsApp no devolvió comunidades ni grupos con “Tesla”; esto no depende de que los chats estén archivados o vaciados.');
      }
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

    for (const candidate of candidates.values()) {
      if (seenCommunities.has(candidate.id)) continue;
      seenCommunities.add(candidate.id);
      const result = await wa.fetchLinkedGroups(candidate.id);
      const communityName = chats.get(result.communityJid)?.name ?? candidate.name;
      const joinedLinkedGroups = result.linkedGroups.filter(
        (group) => typeof group.id === 'string' && participatingGroupIds.has(group.id),
      );
      if (!joinedLinkedGroups.length) {
        report.push({
          Comunidad: communityName,
          Grupo: '(sin grupos vinculados en los que esta cuenta figure como participante)',
          JID: shortJid(candidate.id),
          'Mensajes en historial recibido': 0,
          'Destacados identificables': 'no verificable',
        });
        continue;
      }

      for (const group of joinedLinkedGroups) {
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
    const linkedGroupCount = report.filter(
      (row) => !row.Grupo.startsWith('(sin grupos vinculados'),
    ).length;
    console.log(`Grupos enlazados reportados: ${linkedGroupCount}; grupos participantes consultados: ${participatingGroups.length}.`);
    console.log('La tabla incluye solo grupos enlazados cuyo JID aparece en la lista de grupos participantes de esta cuenta.');
    console.log(`Eventos de chats recibidos: ${chatsReceived}.`);
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
