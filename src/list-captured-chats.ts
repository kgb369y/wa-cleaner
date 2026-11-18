import fs from 'node:fs';
import path from 'node:path';
import { config, loadRules, ROOT } from './config.ts';
import { phoneNumberToJid } from './chat-pdfs.ts';
import { loadLidAliases } from './lid-mapping.ts';
import { listMatchedChats } from './matched-chats.ts';
import { errMsg } from './utils.ts';

const captureArgument = process.argv[2];
if (!captureArgument) {
  throw new Error('Uso: npm run list-captured-chats -- data/history-captures/<captura>.jsonl [teléfono-internacional]');
}
if (process.argv.length > 4) throw new Error('Indica una captura JSONL y, opcionalmente, un teléfono internacional');

const captureRoot = path.resolve(ROOT, 'data', 'history-captures');
const capturePath = path.resolve(ROOT, captureArgument);
const relativeCapture = path.relative(captureRoot, capturePath);
if (!relativeCapture || relativeCapture.startsWith('..') || path.isAbsolute(relativeCapture)) {
  throw new Error('La captura debe estar dentro de data/history-captures/');
}
const targetJid = process.argv[3] ? phoneNumberToJid(process.argv[3]) : undefined;
if (!fs.existsSync(capturePath) || !fs.statSync(capturePath).isFile()) {
  throw new Error(`No existe la captura: ${path.relative(ROOT, capturePath)}`);
}

async function main() {
  const rules = loadRules();
  const lidAliases = await loadLidAliases([
    config.authDir,
    path.join(ROOT, 'data', 'history-capture-auth'),
  ]);
  const allChats = await listMatchedChats(capturePath, rules.rescue.keywords, lidAliases);
  const chats = targetJid ? allChats.filter((chat) => chat.aliases.includes(targetJid)) : allChats;

  console.log(targetJid
    ? `Conversaciones coincidentes para el teléfono indicado: ${chats.length}.`
    : `Conversaciones coincidentes: ${chats.length}.`);
  if (!chats.length) {
    console.log('No hay conversaciones con las palabras clave actuales de rules.json.');
    return;
  }

  console.log('\n#  Chat (JID)                       Mensajes  Coincidencias  Palabras clave');
  chats.forEach((chat, index) => {
    console.log(
      `${String(index + 1).padEnd(3)}${chat.chatJid.padEnd(34)}${String(chat.messageCount).padEnd(10)}` +
        `${String(chat.triggerCount).padEnd(15)}${chat.matchedKeywords.join(', ')}`,
    );
  });
  console.log('\nEsta fase solo lista. No descarga archivos, no exporta conversaciones y no conecta con WhatsApp ni Telegram.');
}

main().catch((error) => {
  console.error(`❌ No se pudieron listar las conversaciones: ${errMsg(error)}`);
  process.exitCode = 1;
});
