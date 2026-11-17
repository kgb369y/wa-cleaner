// Registro local (SQLite integrado en Node, sin dependencias nativas).
// Una sola tabla `rescue` hace de cola de trabajo Y de registro de IDs ya reenviados:
//   pending -> aún por enviar | done -> ya reenviado | failed -> agotó reintentos | skipped -> descartado

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Status = 'pending' | 'done' | 'failed' | 'skipped';

export interface NewJob {
  id: string;
  chat_jid: string;
  chat_name: string | null;
  sender: string | null;
  ts: number; // segundos (epoch) del mensaje
  rule: string;
  with_media: boolean;
  payload: string; // mensaje crudo serializado
}

export interface Job {
  id: string;
  chat_jid: string;
  chat_name: string | null;
  sender: string | null;
  ts: number;
  rule: string;
  with_media: number;
  status: Status;
  attempts: number;
  error: string | null;
  payload: string;
  telegram_message_id: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rescue (
  id                  TEXT PRIMARY KEY,
  chat_jid            TEXT NOT NULL,
  chat_name           TEXT,
  sender              TEXT,
  ts                  INTEGER NOT NULL,
  rule                TEXT NOT NULL,
  with_media          INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  attempts            INTEGER NOT NULL DEFAULT 0,
  error               TEXT,
  payload             TEXT NOT NULL,
  telegram_message_id INTEGER,
  created_at          INTEGER NOT NULL,
  done_at             INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rescue_status_ts ON rescue(status, ts);
`;

export class Store {
  db: DatabaseSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const previousUmask = process.umask(0o077);
    try {
      this.db = new DatabaseSync(file);
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
      this.db.exec(SCHEMA);
    } finally {
      process.umask(previousUmask);
    }
    fs.chmodSync(file, 0o600);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${file}${suffix}`;
      if (fs.existsSync(sidecar)) fs.chmodSync(sidecar, 0o600);
    }
  }

  /** Inserta ignorando los ya conocidos. Devuelve cuántos eran nuevos. */
  enqueueMany(jobs: NewJob[]): number {
    if (jobs.length === 0) return 0;
    const st = this.db.prepare(
      `INSERT OR IGNORE INTO rescue
         (id, chat_jid, chat_name, sender, ts, rule, with_media, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let added = 0;
    this.db.exec('BEGIN');
    try {
      for (const j of jobs) {
        const r = st.run(
          j.id,
          j.chat_jid,
          j.chat_name ?? null,
          j.sender ?? null,
          j.ts,
          j.rule,
          j.with_media ? 1 : 0,
          j.payload,
          Date.now(),
        );
        added += Number(r.changes);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return added;
  }

  /** El pendiente más antiguo. */
  nextPending(): Job | undefined {
    return this.db
      .prepare("SELECT * FROM rescue WHERE status = 'pending' ORDER BY ts ASC LIMIT 1")
      .get() as unknown as Job | undefined;
  }

  markDone(id: string, telegramMessageId: number | null) {
    this.db
      .prepare("UPDATE rescue SET status='done', error=NULL, telegram_message_id=?, done_at=? WHERE id=?")
      .run(telegramMessageId ?? null, Date.now(), id);
  }

  markDeliveryProgress(id: string, telegramMessageId: number) {
    this.db
      .prepare("UPDATE rescue SET telegram_message_id=? WHERE id=?")
      .run(telegramMessageId, id);
  }

  markSkipped(id: string, reason: string) {
    this.db.prepare("UPDATE rescue SET status='skipped', error=?, done_at=? WHERE id=?").run(reason, Date.now(), id);
  }

  /** Suma un intento fallido; al llegar a maxAttempts pasa a 'failed'. */
  markAttemptFailed(id: string, error: string, maxAttempts: number) {
    this.db
      .prepare(
        `UPDATE rescue
            SET attempts = attempts + 1,
                error = ?,
                status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
          WHERE id = ?`,
      )
      .run(error, maxAttempts, id);
  }

  /** Cuántos se reenviaron desde `sinceMs` (epoch ms). */
  doneSince(sinceMs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM rescue WHERE status='done' AND done_at >= ?")
      .get(sinceMs) as unknown as { c: number };
    return Number(row.c);
  }

  statusCounts(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM rescue GROUP BY status').all() as unknown as {
      status: string;
      n: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }

  ruleCounts(status: Status = 'pending', limit = 15): { rule: string; n: number }[] {
    const rows = this.db
      .prepare('SELECT rule, COUNT(*) AS n FROM rescue WHERE status = ? GROUP BY rule ORDER BY n DESC LIMIT ?')
      .all(status, limit) as unknown as { rule: string; n: number }[];
    return rows.map((r) => ({ rule: r.rule, n: Number(r.n) }));
  }

  sample(status: Status = 'pending', limit = 15): Pick<Job, 'chat_jid' | 'chat_name' | 'ts' | 'rule' | 'with_media'>[] {
    return this.db
      .prepare('SELECT chat_jid, chat_name, ts, rule, with_media FROM rescue WHERE status = ? ORDER BY ts DESC LIMIT ?')
      .all(status, limit) as unknown as Pick<Job, 'chat_jid' | 'chat_name' | 'ts' | 'rule' | 'with_media'>[];
  }

  listJobs(status: Status = 'pending', limit = 100): Job[] {
    return this.db
      .prepare('SELECT * FROM rescue WHERE status = ? ORDER BY ts DESC LIMIT ?')
      .all(status, limit) as unknown as Job[];
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ya cerrada */
    }
  }
}
