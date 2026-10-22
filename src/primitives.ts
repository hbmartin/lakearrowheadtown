import { createHash } from 'node:crypto';

export const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function httpUrl(value: unknown): value is string {
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
export function fingerprint(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
