import assert from 'node:assert/strict';
import test from 'node:test';
import { collectPdfMessages, phoneNumberToJid } from './chat-pdfs.ts';

test('normalizes an international phone number into a WhatsApp JID', () => {
  assert.equal(phoneNumberToJid('+57 312 645-7254'), '573126457254@s.whatsapp.net');
});

test('rejects phone numbers that are not valid international digit strings', () => {
  for (const phone of ['', 'abc', '+57 312 ext 4', '1234567', '+1234567890123456']) {
    assert.throws(() => phoneNumberToJid(phone), { name: 'TypeError' });
  }
});

test('collects PDFs by MIME type or filename from only the requested direct chat', () => {
  const messages = [
    {
      key: { remoteJid: '573126457254@s.whatsapp.net', id: 'pdf-mime', fromMe: false },
      messageTimestamp: 100,
      message: { documentMessage: { mimetype: 'application/pdf', fileName: 'report.bin', fileLength: 10 } },
    },
    {
      key: { remoteJid: '573126457254@s.whatsapp.net', id: 'pdf-extension', fromMe: true },
      messageTimestamp: 200,
      message: {
        ephemeralMessage: {
          message: { documentMessage: { mimetype: 'application/octet-stream', fileName: 'Invoice.PDF' } },
        },
      },
    },
    {
      key: { remoteJid: '573126457254@s.whatsapp.net', id: 'not-pdf' },
      message: { documentMessage: { mimetype: 'application/msword', fileName: 'notes.doc' } },
    },
    {
      key: { remoteJid: '120363000000000000@g.us', id: 'other-chat' },
      message: { documentMessage: { mimetype: 'application/pdf', fileName: 'other.pdf' } },
    },
  ];

  const found = collectPdfMessages(messages, '573126457254@s.whatsapp.net');
  assert.deepEqual(found.map(({ id, fileName }) => [id, fileName]), [
    ['pdf-mime', 'report.bin'],
    ['pdf-extension', 'Invoice.PDF'],
  ]);
});

test('matches phone-number JIDs exposed as an alternate JID and ignores sync duplicates', () => {
  const messages = [
    {
      key: {
        remoteJid: '12345@lid',
        remoteJidAlt: '573126457254@s.whatsapp.net',
        id: 'same-message',
      },
      messageTimestamp: 1,
      message: { documentMessage: { mimetype: 'application/pdf', fileName: 'scan.pdf' } },
    },
    {
      key: {
        remoteJid: '12345@lid',
        remoteJidAlt: '573126457254@s.whatsapp.net',
        id: 'same-message',
      },
      messageTimestamp: 1,
      message: { documentMessage: { mimetype: 'application/pdf', fileName: 'scan.pdf' } },
    },
  ];

  assert.equal(collectPdfMessages(messages, '573126457254@s.whatsapp.net').length, 1);
});
