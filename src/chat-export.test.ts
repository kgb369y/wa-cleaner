import assert from 'node:assert/strict';
import test from 'node:test';
import { chatAttachmentFileName, collectChatMessages } from './chat-export.ts';

test('collects text and media only from the requested direct chat, including alternate JIDs', () => {
  const messages = [
    {
      key: { remoteJid: '573126457254@s.whatsapp.net', id: 'text-1', fromMe: false },
      messageTimestamp: 10,
      message: { conversation: 'Texto del chat' },
    },
    {
      key: { remoteJid: '12345@lid', remoteJidAlt: '573126457254@s.whatsapp.net', id: 'pdf-1', fromMe: true },
      messageTimestamp: 20,
      message: { documentMessage: { mimetype: 'application/pdf', fileName: 'informe.pdf', fileLength: 42, caption: 'Adjunto' } },
    },
    {
      key: { remoteJid: '120363000000000000@g.us', id: 'other-chat' },
      message: { conversation: 'No incluir' },
    },
  ];

  const result = collectChatMessages(messages, '573126457254@s.whatsapp.net');
  assert.deepEqual(result.map(({ id, kind, text, hasMedia }) => [id, kind, text, hasMedia]), [
    ['text-1', 'text', 'Texto del chat', false],
    ['pdf-1', 'document', 'Adjunto', true],
  ]);
});

test('unwraps ephemeral messages and deduplicates history events by message ID', () => {
  const raw = {
    key: { remoteJid: '573126457254@s.whatsapp.net', id: 'same-id' },
    messageTimestamp: 15,
    message: { ephemeralMessage: { message: { imageMessage: { caption: 'Foto', mimetype: 'image/jpeg' } } } },
  };
  const result = collectChatMessages([raw, raw], '573126457254@s.whatsapp.net');
  assert.equal(result.length, 1);
  assert.equal(result[0].hasMedia, true);
  assert.equal(result[0].text, 'Foto');
});

test('generates safe, bounded attachment names from untrusted filenames', () => {
  const [message] = collectChatMessages(
    [{
      key: { remoteJid: '573126457254@s.whatsapp.net', id: '../../id:unsafe' },
      messageTimestamp: 123,
      message: { documentMessage: { fileName: '../../invoice.pdf', mimetype: 'application/pdf' } },
    }],
    '573126457254@s.whatsapp.net',
  );

  const name = chatAttachmentFileName(message);
  assert.equal(name.includes('/'), false);
  assert.equal(name.includes('\\'), false);
  assert.match(name, /^123-.*-invoice\.pdf$/);
});

test('rejects group and malformed chat identifiers', () => {
  assert.throws(() => collectChatMessages([], '120363000000000000@g.us'), { name: 'TypeError' });
  assert.throws(() => collectChatMessages([], 'invalid'), { name: 'TypeError' });
});
