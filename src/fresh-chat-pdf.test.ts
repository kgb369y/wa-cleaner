import assert from 'node:assert/strict';
import test from 'node:test';
import { collectFreshChatPdfs, collectOlderChatMessages } from './fresh-chat-pdf.ts';

test('selects only fresh PDFs from the target phone or its mapped LID', () => {
  const messages = [
    { key: { remoteJid: 'target-lid@lid', id: 'later', fromMe: false }, messageTimestamp: 20, message: { documentMessage: { fileName: 'later.pdf', mimetype: 'application/pdf' } } },
    { key: { remoteJid: 'other@s.whatsapp.net', id: 'other', fromMe: false }, messageTimestamp: 1, message: { documentMessage: { fileName: 'other.pdf', mimetype: 'application/pdf' } } },
    { key: { remoteJid: '123@s.whatsapp.net', id: 'first', fromMe: false }, messageTimestamp: 10, message: { documentMessage: { fileName: 'first.PDF', mimetype: 'application/octet-stream' } } },
    { key: { remoteJid: 'target-lid@lid', id: 'text', fromMe: false }, messageTimestamp: 5, message: { conversation: 'not a document' } },
  ];

  const result = collectFreshChatPdfs(
    messages,
    '123@s.whatsapp.net',
    new Map([['target-lid@lid', '123@s.whatsapp.net']]),
  );

  assert.deepEqual(result.map((message) => message.id), ['first', 'later']);
});

test('rejects group identifiers', () => {
  assert.throws(() => collectFreshChatPdfs([], 'group@g.us', new Map()), { name: 'TypeError' });
});

test('collects unique older messages only from the target chat for history pagination', () => {
  const first = { key: { remoteJid: 'target-lid@lid', id: 'old', fromMe: false }, messageTimestamp: 10 };
  const messages = [
    { key: { remoteJid: '123@s.whatsapp.net', id: 'anchor', fromMe: false }, messageTimestamp: 30 },
    first,
    { ...first },
    { key: { remoteJid: '123@s.whatsapp.net', id: 'same-second-older', fromMe: false }, messageTimestamp: 30 },
    { key: { remoteJid: 'other@s.whatsapp.net', id: 'elsewhere', fromMe: false }, messageTimestamp: 5 },
  ];

  const result = collectOlderChatMessages(
    messages,
    '123@s.whatsapp.net',
    new Map([['target-lid@lid', '123@s.whatsapp.net']]),
    30,
    new Set(['0|anchor']),
  );

  assert.deepEqual(result.map((message) => message.key.id), ['old', 'same-second-older']);
});
