// Prueba de conexión:  npm run check
//  1) Telegram: valida el token, y envía un mensaje de prueba a tu chat.
//  2) WhatsApp: muestra el QR (si no hay sesión), conecta, y espera a que llegue el historial.
//  3) Guarda en la cola lo que cumpla las reglas (NO envía nada a Telegram, salvo los mensajes de prueba).
// Importante: el historial solo llega UNA vez, justo al vincular. Por eso este script lo guarda en la
// base local y NO debes cerrarlo (Ctrl+C) mientras muestre progreso.

import { config, loadRules, requireTelegram } from './config.ts';
import { Store } from './db.ts';
import { ingest } from './pipeline.ts';
import { makeEvaluator } from './rules.ts';
import { Telegram } from './telegram.ts';
import { errMsg, log, shortJid, sleep } from './utils.ts';
import { printQr, startWhatsApp } from './whatsapp.ts';

let failed = false;
const fail = (msg: string, hint?: string) => {
  failed = true;
  console.error(`❌ ${msg}`);
  if (hint) console.error(`   ↳ ${hint}`);
};

async function main() {
  console.log('\n=== Prueba de conexión wa-cleaner ===\n');

  // ---------- 1) Telegram ----------
  const { token, chatId } = requireTelegram();
  const tg = new Telegram(token, chatId);
  try {
    const me = await tg.getMe();
    console.log(`✅ Telegram: token válido (bot @${me.username})`);
  } catch (e) {
    fail(`Telegram: el token no funciona (${errMsg(e)})`, 'Revisa TELEGRAM_BOT_TOKEN en .env (cópialo completo desde @BotFather).');
    process.exit(1);
  }
  try {
    await tg.sendText('🧪 Prueba de wa-cleaner: si lees esto, Telegram quedó bien configurado ✅');
    console.log('✅ Telegram: mensaje de prueba enviado → revisa tu Telegram');
  } catch (e) {
    fail(
      `Telegram: no pude escribirte (${errMsg(e)})`,
      'Abre tu bot en Telegram y pulsa Start (o envíale "hola"); luego corre "npm run chatid" para confirmar tu chat id.',
    );
    process.exit(1);
  }

  // ---------- 2) WhatsApp ----------
  const rules = loadRules();
  const evaluate = makeEvaluator(rules.rescue);
  const store = new Store(config.dbPath);

  let opened = false;
  let fatal: string | undefined;
  let historyEvents = 0;
  let lastHistoryAt = 0;
  let openedAt = 0;
  const totals = { seen: 0, matched: 0, added: 0, byRule: {} as Record<string, number> };

  console.log('\nConectando a WhatsApp…');
  console.log('Si es la primera vez saldrá un QR: WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo.');
  console.log('(El QR se renueva cada ~20 s; escanea el más reciente.)\n');

  const wa = await startWhatsApp({
    authDir: config.authDir,
    syncFullHistory: config.syncFullHistory,
    logLevel: config.logLevel,
    handlers: {
      onQr: (qr) => printQr(qr),
      onOpen: () => {
        if (!opened) {
          opened = true;
          openedAt = Date.now();
        }
      },
      onMessages: (msgs, source, c) => {
        if (source !== 'history') return; // los mensajes en vivo no importan para esta prueba
        const s = ingest({ store, evaluate, selfIds: c.selfIds(), getName: c.getName }, msgs);
        historyEvents++;
        lastHistoryAt = Date.now();
        totals.seen += s.seen;
        totals.matched += s.matched;
        totals.added += s.added;
        for (const [k, v] of Object.entries(s.byRule)) totals.byRule[k] = (totals.byRule[k] ?? 0) + v;
      },
      onHistoryProgress: ({ progress, messages }) => {
        log(`Historial recibido: bloque de ${messages} mensajes${progress != null ? ` · avance ${progress}%` : ''}`);
      },
      onFatal: (_c, reason) => {
        fatal = reason;
      },
    },
  });

  const t0 = Date.now();
  while (!opened && !fatal && Date.now() - t0 < 180_000) await sleep(500);
  if (fatal) {
    fail(`WhatsApp: ${fatal}`);
    await wa.stop();
    store.close();
    process.exit(1);
  }
  if (!opened) {
    fail('WhatsApp: no se conectó en 3 minutos.', 'Escanea el QR a tiempo, o revisa tu conexión a internet y vuelve a correr "npm run check".');
    await wa.stop();
    store.close();
    process.exit(1);
  }

  const user = wa.sock()?.user;
  const number = shortJid(wa.selfIds().find((x) => x.endsWith('@s.whatsapp.net')) ?? wa.selfIds()[0] ?? '');
  const masked = number ? `…${number.slice(-4)}` : '(desconocido)';
  console.log(`\n✅ WhatsApp conectado como "${user?.name ?? 'sin nombre'}" (número terminado en ${masked})`);
  await tg.sendText(`✅ WhatsApp conectado como "${user?.name ?? 'sin nombre'}" (número ${masked}). Ahora espero el historial; te aviso cuando termine.`);

  // ---------- 3) Esperar historial ----------
  console.log('\nEsperando el historial (no cierres con Ctrl+C mientras avanza)…');
  console.log('Tip: deja WhatsApp abierto y el iPhone desbloqueado durante este paso.\n');
  const maxWaitMs = config.checkMaxWaitMinutes * 60_000;
  while (!fatal) {
    const now = Date.now();
    if (historyEvents === 0 && now - openedAt > 60_000) break; // sesión ya existente: no llega historial nuevo
    if (historyEvents > 0 && now - lastHistoryAt > 45_000) break; // ya se calmó
    if (now - openedAt > maxWaitMs) break;
    await sleep(1000);
  }

  // ---------- Resumen ----------
  const top = Object.entries(totals.byRule)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  console.log('\n=== Resultado ===');
  if (historyEvents === 0) {
    console.log('ℹ️  No llegó historial nuevo (normal si ya estabas vinculada de antes: el historial solo llega al vincular).');
    console.log('    Los mensajes NUEVOS que lleguen desde ahora sí se evaluarán cuando corras "npm start".');
  } else {
    console.log(`📚 Historial: ${totals.seen} mensajes revisados · ${totals.matched} cumplen reglas · ${totals.added} guardados en cola`);
    for (const [rule, n] of top) console.log(`   ${String(n).padStart(5)}  ${rule}`);
  }
  console.log('\nNo se reenvió nada de esos mensajes a Telegram (eso lo hace "npm start" con DRY_RUN=false).');

  const summary =
    historyEvents === 0
      ? '✅ Prueba terminada: Telegram y WhatsApp conectan bien. No llegó historial nuevo.'
      : `✅ Prueba terminada. Historial: ${totals.seen} mensajes revisados, ${totals.matched} cumplen tus reglas (guardados en cola, aún sin enviar).`;
  await tg.sendText(summary).catch(() => undefined);

  await wa.stop();
  store.close();
  console.log(failed ? '\n❌ Hubo errores (ver arriba).' : '\n🎉 TODO OK: Telegram y WhatsApp están conectados.');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('❌', errMsg(e));
  process.exit(1);
});
