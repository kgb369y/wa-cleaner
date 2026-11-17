import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Carga .env (función nativa de Node >= 20.12). Si no existe, se usan las variables del entorno.
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* sin .env */
}

const fromRoot = (p: string) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const flag = (v: string | undefined, def: boolean) =>
  v == null || v.trim() === '' ? def : v.trim().toLowerCase() !== 'false';

export const config = {
  /** Por seguridad es true salvo que DRY_RUN sea exactamente "false". */
  dryRun: flag(process.env.DRY_RUN, true),
  telegramToken: (process.env.TELEGRAM_BOT_TOKEN ?? '').trim(),
  telegramChatId: (process.env.TELEGRAM_CHAT_ID ?? '').trim(),
  syncFullHistory: flag(process.env.SYNC_FULL_HISTORY, true),
  authDir: fromRoot(process.env.AUTH_DIR ?? './auth'),
  dbPath: fromRoot(process.env.DB_PATH ?? './data/wa-cleaner.db'),
  rulesFile: fromRoot(process.env.RULES_FILE ?? './rules.json'),
  tz: process.env.TZ || 'America/Bogota',
  logLevel: process.env.LOG_LEVEL ?? 'silent',
  checkMaxWaitMinutes: Number(process.env.CHECK_MAX_WAIT_MINUTES ?? 20) || 20,
};

export function requireTelegram(): { token: string; chatId: string } {
  if (!config.telegramToken || !config.telegramChatId) {
    throw new Error(
      'Faltan TELEGRAM_BOT_TOKEN y/o TELEGRAM_CHAT_ID en .env',
    );
  }
  return { token: config.telegramToken, chatId: config.telegramChatId };
}

// ---------------------------------------------------------------- reglas

export interface RescueRules {
  keywords: string[];
  forwardAllDocuments: boolean;
  documentExtensions: string[];
  savedMessages: { forwardLinks: boolean; forwardMedia: boolean; forwardAllText: boolean };
  ignoreChats: string[];
  maxFileSizeMB: number;
}

export interface Rules {
  rescue: RescueRules;
  protectedChats: string[];
  limits: { maxForwardsPerDay: number; minDelaySec: number; maxDelaySec: number; maxAttempts: number };
}

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter((x) => x.length > 0) : [];
const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);

export function loadRules(file: string = config.rulesFile): Rules {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`No pude leer/parsear ${file}: ${e instanceof Error ? e.message : e}`);
  }
  const r = raw.rescue ?? {};
  const s = r.savedMessages ?? {};
  const l = raw.limits ?? {};
  const rules: Rules = {
    rescue: {
      keywords: strArr(r.keywords),
      forwardAllDocuments: bool(r.forwardAllDocuments, true),
      documentExtensions: strArr(r.documentExtensions).map((e) => e.toLowerCase().replace(/^\./, '')),
      savedMessages: {
        forwardLinks: bool(s.forwardLinks, true),
        forwardMedia: bool(s.forwardMedia, true),
        forwardAllText: bool(s.forwardAllText, false),
      },
      ignoreChats: strArr(r.ignoreChats),
      maxFileSizeMB: num(r.maxFileSizeMB, 45),
    },
    protectedChats: strArr(raw.protectedChats),
    limits: {
      maxForwardsPerDay: num(l.maxForwardsPerDay, 300),
      minDelaySec: num(l.minDelaySec, 3),
      maxDelaySec: num(l.maxDelaySec, 9),
      maxAttempts: Math.max(1, num(l.maxAttempts, 3)),
    },
  };
  if (rules.limits.maxDelaySec < rules.limits.minDelaySec) {
    rules.limits.maxDelaySec = rules.limits.minDelaySec;
  }
  return rules;
}
