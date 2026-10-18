import type { Digest, DigestItem, PublicationStatus } from './types';

export interface ValidationIssue { path: string; code: string; message: string }
interface ErrorOptions {
  code?: string;
  details?: ValidationIssue[] | Record<string, unknown>;
  details_truncated?: boolean;
  retryable?: boolean;
  publication_status?: PublicationStatus;
}

export class HttpError extends Error {
  readonly code: string;
  readonly details: ValidationIssue[] | Record<string, unknown>;
  readonly details_truncated: boolean;
  readonly retryable: boolean;
  readonly publication_status?: PublicationStatus;
  constructor(public status: number, message: string, public headers: HeadersInit = {}, options: ErrorOptions = {}) {
    super(message);
    this.name = 'HttpError';
    this.code = options.code ?? ({ 400: 'invalid_request', 401: 'unauthorized', 404: 'not_found', 405: 'method_not_allowed', 409: 'conflict', 413: 'body_too_large', 415: 'unsupported_media_type', 503: 'service_unavailable' } as Record<number, string>)[status] ?? 'internal_error';
    this.details = options.details ?? {};
    this.details_truncated = options.details_truncated ?? false;
    this.retryable = options.retryable ?? status >= 500;
    this.publication_status = options.publication_status;
  }
}

export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateDigest(value: unknown, options: { requireItems?: boolean } = {}): Digest {
  const issues: ValidationIssue[] = [];
  let issueCount = 0;
  function invalid(path: string, code: string, message: string): void {
    issueCount++;
    if (issues.length < 50) issues.push({ path, code, message });
  }
  function record(input: unknown, path: string): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      invalid(path, 'invalid_type', 'Expected an object.');
      return {};
    }
    return input as Record<string, unknown>;
  }
  function string(input: unknown, path: string, empty = false): string {
    if (typeof input !== 'string') { invalid(path, 'invalid_type', 'Expected a string.'); return ''; }
    if (!empty && !input.trim()) invalid(path, 'empty_string', 'Expected a nonempty string.');
    return input;
  }
  function httpUrl(input: unknown, path: string): string {
    const text = string(input, path);
    if (typeof input !== 'string' || !text.trim()) return text;
    try {
      const url = new URL(text);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch { invalid(path, 'invalid_url', 'Expected an absolute HTTP(S) URL without credentials.'); }
    return text;
  }
  function timestamp(input: unknown, path: string): string {
    const text = string(input, path);
    if (typeof input !== 'string' || !text.trim()) return text;
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/.exec(text);
    if (!match || !isDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 || Number(match[6] ?? 0) > 23 || Number(match[7] ?? 0) > 59 || !Number.isFinite(Date.parse(text))) {
      invalid(path, 'invalid_timestamp', 'Expected an ISO timestamp with a real calendar date and explicit timezone.');
    }
    return text;
  }
  const input = record(value, 'digest');
  const title = string(input.title, 'title');
  const source = string(input.source, 'source');
  let items: DigestItem[] = [];
  if (!Array.isArray(input.items)) invalid('items', 'invalid_type', 'Expected an array.');
  else {
    if (options.requireItems && input.items.length === 0) invalid('items', 'empty_items', 'At least one story is required.');
    items = input.items.map((value, i): DigestItem => {
      const item = record(value, `items[${i}]`);
      const field = (name: string) => `items[${i}].${name}`;
      return {
        group: string(item.group, field('group')), group_url: httpUrl(item.group_url, field('group_url')),
        headline: string(item.headline, field('headline')), body: string(item.body, field('body'), true),
        post_url: httpUrl(item.post_url, field('post_url')), category: string(item.category, field('category'), true),
        posted_at: timestamp(item.posted_at, field('posted_at')),
      };
    });
  }
  if (issueCount) throw new HttpError(400, 'Digest validation failed', {}, { code: 'validation_failed', details: issues, details_truncated: issueCount > issues.length });
  // Client-supplied date/receipt/identity fields never control server publication.
  return { title, source, items };
}

export function parseDigestJson(bytes: ArrayBuffer): unknown {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { throw new HttpError(400, 'Request body is not valid UTF-8', {}, { code: 'invalid_utf8' }); }
  try { return JSON.parse(text); }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    const positionMatch = /position (\d+)/.exec(message);
    const position = positionMatch ? Number(positionMatch[1]) : message.includes('Unexpected end of JSON input') ? text.length : undefined;
    const details: Record<string, unknown> = {};
    if (position !== undefined && position <= text.length) {
      const lines = text.slice(0, position).split('\n');
      Object.assign(details, { position, line: lines.length, column: lines[lines.length - 1].length + 1, position_unit: 'utf16_code_units' });
    }
    throw new HttpError(400, 'Request body is not valid JSON', {}, { code: 'invalid_json', details });
  }
}

export async function readLimited(request: Request, limit: number, onBytes?: (bytes: number) => void): Promise<ArrayBuffer> {
  const tooLarge = () => new HttpError(413, 'Request exceeds the allowed body size', {}, { details: { limit_bytes: limit } });
  const length = request.headers.get('content-length');
  if (length && Number(length) > limit) throw tooLarge();
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      onBytes?.(size);
      if (size > limit) {
        try { await reader.cancel(); } catch { /* Preserve the size classification. */ }
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output.buffer;
}
