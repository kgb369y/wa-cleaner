// Obtiene tu chat id de Telegram:  npm run chatid
// Antes: abre tu bot en Telegram y envíale cualquier mensaje (o pulsa Start).

import { config } from './config.ts';
import { errMsg } from './utils.ts';

async function main() {
  if (!config.telegramToken) {
    console.error('❌ Falta TELEGRAM_BOT_TOKEN en .env (cópialo desde @BotFather).');
    process.exit(1);
  }
  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/getUpdates`);
  const json: any = await res.json().catch(() => null);
  if (!json?.ok) {
    console.error(`❌ Telegram respondió: ${json?.description ?? `HTTP ${res.status}`}`);
    console.error('   Revisa que el token esté completo y sin espacios.');
    process.exit(1);
  }

  const chats = new Map<number, any>();
  for (const u of json.result ?? []) {
    const chat = u.message?.chat ?? u.edited_message?.chat ?? u.my_chat_member?.chat;
    if (chat) chats.set(chat.id, chat);
  }
  if (chats.size === 0) {
    console.log('No veo mensajes todavía. Abre tu bot en Telegram, pulsa Start (o escribe "hola") y vuelve a correr este comando.');
    return;
  }
  console.log('\nChats que han escrito a tu bot:\n');
  for (const [id, c] of chats) {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.title || '';
    console.log(`  TELEGRAM_CHAT_ID=${id}    (${c.type}${name ? `, ${name}` : ''}${c.username ? `, @${c.username}` : ''})`);
  }
  console.log('\nCopia la línea TELEGRAM_CHAT_ID=… de tu chat personal (tipo "private") a tu archivo .env');
}

main().catch((e) => {
  console.error('❌', errMsg(e));
  process.exit(1);
});
