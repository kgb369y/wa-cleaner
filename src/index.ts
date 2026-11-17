// Proceso principal (Fase 1: solo rescate hacia Telegram; no se borra nada).

import { config, loadRules, requireTelegram } from './config.ts';
import { Store } from './db.ts';
import { ingest, processJob } from './pipeline.ts';
import { makeEvaluator } from './rules.ts';
import { Telegram, TelegramError } from './telegram.ts';
import { errMsg, log, sleep, sleepRandom } from './utils.ts';
import { printQr, startWhatsApp, type WaClient } from './whatsapp.ts';

async function main() {
  const rules = loadRules();
  const evaluate = makeEvaluator(rules.rescue);
  const store = new Store(config.dbPath);

  log('wa-cleaner · Fase 1 (rescate a Telegram)');
  log(
    config.dryRun
      ? '🧪 Modo DRY_RUN=true: se analiza y se guarda en cola, pero NO se descarga ni se envía nada.'
      : '🚀 Modo REAL (DRY_RUN=false): se reenvía a Telegram lo que cumpla las reglas.',
  );
  log(`Reglas: ${rules.rescue.keywords.length} palabras clave, ${rules.rescue.ignoreChats.length} chats ignorados, ` +
    `${rules.protectedChats.length} chats protegidos (se usarán en la Fase 3).`);

  let tg: Telegram | undefined;
  if (!config.dryRun) {
    const { token, chatId } = requireTelegram();
    tg = new Telegram(token, chatId);
    const me = await tg.getMe();
    log(`Telegram OK: bot @${me.username}`);
  }

  let client: WaClient | undefined;
  let ready = false;
  let stopping = false;

  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    log('Cerrando…');
    try {
      await client?.stop();
    } catch {
      /* nada */
    }
    store.close();
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  const logStats = () => {
    const c = store.statusCounts();
    log(`Cola → pendientes: ${c.pending ?? 0} · enviados: ${c.done ?? 0} · fallidos: ${c.failed ?? 0} · descartados: ${c.skipped ?? 0}`);
  };

  client = await startWhatsApp({
    authDir: config.authDir,
    syncFullHistory: config.syncFullHistory,
    logLevel: config.logLevel,
    handlers: {
      onQr: (qr) => {
        log('Escanea el QR: WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo');
        printQr(qr);
      },
      onOpen: (c) => {
        ready = true;
        log(`✅ WhatsApp conectado${c.sock()?.user?.name ? ` como ${c.sock().user.name}` : ''}`);
      },
      onClose: () => {
        ready = false;
      },
      onMessages: (msgs, source, c) => {
        const s = ingest({ store, evaluate, selfIds: c.selfIds(), getName: c.getName }, msgs);
        if (s.matched > 0 || source === 'history') {
          log(`[${source}] ${s.seen} mensajes revisados · ${s.matched} cumplen reglas · ${s.added} nuevos en cola`);
        }
      },
      onHistoryProgress: ({ progress, isLatest }) => {
        if (progress != null) log(`Historial: ${progress}%${isLatest ? ' (último bloque)' : ''}`);
      },
      onFatal: (_code, reason) => {
        log('⛔', reason);
        const done = tg ? tg.sendText(`⛔ wa-cleaner se detuvo: ${reason}`).catch(() => undefined) : Promise.resolve();
        void done.finally(() => shutdown(1));
      },
    },
  });

  // ---- Worker: manda a Telegram, de a uno, con pausas aleatorias ----
  let lastStats = 0;
  while (!stopping) {
    if (Date.now() - lastStats > 10 * 60_000) {
      lastStats = Date.now();
      logStats();
    }
    if (config.dryRun || !ready || !tg) {
      await sleep(5000);
      continue;
    }

    const sent24h = store.doneSince(Date.now() - 24 * 3600 * 1000);
    if (sent24h >= rules.limits.maxForwardsPerDay) {
      log(`Tope diario alcanzado (${sent24h} envíos en 24 h). Espero 15 min.`);
      await sleep(15 * 60_000);
      continue;
    }

    const job = store.nextPending();
    if (!job) {
      await sleep(5000);
      continue;
    }

    try {
      const res = await processJob(
        {
          store,
          tg,
          rules,
          tz: config.tz,
          download: (raw, maxBytes) => client!.download(raw, maxBytes),
          chatName: (jid) => client!.resolveChatName(jid),
        },
        job,
      );
      log(`${res.toUpperCase()} ← ${job.rule} · ${job.chat_name ?? job.chat_jid}`);
    } catch (e) {
      if (e instanceof TelegramError && e.fatal) {
        log(`⛔ Telegram rechazó el envío (${e.message}). Revisa token/chat id y que le hayas dado Start al bot.`);
        await shutdown(1);
        return;
      }
      log('⚠️ Error inesperado:', errMsg(e));
    }
    await sleepRandom(rules.limits.minDelaySec, rules.limits.maxDelaySec);
  }
}

main().catch((e) => {
  console.error('❌', errMsg(e));
  process.exit(1);
});
