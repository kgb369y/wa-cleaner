import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, requireTelegram } from './config.ts';
import { Telegram } from './telegram.ts';
import { errMsg } from './utils.ts';

const fileName = 'AI_Fluency_AWS_Security_Training_gs.pdf';
const filePath = path.join(ROOT, 'pdfstesting', fileName);
const caption = 'Prueba de compresión PDF: AI Fluency y AWS Security Training.';

async function main() {
  const { token, chatId } = requireTelegram();
  const file = await fs.readFile(filePath);
  if (!file.length) throw new Error(`El archivo está vacío: ${filePath}`);

  const telegram = new Telegram(token, chatId);
  const messageId = await telegram.sendDocument(file, fileName, 'application/pdf', caption);
  console.log(`✅ PDF enviado a Telegram (message_id=${messageId}, ${file.length} bytes).`);
}

main().catch((error) => {
  console.error(`❌ No se pudo enviar el PDF a Telegram: ${errMsg(error)}`);
  process.exitCode = 1;
});
