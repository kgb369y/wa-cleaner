// Muestra los mensajes pendientes en una tabla legible: npm run list

import { config } from './config.ts';
import { Store, type Status } from './db.ts';
import { extract } from './extract.ts';
import { parseMessage } from './serialize.ts';
import { formatDate, shortJid } from './utils.ts';

const STATUS_VALUES: Status[] = ['pending', 'done', 'failed', 'skipped'];
const requestedStatus = process.argv[2] as Status | undefined;

if (requestedStatus && !STATUS_VALUES.includes(requestedStatus)) {
  console.error(`Estado no válido. Usa uno de: ${STATUS_VALUES.join(', ')}`);
  process.exit(1);
}

const status = requestedStatus ?? 'pending';
const store = new Store(config.dbPath);

try {
  const jobs = store.listJobs(status, 100);
  if (jobs.length === 0) {
    console.log(`No hay mensajes con estado "${status}".`);
  } else {
    const rows = jobs.map((job) => {
      const message = extract(parseMessage(job.payload));
      const content = message?.text.trim() || message?.fileName || `[${message?.kind ?? 'mensaje'}]`;
      return {
        Fecha: formatDate(job.ts, config.tz),
        Chat: job.chat_name ?? shortJid(job.chat_jid),
        Tipo: message?.kind ?? 'desconocido',
        Regla: job.rule,
        Contenido: content.length > 100 ? `${content.slice(0, 97)}...` : content,
        Medio: job.with_media ? 'sí' : 'no',
      };
    });

    console.log(`\nMensajes "${status}" (máximo 100):`);
    console.table(rows);
  }
} finally {
  store.close();
}
