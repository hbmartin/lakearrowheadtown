import { HttpError } from './errors';

export const REBUILD_MARKER = 'lakearrowhead_rebuild_id';
export const NEWS_ANCHOR = 'news_published_at';

export function validateIndexMetadata(metadata: Record<string, string>): void {
  const size = Object.entries(metadata).reduce((total, [key, value]) => total + new TextEncoder().encode(key + value).length, 0);
  if (size > 8192) throw new HttpError(400, 'Index metadata exceeds the R2 object metadata limit.', {}, { code: 'invalid_repair_target' });
}

// This is a receipt for the last rebuild, even when a later source publication
// replaces its HTML before Durable Object finalization can be acknowledged.
export function rebuildMetadata(index: R2Object | null): Record<string, string> {
  const id = index?.customMetadata?.[REBUILD_MARKER];
  return id ? { [REBUILD_MARKER]: id } : {};
}
