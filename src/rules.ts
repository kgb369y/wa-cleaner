// Motor de reglas "conservar" (rescate a Telegram). Módulo puro: fácil de probar.

import type { RescueRules } from './config.ts';
import type { Extracted } from './extract.ts';
import { normalizeText } from './utils.ts';

export const URL_RE = /(https?:\/\/|www\.)\S+/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface ChatCtx {
  chatJid: string;
  chatName?: string | null;
  isSelfChat: boolean;
}

export interface Decision {
  /** Etiqueta de la regla que coincidió, p. ej. "keyword:factura", "document:pdf", "saved:link". */
  rule: string;
  /** true = descargar y enviar el archivo; false = enviar solo el texto. */
  withMedia: boolean;
}

/** ¿El chat coincide con alguna entrada de la lista (por JID o por nombre, sin tildes ni mayúsculas)? */
export function chatMatches(list: string[], jid: string, name?: string | null): boolean {
  const j = normalizeText(jid);
  const n = name ? normalizeText(name) : '';
  return list.some((entry) => {
    const e = normalizeText(entry);
    return e.length > 0 && (j.includes(e) || (n !== '' && n.includes(e)));
  });
}

export function extensionOf(ex: Extracted): string {
  const m = /\.([a-z0-9]{1,6})$/i.exec(ex.fileName ?? '');
  if (m) return m[1].toLowerCase();
  if ((ex.mimetype ?? '').toLowerCase().startsWith('application/pdf')) return 'pdf';
  return '';
}

export function makeEvaluator(r: RescueRules) {
  const matchers = r.keywords.map((kw) => {
    const norm = normalizeText(kw.trim());
    return { kw: norm, re: new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(norm)}`, 'u') };
  });
  const docExts = new Set(r.documentExtensions);

  return function evaluate(ex: Extracted, ctx: ChatCtx): Decision | null {
    if (ex.kind === 'sticker') return null;
    if (chatMatches(r.ignoreChats, ctx.chatJid, ctx.chatName)) return null;

    // 1) Mensajes guardados (chat contigo misma)
    if (ctx.isSelfChat) {
      if (r.savedMessages.forwardMedia && ex.hasMedia) return { rule: 'saved:media', withMedia: true };
      if (r.savedMessages.forwardLinks && URL_RE.test(ex.text)) return { rule: 'saved:link', withMedia: ex.hasMedia };
      if (r.savedMessages.forwardAllText && ex.text.trim()) return { rule: 'saved:text', withMedia: ex.hasMedia };
    }

    // 2) Palabras clave en texto, pie de foto o nombre de archivo
    const hay = normalizeText([ex.text, ex.fileName].filter(Boolean).join(' '));
    if (hay) {
      for (const m of matchers) {
        if (m.re.test(hay)) return { rule: `keyword:${m.kw}`, withMedia: ex.hasMedia };
      }
    }

    // 3) Documentos adjuntos por extensión
    if (r.forwardAllDocuments && ex.kind === 'document') {
      const ext = extensionOf(ex);
      if (ext && docExts.has(ext)) return { rule: `document:${ext}`, withMedia: true };
    }
    return null;
  };
}
