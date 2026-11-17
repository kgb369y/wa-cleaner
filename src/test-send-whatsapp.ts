import { config } from './config.ts';
import { sleep } from './utils.ts';
import { startWhatsApp } from './whatsapp.ts';

const TEST_GROUP_SUBJECT = 'WA Cleaner - PRUEBA DESTACADOS';
const TEST_MESSAGE = 'prueba1';
const CONNECTION_TIMEOUT_MS = 3 * 60_000;

async function main() {
  let opened = false;
  let fatalReason: string | undefined;
  const wa = await startWhatsApp({
    authDir: config.authDir,
    syncFullHistory: false,
    logLevel: config.logLevel,
    handlers: {
      onOpen: () => {
        opened = true;
        console.log('WhatsApp conectado; buscando el grupo exacto de prueba…');
      },
      onClose: () => {
        opened = false;
      },
      onFatal: (_code, reason) => {
        fatalReason = reason;
      },
    },
  });

  try {
    const startedAt = Date.now();
    while (!opened && !fatalReason && Date.now() - startedAt < CONNECTION_TIMEOUT_MS) {
      await sleep(500);
    }
    if (fatalReason) throw new Error(fatalReason);
    if (!opened) throw new Error('WhatsApp no se conectó en 3 minutos.');

    const groups = await wa.fetchParticipatingGroups();
    const matches = groups.filter((group) => group.subject === TEST_GROUP_SUBJECT);
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `No encontré un grupo participante llamado exactamente "${TEST_GROUP_SUBJECT}".`
          : `Encontré ${matches.length} grupos con ese nombre; no enviaré para evitar ambigüedad.`,
      );
    }

    const group = matches[0];
    if (!group.id.endsWith('@g.us') || group.isCommunity || group.isCommunityAnnounce || group.linkedParent) {
      throw new Error('El destino no parece ser un grupo de prueba independiente; no enviaré el mensaje.');
    }

    console.log(`\nDestino exacto: ${group.subject}`);
    console.log(`Enviando: ${TEST_MESSAGE}`);
    console.log('Todos los integrantes del grupo podrán ver el mensaje.');
    const messageId = await wa.sendText(group.id, TEST_MESSAGE);
    console.log(`Baileys aceptó el envío de "prueba1". ID para borrado: ${messageId}`);
    console.log('Confirma en WhatsApp que el mensaje aparezca en la conversación.');
  } finally {
    await wa.stop();
  }
}

main().catch((error) => {
  console.error('Error en prueba de envío:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
