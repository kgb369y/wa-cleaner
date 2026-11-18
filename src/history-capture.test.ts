import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HistoryCapture } from './history-capture.ts';

test('captures raw history messages, preserves binary fields, and skips repeated event IDs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cleaner-history-'));
  const file = path.join(directory, 'history.jsonl');
  const capture = new HistoryCapture(file);
  const message = {
    key: { remoteJid: 'chat@s.whatsapp.net', id: 'message-1', fromMe: false },
    message: { documentMessage: { mediaKey: Buffer.from([1, 2, 3]) } },
  };

  try {
    assert.equal(capture.append([message, message]), 1);
    assert.equal(capture.count, 1);
    capture.close();

    const records = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].message.message.documentMessage.mediaKey, { __bytes: Buffer.from([1, 2, 3]).toString('base64') });
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    capture.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects appending after the capture is closed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cleaner-history-'));
  const capture = new HistoryCapture(path.join(directory, 'history.jsonl'));
  capture.close();

  try {
    assert.throws(() => capture.append([{ key: { id: 'message-1' } }]), /ya está cerrada/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
