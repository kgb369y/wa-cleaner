// Cliente mínimo de la Bot API de Telegram con fetch nativo (sin dependencias).

import { errMsg, log, sleep } from './utils.ts';

export class TelegramError extends Error {
  status: number;
  /** true = no tiene sentido reintentar (token inválido, chat inexistente, bot bloqueado...). */
  fatal: boolean;
  constructor(message: string, status: number, fatal = false) {
    super(message);
    this.name = 'TelegramError';
    this.status = status;
    this.fatal = fatal;
  }
}

export class Telegram {
  token: string;
  chatId: string;

  constructor(token: string, chatId: string) {
    this.token = token;
    this.chatId = chatId;
  }

  async call(method: string, body: Record<string, unknown> | FormData, tries = 5): Promise<any> {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    for (let i = 1; i <= tries; i++) {
      let res: Response;
      try {
        res =
          body instanceof FormData
            ? await fetch(url, { method: 'POST', body })
            : await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              });
      } catch (e) {
        if (i === tries) throw new TelegramError(`Error de red: ${errMsg(e)}`, 0);
        await sleep(2000 * i);
        continue;
      }
      const json: any = await res.json().catch(() => null);
      if (json?.ok) return json.result;

      if (res.status === 429) {
        const wait = (json?.parameters?.retry_after ?? 5) + 1;
        log(`Telegram pide esperar ${wait}s (429)…`);
        await sleep(wait * 1000);
        continue;
      }
      if (res.status >= 500 && i < tries) {
        await sleep(2000 * i);
        continue;
      }
      const desc: string = json?.description ?? `HTTP ${res.status}`;
      const fatal = res.status === 401 || res.status === 403 || (res.status === 400 && /chat not found/i.test(desc));
      throw new TelegramError(desc, res.status, fatal);
    }
    throw new TelegramError('Reintentos agotados', 0);
  }

  getMe(): Promise<{ id: number; username: string; first_name: string }> {
    return this.call('getMe', {});
  }

  /** Envía texto (lo parte en trozos de ≤4000 caracteres). Devuelve el id del primer mensaje. */
  async sendText(text: string): Promise<number> {
    const chunks: string[] = [];
    let rest = text.length ? text : '(vacío)';
    while (rest.length > 4000) {
      let cut = rest.lastIndexOf('\n', 4000);
      if (cut < 2000) cut = 4000;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    chunks.push(rest);
    let first = 0;
    for (const c of chunks) {
      const r = await this.call('sendMessage', { chat_id: this.chatId, text: c, disable_web_page_preview: true });
      if (!first) first = r.message_id;
    }
    return first;
  }

  /** Envía un archivo como documento (conserva calidad original). */
  async sendDocument(buf: Buffer, filename: string, mime: string | undefined, caption?: string): Promise<number> {
    const form = new FormData();
    form.append('chat_id', this.chatId);
    if (caption) form.append('caption', caption.slice(0, 1024));
    form.append('document', new Blob([buf as any], { type: mime || 'application/octet-stream' }), filename);
    const r = await this.call('sendDocument', form);
    return r.message_id;
  }
}
