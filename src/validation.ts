import type { Digest, DigestItem } from './types';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function invalid(message: string): never { throw new HttpError(400, message); }

export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim())) invalid(`${field} must be a string${empty ? '' : ' and not empty'}`);
  return value;
}

function httpUrl(value: unknown, field: string): string {
  const text = string(value, field);
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid(`${field} must be an HTTP(S) URL`);
  } catch { invalid(`${field} must be an HTTP(S) URL`); }
  return text;
}

function timestamp(value: unknown, field: string): string {
  const text = string(value, field);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/.exec(text);
  if (!match || !isDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 || Number(match[6] ?? 0) > 23 || Number(match[7] ?? 0) > 59 || !Number.isFinite(Date.parse(text))) {
    invalid(`${field} must be an ISO timestamp with a timezone`);
  }
  return text;
}

export function validateDigest(value: unknown): Digest {
  const input = record(value, 'digest');
  const date = string(input.date, 'date');
  if (!isDate(date)) invalid('date must be a real YYYY-MM-DD calendar date');
  if (!Array.isArray(input.items)) invalid('items must be an array');
  const items = input.items.map((value, i): DigestItem => {
    const item = record(value, `items[${i}]`);
    const field = (name: string) => `items[${i}].${name}`;
    return {
      group: string(item.group, field('group')),
      group_url: httpUrl(item.group_url, field('group_url')),
      headline: string(item.headline, field('headline')),
      body: string(item.body, field('body'), true),
      post_url: httpUrl(item.post_url, field('post_url')),
      category: string(item.category, field('category'), true),
      posted_at: timestamp(item.posted_at, field('posted_at')),
    };
  });
  return { date, title: string(input.title, 'title'), source: string(input.source, 'source'), items };
}

export async function readLimited(request: Request, limit: number): Promise<ArrayBuffer> {
  const length = request.headers.get('content-length');
  if (length && Number(length) > limit) throw new HttpError(413, 'Request is too large');
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, 'Request is too large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output.buffer;
}
