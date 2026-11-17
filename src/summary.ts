// Resumen de la cola:  npm run summary
// Útil en modo DRY_RUN para ver qué se reenviaría antes de activar el modo real.

import { config } from './config.ts';
import { Store } from './db.ts';
import { formatDate, shortJid } from './utils.ts';

const store = new Store(config.dbPath);
const c = store.statusCounts();

console.log('\n=== Estado de la cola ===');
console.log(`Pendientes (se reenviarían): ${c.pending ?? 0}`);
console.log(`Ya reenviados:               ${c.done ?? 0}`);
console.log(`Fallidos (media expirada…):  ${c.failed ?? 0}`);
console.log(`Descartados:                 ${c.skipped ?? 0}`);

const rules = store.ruleCounts('pending', 20);
if (rules.length) {
  console.log('\nPendientes por regla:');
  for (const r of rules) console.log(`  ${String(r.n).padStart(5)}  ${r.rule}`);
}

const sample = store.sample('pending', 15);
if (sample.length) {
  console.log('\nÚltimos 15 pendientes:');
  for (const s of sample) {
    console.log(
      `  ${formatDate(s.ts, config.tz)} · ${s.chat_name ?? shortJid(s.chat_jid)} · ${s.rule}${s.with_media ? ' · 📎' : ''}`,
    );
  }
}
store.close();
console.log();
