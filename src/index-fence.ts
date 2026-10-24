import { HttpError } from './errors';

// Changing metadata alone leaves the R2 ETag unchanged. Every supported index
// replacement receives unique bytes so an older conditional PUT cannot become
// eligible again, even when the visible page returns to identical content.
const marker = /\n?<!-- publication-fence:[a-f0-9-]{36} -->/g;
export const withoutIndexFence = (html: string): string => html.replace(marker, '');
export const fenceIndex = (html: string, token = crypto.randomUUID()): string => `${withoutIndexFence(html)}\n<!-- publication-fence:${token} -->`;

export function decodeIndex(bytes: ArrayBuffer | Uint8Array, metadata?: R2HTTPMetadata | Headers, repair = false): string {
  const http = metadata instanceof Headers ? { contentType: metadata.get('Content-Type') ?? undefined, contentEncoding: metadata.get('Content-Encoding') ?? undefined } : metadata;
  const charset = /;\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(http?.contentType ?? '');
  const encoding = http?.contentEncoding?.trim().toLowerCase();
  const unsupported = () => new HttpError(repair ? 400 : 503,
    'Stored homepage representation is unsupported. Restore uncompressed UTF-8 HTML and compatible HTTP metadata before retrying.', {},
    { code: repair ? 'invalid_repair_target' : 'index_representation_unsupported', details: { key: 'pages/index.html', reason: 'unsupported_index_representation' } });
  if (encoding && encoding !== 'identity' || charset && !['utf-8', 'utf8'].includes((charset[1] ?? charset[2]).toLowerCase())) throw unsupported();
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw unsupported(); }
}

export function fencedIndexBytes(bytes: Uint8Array, metadata?: R2HTTPMetadata | Headers, token?: string): Uint8Array {
  return new TextEncoder().encode(fenceIndex(decodeIndex(bytes, metadata), token));
}
