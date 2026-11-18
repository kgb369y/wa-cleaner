import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { packageChatExport } from './package-chat-export.ts';
import type { CapturedChatMessage } from './process-captured-chat.ts';

test('creates a private transcript and ZIP with merged PDF and non-PDF attachments', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cleaner-chat-package-'));
  try {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const pdfBytes = Buffer.from(await pdf.save());
    const messages: CapturedChatMessage[] = [
      {
        id: 'pdf-message',
        timestamp: 1_800_000_000,
        fromMe: false,
        kind: 'document',
        text: 'Adjunto de prueba',
        fileName: 'material.pdf',
        mimetype: 'application/pdf',
        hasMedia: true,
        raw: {},
      },
      {
        id: 'image-message',
        timestamp: 1_800_000_001,
        fromMe: false,
        kind: 'image',
        text: '',
        fileName: 'photo.jfif',
        mimetype: 'image/jpeg',
        hasMedia: true,
        raw: {},
      },
    ];
    const result = await packageChatExport({
      messages,
      downloads: [
        { message: messages[0], bytes: pdfBytes },
        { message: messages[1], bytes: Buffer.from('jfif test bytes') },
      ],
      outputDir: path.join(directory, 'export'),
      title: 'Prueba local',
      timeZone: 'America/Bogota',
    });

    const zipContents = execFileSync('unzip', ['-Z1', result.zipPath], { encoding: 'utf8' });
    assert.match(zipContents, /merged-documents\.pdf/);
    assert.match(zipContents, /conversation\.txt/);
    assert.match(zipContents, /photo\.jfif/);
    assert.doesNotMatch(zipContents, /material\.pdf/);
    assert.match(fs.readFileSync(result.textPath, 'utf8'), /Adjunto de prueba/);
    assert.equal(fs.statSync(result.textPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(result.zipPath).mode & 0o777, 0o600);
    assert.equal(result.attachmentCount, 2);
    assert.equal(result.pdfCount, 1);
    assert.equal(result.nonPdfAttachmentCount, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
