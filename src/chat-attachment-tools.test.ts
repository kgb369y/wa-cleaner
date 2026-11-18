import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collectChatAttachments,
  collectOlderChatMessages,
  detectDeclaredFileType,
  detectFileType,
  findNewestChatAnchor,
  isExpectedFileSignature,
  readCapturedChatAttachments,
  safeAttachmentBaseName,
} from './chat-attachment-tools.ts';
import { replacer } from './serialize.ts';

test('finds the newest anchor and IDs using only the target chat metadata', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-chat-anchor-'));
  const capture = path.join(directory, 'history.jsonl');
  const messages = [
    { key: { remoteJid: 'target-lid@lid', id: 'old', fromMe: false }, messageTimestamp: 10, message: { conversation: 'private text' } },
    { key: { remoteJid: 'other@s.whatsapp.net', id: 'other', fromMe: false }, messageTimestamp: 100, message: { conversation: 'ignore' } },
    { key: { remoteJid: '123@s.whatsapp.net', id: 'new', fromMe: true }, messageTimestamp: 20, message: { conversation: 'private text too' } },
  ];
  fs.writeFileSync(capture, messages.map((message) => JSON.stringify({ message }, replacer)).join('\n'));

  try {
    const anchor = await findNewestChatAnchor(
      capture,
      '123@s.whatsapp.net',
      new Map([['target-lid@lid', '123@s.whatsapp.net']]),
    );
    assert.equal(anchor.key.id, 'new');
    assert.equal(anchor.key.remoteJid, '123@s.whatsapp.net');
    assert.deepEqual(anchor.seenMessageIdentities.sort(), ['0|old', '1|new']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reads attachment metadata and media bytes only for the target chat', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-chat-attachments-'));
  const capture = path.join(directory, 'history.jsonl');
  const messages = [
    {
      key: { remoteJid: 'target-lid@lid', id: 'pdf', fromMe: false },
      messageTimestamp: 10,
      message: { documentMessage: { fileName: 'lesson.pdf', mimetype: 'application/pdf', mediaKey: Buffer.alloc(32, 4) } },
    },
    {
      key: { remoteJid: 'target-lid@lid', id: 'plain', fromMe: false },
      messageTimestamp: 11,
      message: { conversation: 'Do not export this text' },
    },
    {
      key: { remoteJid: 'other@s.whatsapp.net', id: 'other-pdf', fromMe: false },
      messageTimestamp: 12,
      message: { documentMessage: { fileName: 'other.pdf', mimetype: 'application/pdf' } },
    },
  ];
  fs.writeFileSync(capture, messages.map((message) => JSON.stringify({ message }, replacer)).join('\n'));

  try {
    const aliases = new Map([['target-lid@lid', '123@s.whatsapp.net']]);
    const result = await readCapturedChatAttachments(capture, '123@s.whatsapp.net', aliases);
    assert.deepEqual(result.map((attachment) => attachment.id), ['pdf']);
    assert.equal(Buffer.isBuffer(result[0].raw.message.documentMessage.mediaKey), true);
    assert.deepEqual(
      collectChatAttachments(messages, '123@s.whatsapp.net', aliases).map((attachment) => attachment.id),
      ['pdf'],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('paginates unique older messages in the target chat and recognizes binary file signatures', () => {
  const oldMessage = { key: { remoteJid: 'target-lid@lid', id: 'old', fromMe: false }, messageTimestamp: 10 };
  const messages = [
    oldMessage,
    { ...oldMessage },
    { key: { remoteJid: 'other@s.whatsapp.net', id: 'foreign', fromMe: false }, messageTimestamp: 5 },
  ];
  const pdf = Buffer.from('%PDF-1.7\n');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  const office: Parameters<typeof detectDeclaredFileType>[0] = {
    id: 'file',
    timestamp: 1,
    fromMe: false,
    fileName: 'report.docx',
    mimetype: 'application/zip',
    kind: 'document',
    raw: {},
  };
  assert.deepEqual(
    collectOlderChatMessages(messages, '123@s.whatsapp.net', new Map([['target-lid@lid', '123@s.whatsapp.net']]), 20, new Set())
      .map((message) => message.key.id),
    ['old'],
  );
  assert.equal(detectFileType(pdf)?.extension, 'pdf');
  assert.equal(isExpectedFileSignature(pdf, detectFileType(pdf)!), true);
  assert.equal(detectFileType(jpeg)?.extension, 'jpg');
  assert.equal(detectDeclaredFileType(office)?.extension, 'docx');
  assert.equal(safeAttachmentBaseName('../unsafe/name.pdf', 'ID-1'), 'ID-1-_unsafe_name');
});
