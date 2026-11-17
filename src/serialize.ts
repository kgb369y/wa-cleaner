// Serialización JSON de mensajes de WhatsApp conservando los campos binarios
// (mediaKey, fileSha256, etc.), necesarios para poder descargar el archivo más tarde.

export function replacer(_key: string, value: any): any {
  if (value instanceof Uint8Array) {
    return { __bytes: Buffer.from(value).toString('base64') };
  }
  // JSON.stringify llama antes a Buffer.toJSON(), que produce {type:'Buffer', data:[...]}
  if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
    return { __bytes: Buffer.from(value.data).toString('base64') };
  }
  return value;
}

export function reviver(_key: string, value: any): any {
  if (value && typeof value === 'object' && typeof value.__bytes === 'string') {
    return Buffer.from(value.__bytes, 'base64');
  }
  return value;
}

export const serializeMessage = (m: unknown): string => JSON.stringify(m, replacer);
export const parseMessage = (s: string): any => JSON.parse(s, reviver);
