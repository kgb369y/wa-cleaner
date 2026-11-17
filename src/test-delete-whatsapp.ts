import { config } from './config.ts';
import { sleep } from './utils.ts';
import { startWhatsApp } from './whatsapp.ts';

const TEST_GROUP_SUBJECT = 'WA Cleaner - PRUEBA DESTACADOS';
const CONNECTION_TIMEOUT_MS = 3 * 60_000;
const messageId = process.argv[2]?.trim();

async function main() {
  if (!messageId || !/^[A-Za-z0-9._:-]{1,128}$/.test(messageId)) {
    throw new Error('Uso: npm run test-delete-whatsapp -- <ID-del-mensaje-propio>');
  }

  let opened = false;
  let fatalReason: string | undefined;
  const wa = await startWhatsApp({
    authDir: config.authDir,
    syncFullHistory: false,
    logLevel: config.logLevel,
    handlers: {
      onOpen: () => {
        opened = true;
        console.log('WhatsApp conectado; validando el grupo de prueba…');
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
          : `Encontré ${matches.length} grupos con ese nombre; no borraré para evitar ambigüedad.`,
      );
    }

    const group = matches[0];
    if (!group.id.endsWith('@g.us') || group.isCommunity || group.isCommunityAnnounce || group.linkedParent) {
      throw new Error('El destino no parece ser un grupo de prueba independiente; no borraré el mensaje.');
    }

    console.log(`\nDestino exacto: ${group.subject}`);
    console.log(`Solicitando borrar tu mensaje con ID ${messageId} para todos.`);
    await wa.deleteOwnMessage(group.id, messageId);
    console.log('Baileys aceptó la solicitud de borrado. Verifica el resultado en WhatsApp.');
  } finally {
    await wa.stop();
  }
}

main().catch((error) => {
  console.error('Error en prueba de borrado:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
