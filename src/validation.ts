import { boundary, declaredBodyBytes, HttpError } from './errors';
import { clientRefSchema, digestSchema, digestSubmissionSchema, updateSchema } from './schemas/content';
import { isTimestamp } from './schemas/primitives';
import { parseSchema } from './schemas/shared';
import type { Digest, StoredItem, StoryUpdate } from './types';
export { HttpError } from './errors';
export { isClientRef, isDate, isTimestamp } from './schemas/primitives';

export function validateClientRef(value: unknown): string {
  const result = clientRefSchema.safeParse(value);
  if (!result.success) throw new HttpError(400, 'client_ref must be a nonblank string of at most 128 characters without control characters.', {}, {
    code: 'validation_failed', details: [{ path: 'client_ref', code: 'invalid_client_ref', message: 'Expected a nonblank string of at most 128 characters without control characters.' }],
  });
  return result.data;
}

export function validateDigest(value: unknown, options: { requireItems?: boolean } = {}): Digest {
  return parseSchema(options.requireItems ? digestSubmissionSchema : digestSchema, value, 'Digest validation failed', 'digest');
}

export function validateUpdate(value: unknown): StoryUpdate {
  return parseSchema(updateSchema, value, 'Update validation failed', 'update');
}

// Incoming digest validation deliberately ignores updates; only stored sources may carry them.
export function validateStoredDigest(value: unknown): Digest & { items: StoredItem[]; publisher_fingerprint?: string; retracted_at?: string } {
  const digest = validateDigest(value);
  const metadata = value as Record<string, unknown>;
  if (metadata.publisher_fingerprint !== undefined && (typeof metadata.publisher_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.publisher_fingerprint))) throw new HttpError(400, 'Stored publisher fingerprint is invalid');
  if (metadata.retracted_at !== undefined && (!isTimestamp(metadata.retracted_at) || digest.items.length)) throw new HttpError(400, 'Stored retraction is invalid');
  const inputs = (value as { items: Record<string, unknown>[] }).items;
  return { ...digest, ...(metadata.publisher_fingerprint === undefined ? {} : { publisher_fingerprint: metadata.publisher_fingerprint as string }),
    ...(metadata.retracted_at === undefined ? {} : { retracted_at: metadata.retracted_at as string }), items: digest.items.map((item, index) => {
    const updates = inputs[index].updates;
    if (updates === undefined) return item;
    if (!Array.isArray(updates)) throw new HttpError(400, 'Stored updates must be an array');
    return { ...item, updates: updates.map(value => {
      const update = validateUpdate(value);
      if (!isTimestamp(value.received_at)) throw new HttpError(400, 'Stored update receipt timestamp is invalid');
      return { ...update, received_at: value.received_at };
    }) };
  }) };
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
