import { boundary, DamagedManifest } from './errors';
import { canonicalJson, fingerprint, record } from './primitives';
import { isDate, isTimestamp } from './validation';
import { indexPost } from './history-index';
import type { ContentBucket, IndexItem, PostReference, StoredPost } from './types';
import type { EventItem, EventPost } from './events';

export type IndexedResource = 'story' | 'event';
export interface ItemIdentity { post_id: string; item_index: number }
export interface SyncRow {
  resource: IndexedResource; identity: ItemIdentity; revision: string; source_key: string;
  last_received_at?: string; first_date?: string; last_date?: string;
}
interface SyncIndex { version: 1; binding: string; rows: SyncRow[] }
const options = { httpMetadata: { contentType: 'application/json' } };
export const refsBinding = (refs: PostReference[]) => fingerprint(canonicalJson(refs.map(ref => [ref.id, ref.key, ref.date, ref.received_at, ref.last_received_at ?? null])));
export const validSyncIndexKey = (key: unknown, resource: IndexedResource): key is string => typeof key === 'string' && new RegExp(`^sync-index/${resource}/[a-f0-9]{64}\\.json$`).test(key);
export function storyData(post: StoredPost, itemIndex: number, metadata: IndexItem = indexPost(post).items[itemIndex]) {
  const item = post.items[itemIndex];
  return { post_id: post.id, date: post.date, received_at: post.received_at, ...(post.client_ref === undefined ? {} : { client_ref: post.client_ref }),
    title: post.title, source: post.source, ...item, ...metadata,
    updates: (item.updates ?? []).map((update, i) => ({ ...update, ...metadata.updates[i] })) };
}
export const eventData = (post: EventPost, itemIndex: number) => ({ ...post.items[itemIndex], post_id: post.id, item_index: itemIndex });
export function storyRows(posts: StoredPost[], refs: PostReference[], indexed?: ReturnType<typeof indexPost>[]): SyncRow[] {
  const byId = new Map(posts.map(post => [post.id, post]));
  const metadataById = new Map(indexed?.map(item => [item.post_id, item]));
  return refs.flatMap(ref => {
    const post = byId.get(ref.id)!; const metadata = metadataById.get(ref.id) ?? indexPost(post);
    return post.items.map((_item, item_index) => {
      const data = storyData(post, item_index, metadata.items[item_index]);
      return { resource: 'story' as const, identity: { post_id: ref.id, item_index }, revision: fingerprint(canonicalJson(data)), source_key: ref.key, last_received_at: data.last_received_at };
    });
  });
}
export function eventRows(posts: EventPost[], refs: PostReference[], dates: (item: EventItem) => { first: string; last: string }): SyncRow[] {
  const byId = new Map(posts.map(post => [post.id, post]));
  return refs.flatMap(ref => byId.get(ref.id)!.items.map((item, item_index) => {
    const bounds = dates(item);
    return { resource: 'event' as const, identity: { post_id: ref.id, item_index }, revision: fingerprint(canonicalJson(eventData(byId.get(ref.id)!, item_index))),
      source_key: ref.key, first_date: bounds.first, last_date: bounds.last };
  }));
}
export async function writeSyncIndex(bucket: ContentBucket, resource: IndexedResource, refs: PostReference[], rows: SyncRow[], previous?: string): Promise<string> {
  const serialized = canonicalJson({ version: 1, binding: refsBinding(refs), rows } satisfies SyncIndex);
  const key = `sync-index/${resource}/${fingerprint(serialized)}.json`;
  if (key !== previous) await boundary('storage', () => bucket.put(key, serialized, options)); return key;
}
async function readIndex(bucket: ContentBucket, key: string, resource: IndexedResource, refs: PostReference[]): Promise<SyncIndex> {
  if (!validSyncIndexKey(key, resource)) throw new DamagedManifest(key, 'invalid_manifest');
  const object = await boundary('storage', () => bucket.get(key)); if (!object) throw new DamagedManifest(key, 'missing');
  const serialized = await boundary('storage', () => object.text());
  if (!key.endsWith(`/${fingerprint(serialized)}.json`)) throw new DamagedManifest(key, 'invalid_manifest');
  let value: unknown; try { value = JSON.parse(serialized); } catch { throw new DamagedManifest(key, 'invalid_json'); }
  if (!record(value) || value.version !== 1 || typeof value.binding !== 'string' || !/^[a-f0-9]{64}$/.test(value.binding) || !Array.isArray(value.rows)
    || !value.rows.every(row => record(row) && row.resource === resource && record(row.identity) && typeof row.identity.post_id === 'string'
      && Number.isSafeInteger(row.identity.item_index) && Number(row.identity.item_index) >= 0 && typeof row.source_key === 'string'
      && typeof row.revision === 'string' && /^[a-f0-9]{64}$/.test(row.revision)
      && (resource === 'story' ? isTimestamp(row.last_received_at) : typeof row.first_date === 'string' && isDate(row.first_date) && typeof row.last_date === 'string' && isDate(row.last_date) && row.first_date <= row.last_date))) throw new DamagedManifest(key, 'invalid_manifest');
  const index = value as unknown as SyncIndex;
  if (new Set(index.rows.map(row => canonicalJson(row.identity))).size !== index.rows.length) throw new DamagedManifest(key, 'invalid_manifest');
  if (index.binding === refsBinding(refs)) {
    const sources = new Map(refs.map(ref => [ref.id, ref.key]));
    if (index.rows.some(row => sources.get(row.identity.post_id) !== row.source_key)) throw new DamagedManifest(key, 'invalid_manifest');
  }
  return index;
}
export async function loadSyncRows(bucket: ContentBucket, resource: IndexedResource, refs: PostReference[], declared: string | undefined, build: () => Promise<SyncRow[]>): Promise<SyncRow[]> {
  const binding = refsBinding(refs);
  if (declared) { const index = await readIndex(bucket, declared, resource, refs); if (index.binding === binding) return index.rows; }
  if (!refs.length) return [];
  // Legacy publications and copied repair manifests get a cache bound to their
  // immutable source identities, never to mutable homepage bytes or timestamps.
  const cacheKey = `sync-index/cache/${resource}/${binding}.json`;
  const cached = await boundary('storage', () => bucket.get(cacheKey));
  if (cached) {
    let pointer: unknown; try { pointer = JSON.parse(await boundary('storage', () => cached.text())); } catch { throw new DamagedManifest(cacheKey, 'invalid_json'); }
    if (!record(pointer) || pointer.version !== 1 || !validSyncIndexKey(pointer.index, resource)) throw new DamagedManifest(cacheKey, 'invalid_manifest');
    const index = await readIndex(bucket, pointer.index, resource, refs);
    if (index.binding !== binding) throw new DamagedManifest(cacheKey, 'invalid_manifest'); return index.rows;
  }
  const rows = await build(); const key = await writeSyncIndex(bucket, resource, refs, rows);
  await boundary('storage', () => bucket.put(cacheKey, JSON.stringify({ version: 1, index: key }), options)); return rows;
}
