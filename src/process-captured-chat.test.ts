import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readCapturedChat } from './process-captured-chat.ts';
import { replacer } from './serialize.ts';

test('reads only the requested phone chat and its mapped LID messages', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cleaner-single-chat-'));
  const capture = path.join(directory, 'history.jsonl');
  const messages = [
    { key: { remoteJid: 'contact-lid@lid', id: 'one', fromMe: false }, messageTimestamp: 1, message: { conversation: 'primero' } },
    { key: { remoteJid: '123@s.whatsapp.net', id: 'two', fromMe: true }, messageTimestamp: 2, message: { conversation: 'segundo' } },
    {
      key: { remoteJid: 'contact-lid@lid', id: 'media', fromMe: false },
      messageTimestamp: 3,
      message: { imageMessage: {
        mimetype: 'image/jpeg',
        mediaKey: Buffer.alloc(32, 1).toString('base64'),
        fileSha256: Buffer.alloc(32, 2).toString('base64'),
        fileEncSha256: Buffer.alloc(32, 3).toString('base64'),
      } },
    },
    { key: { remoteJid: '456@s.whatsapp.net', id: 'other', fromMe: false }, messageTimestamp: 3, message: { conversation: 'no incluir' } },
  ];
  fs.writeFileSync(capture, messages.map((message) => JSON.stringify({ message }, replacer)).join('\n'));

  try {
    const result = await readCapturedChat(
      capture,
      '123@s.whatsapp.net',
      new Map([['contact-lid@lid', '123@s.whatsapp.net']]),
    );
    assert.deepEqual(result.map((message) => message.id), ['one', 'two', 'media']);
    const media = result[2].raw.message.imageMessage;
    assert.equal(Buffer.isBuffer(media.mediaKey), true);
    assert.equal(media.mediaKey.length, 32);
    assert.equal(Buffer.isBuffer(media.fileSha256), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects group identifiers rather than processing multiple chats', async () => {
  await assert.rejects(readCapturedChat('unused', '123@g.us', new Map()), { name: 'TypeError' });
});
