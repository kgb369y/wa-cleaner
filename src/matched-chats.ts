import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { extract } from './extract.ts';
import { reviver } from './serialize.ts';
import { normalizeText } from './utils.ts';

export interface MatchedChat {
  chatJid: string;
  aliases: string[];
  messageCount: number;
  triggerCount: number;
  matchedKeywords: string[];
}

function normalizedJid(jid: unknown): string | undefined {
  if (typeof jid !== 'string' || !jid || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return undefined;
  return jid.replace(/:\d+(?=@)/, '');
}

function findRoot(parent: Map<string, string>, value: string): string {
  const current = parent.get(value);
  if (!current) {
    parent.set(value, value);
    return value;
  }
  if (current === value) return value;
  const root = findRoot(parent, current);
  parent.set(value, root);
  return root;
}

function union(parent: Map<string, string>, first: string, second: string): void {
  const a = findRoot(parent, first);
  const b = findRoot(parent, second);
  if (a !== b) parent.set(b, a);
}

function messageAliases(message: any, lidAliases: Map<string, string>): string[] {
  const aliases = new Set(
    [normalizedJid(message?.key?.remoteJid), normalizedJid(message?.key?.remoteJidAlt)]
      .filter((jid): jid is string => !!jid),
  );
  for (const alias of [...aliases]) {
    const mapped = lidAliases.get(alias);
    if (mapped) aliases.add(mapped);
  }
  return [...aliases];
}

function matchingKeywords(message: any, keywords: string[]): string[] {
  const extracted = extract(message);
  if (!extracted) return [];
  const haystack = normalizeText([extracted.text, extracted.fileName].filter(Boolean).join(' '));
  if (!haystack) return [];

  return keywords.filter((keyword) => {
    const normalized = normalizeText(keyword.trim());
    if (!normalized) return false;
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}`, 'u').test(haystack);
  });
}

function canonicalJid(aliases: Set<string>): string {
  const values = [...aliases];
  return values.find((jid) => jid.endsWith('@g.us'))
    ?? values.find((jid) => jid.endsWith('@s.whatsapp.net'))
    ?? values[0];
}

export async function listMatchedChats(
  capturePath: string,
  keywords: string[],
  lidAliases: Map<string, string> = new Map(),
): Promise<MatchedChat[]> {
  const parent = new Map<string, string>();
  const messagesByRoot = new Map<string, Set<string>>();
  const triggersByRoot = new Map<string, Set<string>>();
  const aliasesByRoot = new Map<string, Set<string>>();
  const keywordsByRoot = new Map<string, Set<string>>();

  const readMessages = async function* (): AsyncGenerator<any> {
    const lines = createInterface({ input: createReadStream(capturePath), crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      try {
        const message = (JSON.parse(line, reviver) as { message?: any }).message;
        if (message) yield message;
      } catch (error) {
        throw new Error(`Línea ${lineNumber} inválida en captura de historial: ${error instanceof Error ? error.message : error}`);
      }
    }
  };

  for await (const message of readMessages()) {
    const aliases = messageAliases(message, lidAliases);
    if (!aliases.length) continue;
    for (let index = 1; index < aliases.length; index++) union(parent, aliases[0], aliases[index]);
  }

  for await (const message of readMessages()) {
    const aliases = messageAliases(message, lidAliases);
    if (!aliases.length) continue;
    const root = findRoot(parent, aliases[0]);
    let chatAliases = aliasesByRoot.get(root);
    if (!chatAliases) aliasesByRoot.set(root, (chatAliases = new Set()));
    for (const alias of aliases) chatAliases.add(alias);

    if (typeof message?.key?.id !== 'string' || !message.key.id) continue;
    const messageIdentity = `${message.key.fromMe === true ? 1 : 0}|${message.key.id}`;
    let chatMessages = messagesByRoot.get(root);
    if (!chatMessages) messagesByRoot.set(root, (chatMessages = new Set()));
    chatMessages.add(messageIdentity);

    const matches = matchingKeywords(message, keywords);
    if (!matches.length) continue;
    let chatTriggers = triggersByRoot.get(root);
    if (!chatTriggers) triggersByRoot.set(root, (chatTriggers = new Set()));
    chatTriggers.add(messageIdentity);
    let chatKeywords = keywordsByRoot.get(root);
    if (!chatKeywords) keywordsByRoot.set(root, (chatKeywords = new Set()));
    for (const match of matches) chatKeywords.add(match);
  }

  const results: MatchedChat[] = [];
  for (const [root, triggerIds] of triggersByRoot) {
    const aliases = aliasesByRoot.get(root) ?? new Set([root]);
    results.push({
      chatJid: canonicalJid(aliases),
      aliases: [...aliases].sort(),
      messageCount: messagesByRoot.get(root)?.size ?? 0,
      triggerCount: triggerIds.size,
      matchedKeywords: [...(keywordsByRoot.get(root) ?? [])].sort(),
    });
  }

  return results.sort((first, second) => first.chatJid.localeCompare(second.chatJid));
}
