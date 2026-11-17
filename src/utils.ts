export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const randInt = (min: number, max: number) =>
  Math.floor(min + Math.random() * (max - min + 1));

/** Pausa aleatoria entre minSec y maxSec segundos (comportamiento menos "robótico"). */
export const sleepRandom = (minSec: number, maxSec: number) =>
  sleep(randInt(minSec * 1000, maxSec * 1000));

export function log(...args: unknown[]) {
  console.log(new Date().toLocaleTimeString('es-CO', { hour12: false }), ...args);
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

export class MediaTooLargeError extends Error {
  constructor(readonly sizeBytes: number, readonly maxBytes: number) {
    super(`El archivo supera el límite de ${maxBytes} bytes`);
    this.name = 'MediaTooLargeError';
  }
}

/** minúsculas + sin tildes, para comparar palabras clave. */
export function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Convierte number | bigint | string | Long ({low, high}) a number. */
export function toNumber(x: any): number {
  if (x == null) return 0;
  if (typeof x === 'number') return x;
  if (typeof x === 'bigint') return Number(x);
  if (typeof x === 'string') return Number(x) || 0;
  if (typeof x === 'object') {
    if (typeof x.toNumber === 'function') return x.toNumber();
    if ('low' in x) return (x.high >>> 0) * 4294967296 + (x.low >>> 0);
  }
  return 0;
}

/** "5731...:12@s.whatsapp.net" -> "5731...@s.whatsapp.net" (quita el sufijo de dispositivo). */
export const stripDevice = (jid: string): string => jid.replace(/:\d+(?=@)/, '');

/** "5731...:12@s.whatsapp.net" -> "5731..." */
export const shortJid = (jid: string): string => jid.split('@')[0].split(':')[0];

export function formatDate(tsSec: number, tz: string): string {
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: tz,
  }).format(new Date(tsSec * 1000));
}
