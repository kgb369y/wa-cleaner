import { config } from './config.ts';
import { sleep } from './utils.ts';
import { startWhatsApp } from './whatsapp.ts';

const TEST_GROUP_SUBJECT = 'WA Cleaner - PRUEBA DESTACADOS';
const CONNECTION_TIMEOUT_MS = 3 * 60_000;

async function main() {
  let opened = false;
  let fatalReason: string | undefined;
  const wa = await startWhatsApp({
    authDir: config.authDir,
    syncFullHistory: false,
    logLevel: config.logLevel,
    emitOwnEvents: false,
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
          : `Encontré ${matches.length} grupos con ese nombre; no vaciaré para evitar ambigüedad.`,
      );
    }

    const group = matches[0];
    if (!group.id.endsWith('@g.us') || group.isCommunity || group.isCommunityAnnounce || group.linkedParent) {
      throw new Error('El destino no parece ser un grupo de prueba independiente; no vaciaré el chat.');
    }

    const throughTimestamp = Math.floor(Date.now() / 1000);
    console.log(`\nVaciando hasta ahora únicamente: ${group.subject}`);
    console.log('La opción de protocolo seleccionada es conservar mensajes destacados.');
    console.log('El parche incluye el timestamp de sincronización requerido por Baileys.');
    console.log('Verifica en WhatsApp que desaparezcan los mensajes normales y permanezcan los destacados.');
    await wa.clearChatPreservingStarred(group.id, throughTimestamp);
    console.log('Baileys recibió el acuse de la solicitud. Esto no confirma que WhatsApp haya aplicado el vaciado.');
  } finally {
    await wa.stop();
  }
}

main().catch((error) => {
  console.error('Error en prueba de vaciado:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
