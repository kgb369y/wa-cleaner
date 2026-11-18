import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listMatchedChats } from './matched-chats.ts';
import { replacer } from './serialize.ts';

function createCapture(messages: any[]): { directory: string; file: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cleaner-matched-chats-'));
  const file = path.join(directory, 'history.jsonl');
  fs.writeFileSync(file, messages.map((message) => JSON.stringify({ message }, replacer)).join('\n') + '\n');
  return { directory, file };
}

test('lists each matching contact separately with its own message and trigger counts', async () => {
  const capture = createCapture([
    { key: { remoteJid: '123@s.whatsapp.net', id: 'a1' }, message: { conversation: 'Recibir material' } },
    { key: { remoteJid: '123@s.whatsapp.net', id: 'a2' }, message: { conversation: 'Otro mensaje del primer chat' } },
    { key: { remoteJid: '456@s.whatsapp.net', id: 'b1' }, message: { conversation: 'Quiero recibir material' } },
    { key: { remoteJid: '456@s.whatsapp.net', id: 'b2' }, message: { conversation: 'Otro mensaje del segundo chat' } },
    { key: { remoteJid: '789@s.whatsapp.net', id: 'c1' }, message: { conversation: 'Sin coincidencia' } },
  ]);

  try {
    const chats = await listMatchedChats(capture.file, ['recibir material']);
    assert.deepEqual(chats.map(({ chatJid, messageCount, triggerCount }) => [chatJid, messageCount, triggerCount]), [
      ['123@s.whatsapp.net', 2, 1],
      ['456@s.whatsapp.net', 2, 1],
    ]);
  } finally {
    fs.rmSync(capture.directory, { recursive: true, force: true });
  }
});

test('groups alternate phone and LID identifiers into one chat, without merging distinct chats', async () => {
  const capture = createCapture([
    { key: { remoteJid: 'lid-1@lid', remoteJidAlt: '123@s.whatsapp.net', id: 'one' }, message: { conversation: 'recibir material' } },
    { key: { remoteJid: 'lid-1@lid', id: 'two' }, message: { conversation: 'otro mensaje del contacto' } },
    { key: { remoteJid: '456@s.whatsapp.net', id: 'three' }, message: { conversation: 'recibir material' } },
  ]);

  try {
    const chats = await listMatchedChats(capture.file, ['recibir material']);
    assert.equal(chats.length, 2);
    assert.equal(chats.find((chat) => chat.chatJid === '123@s.whatsapp.net')?.messageCount, 2);
    assert.equal(chats.find((chat) => chat.chatJid === '456@s.whatsapp.net')?.messageCount, 1);
  } finally {
    fs.rmSync(capture.directory, { recursive: true, force: true });
  }
});

test('resolves LID-only history messages to their phone JID using local LID mappings', async () => {
  const capture = createCapture([
    { key: { remoteJid: '12345@lid', id: 'hit' }, message: { conversation: 'recibir material' } },
    { key: { remoteJid: '12345@lid', id: 'other' }, message: { conversation: 'mensaje del mismo contacto' } },
    { key: { remoteJid: '456@s.whatsapp.net', id: 'different' }, message: { conversation: 'recibir material' } },
  ]);

  try {
    const chats = await listMatchedChats(
      capture.file,
      ['recibir material'],
      new Map([['12345@lid', '123@s.whatsapp.net']]),
    );
    assert.equal(chats.length, 2);
    const target = chats.find((chat) => chat.chatJid === '123@s.whatsapp.net');
    assert.equal(target?.messageCount, 2);
    assert.deepEqual(target?.aliases, ['12345@lid', '123@s.whatsapp.net']);
  } finally {
    fs.rmSync(capture.directory, { recursive: true, force: true });
  }
});

test('matches accents and case but does not print or retain message text', async () => {
  const capture = createCapture([
    { key: { remoteJid: '123@s.whatsapp.net', id: 'a' }, message: { conversation: 'RECIBIR MATERIAL para mañana' } },
    { key: { remoteJid: '123@s.whatsapp.net', id: 'b' }, message: { conversation: 'otro contenido privado' } },
  ]);

  try {
    const chats = await listMatchedChats(capture.file, ['recibir material']);
    assert.equal(chats[0].triggerCount, 1);
    assert.equal(JSON.stringify(chats).includes('privado'), false);
    assert.deepEqual(chats[0].matchedKeywords, ['recibir material']);
  } finally {
    fs.rmSync(capture.directory, { recursive: true, force: true });
  }
});
