import fs from 'node:fs/promises';
import path from 'node:path';

function asJid(value: string, defaultServer: 'lid' | 's.whatsapp.net'): string | undefined {
  const normalized = value.trim().replace(/:\d+(?=@)/, '');
  if (!normalized) return undefined;
  if (normalized.includes('@')) return normalized;
  if (!/^\d+$/.test(normalized)) return undefined;
  return `${normalized}@${defaultServer}`;
}

export async function loadLidAliases(authDirectories: string[]): Promise<Map<string, string>> {
  const aliases = new Map<string, string>();
  for (const directory of new Set(authDirectories.map((entry) => path.resolve(entry)))) {
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    for (const name of names) {
      const match = /^lid-mapping-(.+)_reverse\.json$/.exec(name);
      if (!match) continue;

      const rawPn = await fs.readFile(path.join(directory, name), 'utf8');
      const pnValue: unknown = JSON.parse(rawPn);
      if (typeof pnValue !== 'string') {
        throw new Error(`Formato inesperado en el mapeo LID ${name}`);
      }

      const lidJid = asJid(match[1], 'lid');
      const pnJid = asJid(pnValue, 's.whatsapp.net');
      if (lidJid && pnJid) aliases.set(lidJid, pnJid);
    }
  }
  return aliases;
}
