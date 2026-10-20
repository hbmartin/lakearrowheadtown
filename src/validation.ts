import type { Digest, DigestItem, StoredItem, StoryUpdate } from './types';
import { boundary, declaredBodyBytes, HttpError, type ValidationIssue } from './errors';
export { HttpError } from './errors';

export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  return !!match && isDate(match[1]) && Number(match[2]) <= 23 && Number(match[3]) <= 59 && Number(match[4]) <= 59
    && Number(match[6] ?? 0) <= 23 && Number(match[7] ?? 0) <= 59 && Number.isFinite(Date.parse(value));
}

export function validateDigest(value: unknown, options: { requireItems?: boolean } = {}): Digest {
  const issues: ValidationIssue[] = [];
  let issueCount = 0;
  function invalid(path: string, code: string, message: string): void {
    issueCount++;
    if (issues.length < 50) issues.push({ path, code, message });
  }
  function record(input: unknown, path: string): Record<string, unknown> | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      invalid(path, 'invalid_type', 'Expected an object.');
      return undefined;
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
    if (!isTimestamp(text)) {
      invalid(path, 'invalid_timestamp', 'Expected an ISO timestamp with a real calendar date and explicit timezone.');
    }
    return text;
  }
  const input = record(value, 'digest');
  if (!input) throw new HttpError(400, 'Digest validation failed', {}, { code: 'validation_failed', details: issues });
  const title = string(input.title, 'title');
  const source = string(input.source, 'source');
  let items: DigestItem[] = [];
  if (!Array.isArray(input.items)) invalid('items', 'invalid_type', 'Expected an array.');
  else {
    if (options.requireItems && input.items.length === 0) invalid('items', 'empty_items', 'At least one story is required.');
    items = input.items.flatMap((value, i): DigestItem[] => {
      const item = record(value, `items[${i}]`);
      if (!item) return [];
      const field = (name: string) => `items[${i}].${name}`;
      return [{
        group: string(item.group, field('group')), group_url: httpUrl(item.group_url, field('group_url')),
        headline: string(item.headline, field('headline')), body: string(item.body, field('body'), true),
        post_url: httpUrl(item.post_url, field('post_url')), category: string(item.category, field('category'), true),
        posted_at: timestamp(item.posted_at, field('posted_at')),
      }];
    });
  }
  if (issueCount) throw new HttpError(400, 'Digest validation failed', {}, { code: 'validation_failed', details: issues, details_truncated: issueCount > issues.length });
  // Client-supplied date/receipt/identity fields never control server publication.
  return { title, source, items };
}

export function validateUpdate(value: unknown): StoryUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Update validation failed', {}, { code: 'validation_failed', details: [{ path: 'update', code: 'invalid_type', message: 'Expected an object.' }] });
  }
  const input = value as Record<string, unknown>;
  try {
    const item = validateDigest({ title: 'Update', source: 'update', items: [{
      ...input, headline: 'Update', category: '', body: input.body === undefined ? '' : input.body,
      group_url: input.group_url === undefined ? input.post_url : input.group_url,
    }] }).items[0];
    return { post_url: item.post_url, group: item.group, posted_at: item.posted_at, body: item.body,
      ...(input.group_url !== undefined ? { group_url: item.group_url } : {}) };
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    throw new HttpError(error.status, 'Update validation failed', {}, { code: error.code, details_truncated: error.details_truncated,
      details: Array.isArray(error.details) ? error.details.map(issue => ({ ...issue, path: issue.path.replace(/^items\[0\]\./, '') })) : error.details });
  }
}

// Incoming digest validation deliberately ignores updates; only stored sources may carry them.
export function validateStoredItems(value: unknown): StoredItem[] {
  const digest = validateDigest(value);
  const inputs = (value as { items: Record<string, unknown>[] }).items;
  return digest.items.map((item, index) => {
    const updates = inputs[index].updates;
    if (updates === undefined) return item;
    if (!Array.isArray(updates)) throw new HttpError(400, 'Stored updates must be an array');
    return { ...item, updates: updates.map(value => {
      const update = validateUpdate(value);
      if (!isTimestamp(value.received_at)) throw new HttpError(400, 'Stored update receipt timestamp is invalid');
      return { ...update, received_at: value.received_at };
    }) };
  });
}

export function parseDigestJson(bytes: ArrayBuffer): unknown {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { throw new HttpError(400, 'Request body is not valid UTF-8', {}, { code: 'invalid_utf8' }); }
  try { return JSON.parse(text); }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    // V8's location-bearing errors have fixed prefixes and a location suffix.
    // Other formats quote arbitrary input, so never search them for "position".
    const positionMatch = /^(?:Expected (?:property name or '\}'|double-quoted property name|':' after property name|',' or '\}' after property value|',' or '\]' after array element) in JSON|Unexpected non-whitespace character after JSON|Unterminated string in JSON|Bad (?:control character in string literal|escaped character|Unicode escape) in JSON|No number after minus sign in JSON|Unexpected (?:number|string) in JSON|Exponent part is missing a number in JSON|Unterminated fractional number in JSON) at position (\d+) \(line (\d+) column (\d+)\)$/.exec(message);
    const position = positionMatch ? Number(positionMatch[1]) : message === 'Unexpected end of JSON input' ? text.length : undefined;
    const details: Record<string, unknown> = {};
    if (position !== undefined && Number.isSafeInteger(position) && position >= 0 && position <= text.length) {
      const lines = text.slice(0, position).split(/\r\n|\r|\n/);
      const column = lines[lines.length - 1].length + 1;
      if (!positionMatch || (Number(positionMatch[2]) === lines.length && Number(positionMatch[3]) === column)) {
        Object.assign(details, { position, line: lines.length, column, position_unit: 'utf16_code_units' });
      }
    }
    throw new HttpError(400, 'Request body is not valid JSON', {}, { code: 'invalid_json', details });
  }
}

export async function readLimited(request: Request, limit: number, onBytes?: (bytes: number) => void): Promise<ArrayBuffer> {
  const tooLarge = () => new HttpError(413, 'Request exceeds the allowed body size', {}, { details: { limit_bytes: limit } });
  const length = declaredBodyBytes(request);
  if (length !== undefined && length > limit) throw tooLarge();
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await boundary('body', () => reader.read());
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
