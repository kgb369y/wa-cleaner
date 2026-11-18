import fs from 'node:fs';
import path from 'node:path';
import { replacer } from './serialize.ts';

export class HistoryCapture {
  private readonly file: number;
  private readonly seen = new Set<string>();
  private closed = false;
  count = 0;

  constructor(readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(filePath), 0o700);
    this.file = fs.openSync(filePath, 'wx', 0o600);
    fs.chmodSync(filePath, 0o600);
  }

  append(messages: any[]): number {
    if (this.closed) throw new Error('La captura de historial ya está cerrada');

    let added = 0;
    for (const message of messages) {
      const key = message?.key;
      const id = typeof key?.id === 'string' ? key.id : '';
      const chat = typeof key?.remoteJid === 'string' ? key.remoteJid : '';
      const alternateChat = typeof key?.remoteJidAlt === 'string' ? key.remoteJidAlt : '';
      const identity = id ? `${chat}|${alternateChat}|${key?.fromMe === true ? 1 : 0}|${id}` : '';
      if (identity && this.seen.has(identity)) continue;

      const line = `${JSON.stringify({ capturedAt: Date.now(), message }, replacer)}\n`;
      fs.writeSync(this.file, line);
      if (identity) this.seen.add(identity);
      this.count++;
      added++;
    }

    return added;
  }

  close(): void {
    if (this.closed) return;
    fs.closeSync(this.file);
    this.closed = true;
  }
}
