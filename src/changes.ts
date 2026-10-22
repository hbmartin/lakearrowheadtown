import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { boundary, DamagedManifest, DamagedSource, HttpError, isPublishReply } from './errors';
import { canonicalJson, fingerprint, record } from './primitives';
import { emit } from './diagnostics';
import { isTimestamp } from './validation';
import { localDate, recentDates } from './feed';
import { legacyRecoveryRequired, loadPublication } from './committed';
import { loadPost } from './publishing';
import { addDays, currentEvents, eventDates, loadEventBatches, loadEvents } from './events';
import { alertIndex, loadAlertManifest, loadAlertRecord, readAlert, type AlertReference } from './alerts';
import { eventData, eventRows, loadSyncRows, storyData, storyRows, type SyncRow, type ItemIdentity } from './sync-index';
import { settledInOrder } from './batches';
import type { ContentBucket, OperationContext, PostReference, PublishFailure } from './types';

const LIFETIME = 30 * 24 * 60 * 60 * 1000;
const patterns = { posts: /^publications\/[A-Za-z0-9-]+\.json$/, alerts: /^alerts\/snapshots\/[a-f0-9]{64}\.json$/, events: /^events\/snapshots\/[a-f0-9]{64}\.json$/ };
export interface SyncCheckpoint { as_of: string; posts: string | null; alerts: string | null; events: string | null }
type Token = { type: 'sync'; to: SyncCheckpoint } | { type: 'page'; from: SyncCheckpoint | null; to: SyncCheckpoint; offset: number };
type Identity = ItemIdentity | { alert_id: string };
export type Change = { resource: 'story' | 'event' | 'alert'; identity: Identity; operation: 'upsert'; revision: string; data: unknown }
  | { resource: 'story' | 'event' | 'alert'; identity: Identity; operation: 'remove' };
export interface ChangesResult { as_of: string; changes: Change[]; next_cursor: string | null; sync_cursor: string | null }
export type ChangesReply = { ok: true; result: ChangesResult } | { ok: false; failure: PublishFailure };
interface InventoryItem { resource: Change['resource']; identity: Identity; revision: string; row?: SyncRow; ref?: AlertReference }
const invalidCursor = () => new HttpError(400, 'Invalid reconciliation cursor. Start a fresh bootstrap.', {}, { code: 'invalid_cursor' });
const signature = (payload: string, key: string) => createHmac('sha256', key).update(`changes-v1:${payload}`).digest();
function encode(value: Token, key: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${payload}.${signature(payload, key).toString('base64url')}`;
}
function validCheckpoint(value: unknown): value is SyncCheckpoint {
  return record(value) && isTimestamp(value.as_of) && (['posts', 'alerts', 'events'] as const).every(key => value[key] === null || typeof value[key] === 'string' && patterns[key].test(value[key]));
}
function decode(value: string, key: string, now: Date): Token {
  if (value.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw invalidCursor();
  const [payload, hash] = value.split('.'); const supplied = Buffer.from(hash, 'base64url'); const expected = signature(payload, key);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw invalidCursor();
  let token: unknown; try { token = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw invalidCursor(); }
  if (!record(token) || !validCheckpoint(token.to) || !(token.type === 'sync' || token.type === 'page' && (token.from === null || validCheckpoint(token.from)) && Number.isSafeInteger(token.offset) && Number(token.offset) >= 0)) throw invalidCursor();
  if (now.getTime() >= Date.parse(token.to.as_of) + LIFETIME) throw new HttpError(410, 'The reconciliation checkpoint expired. Bootstrap again without a cursor.', {}, { code: 'resync_required' });
  return token as unknown as Token;
}

// Called only inside the publisher's mutation queue. Source hydration happens
// after this short capture, while these committed immutable references stay pinned.
export async function captureChanges(bucket: ContentBucket, now = new Date(), requireManifest = false): Promise<SyncCheckpoint> {
  const alertIdentity: { key?: string } = {};
  const results = await Promise.allSettled([
    boundary('storage', () => bucket.head('pages/index.html')),
    loadAlertManifest(bucket, undefined, alertIdentity), currentEvents(bucket),
  ]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const index = (results[0] as PromiseFulfilledResult<R2Object | null>).value;
  const posts = index?.customMetadata?.manifest ?? null;
  if (!posts) {
    if (requireManifest) throw legacyRecoveryRequired();
    const legacy = await boundary('storage', () => bucket.list({ prefix: 'digests/', limit: 1 }));
    if (legacy.objects.length) throw new HttpError(503, 'Complete a legacy rebuild before bootstrapping reconciliation.', {}, { code: 'legacy_recovery_required' });
  }
  if (posts && !patterns.posts.test(posts)) throw new DamagedManifest(posts, 'invalid_manifest');
  const calendar = (results[2] as PromiseFulfilledResult<Awaited<ReturnType<typeof currentEvents>>>).value;
  let events: string | null = null;
  if (calendar.published_at !== null) {
    const serialized = canonicalJson(calendar); events = `events/snapshots/${fingerprint(serialized)}.json`;
    // New publishers already wrote this snapshot. Freeze legacy/current operator
    // manifests once without changing their membership or publication pointers.
    if (!await boundary('storage', () => bucket.head(events!))) await boundary('storage', () => bucket.put(events!, serialized, { httpMetadata: { contentType: 'application/json' } }));
  }
  return { as_of: now.toISOString(), posts, alerts: alertIdentity.key ?? null, events };
}

function observedBucket(bucket: ContentBucket) {
  let active = 0; const waiting: (() => void)[] = [];
  const stats = { source_reads: 0, bytes_written: 0 };
  const store: ContentBucket = {
    async get(key) {
      if (active >= 4) await new Promise<void>(resolve => waiting.push(resolve));
      else active++;
      try {
        if (/^(?:posts\/|post-revisions\/|events\/batches\/|alerts\/(?:revisions|entries|confirmations)\/)/.test(key)) stats.source_reads++;
        return await bucket.get(key);
      } finally { const next = waiting.shift(); if (next) next(); else active--; }
    },
    head: key => bucket.head(key), list: options => bucket.list(options),
    put(key, body, options) { stats.bytes_written += typeof body === 'string' ? new TextEncoder().encode(body).length : body.byteLength; return bucket.put(key, body, options); },
  };
  return { store, stats };
}
async function inventory(bucket: ContentBucket, checkpoint: SyncCheckpoint): Promise<Map<string, InventoryItem>> {
  const at = new Date(checkpoint.as_of); const dates = recentDates(at, 30); const entries: InventoryItem[] = [];
  if (checkpoint.posts) {
    const publication = await loadPublication(bucket, checkpoint.posts);
    const rows = await loadSyncRows(bucket, 'story', publication.posts, publication.sync_index, async () => {
      const posts = [];
      for await (const { result } of settledInOrder(publication.posts, ref => loadPost(bucket, ref))) { if (result.status === 'rejected') throw result.reason; posts.push(result.value); }
      return storyRows(posts, publication.posts);
    });
    const parents = new Map(publication.posts.map(ref => [ref.id, ref]));
    for (const row of rows) {
      const parent = parents.get(row.identity.post_id)!;
      if (dates.includes(localDate(new Date(parent.last_received_at ?? parent.received_at))) && dates.includes(localDate(new Date(row.last_received_at!)))) entries.push({ resource: 'story', identity: row.identity, revision: row.revision, row });
    }
  }
  if (checkpoint.events) {
    const publication = await currentEvents(bucket, checkpoint.events);
    const rows = await loadSyncRows(bucket, 'event', publication.posts, publication.sync_index, async () => eventRows(await loadEventBatches(bucket, publication.posts), publication.posts, eventDates));
    const first = localDate(at); const last = addDays(first, 29);
    for (const row of rows) if (row.last_date! >= first && row.first_date! <= last) entries.push({ resource: 'event', identity: row.identity, revision: row.revision, row });
  }
  if (checkpoint.alerts) {
    const manifest = await loadAlertManifest(bucket, checkpoint.alerts);
    for (const ref of manifest.alerts) {
      const index = alertIndex(ref, at);
      if (index.state === 'open' || dates.includes(localDate(new Date(ref.last_received_at)))) entries.push({ resource: 'alert', identity: { alert_id: ref.alert_id }, revision: index.revision, ref });
    }
  }
  return new Map(entries.map(entry => [canonicalJson([entry.resource, entry.identity]), entry]));
}
function compareItems(a: InventoryItem, b: InventoryItem): number {
  const resource = a.resource.localeCompare(b.resource); if (resource) return resource;
  if ('alert_id' in a.identity && 'alert_id' in b.identity) return a.identity.alert_id.localeCompare(b.identity.alert_id);
  if ('post_id' in a.identity && 'post_id' in b.identity) return a.identity.post_id.localeCompare(b.identity.post_id) || a.identity.item_index - b.identity.item_index;
  return 0;
}
export async function readChanges(bucket: ContentBucket, query: URLSearchParams, key: string, capture: () => Promise<SyncCheckpoint>, now = new Date(), context?: OperationContext): Promise<ChangesResult> {
  if ([...query.keys()].some(key => !['since', 'cursor'].includes(key)) || query.getAll('since').length > 1 || query.getAll('cursor').length > 1 || query.has('since') && query.has('cursor')) throw invalidCursor();
  let from: SyncCheckpoint | null = null; let to: SyncCheckpoint; let offset = 0;
  if (query.has('cursor')) {
    const token = decode(query.get('cursor')!, key, now); if (token.type !== 'page') throw invalidCursor();
    ({ from, to, offset } = token);
  } else {
    if (query.has('since')) { const token = decode(query.get('since')!, key, now); if (token.type !== 'sync') throw invalidCursor(); from = token.to; }
    to = await capture();
  }
  const { store, stats } = observedBucket(bucket);
  const before = from ? await inventory(store, from) : new Map<string, InventoryItem>();
  const after = await inventory(store, to);
  const changed = [...after.entries()].filter(([id, item]) => before.get(id)?.revision !== item.revision).map(([, item]) => ({ item, remove: false }));
  for (const [id, item] of before) if (!after.has(id)) changed.push({ item, remove: true });
  changed.sort((a, b) => compareItems(a.item, b.item));
  if (offset > changed.length) throw invalidCursor();
  const page = changed.slice(offset, offset + 20); const changes: Change[] = [];
  const sources = new Map<string, Promise<unknown>>();
  const source = <T>(id: string, load: () => Promise<T>) => { if (!sources.has(id)) sources.set(id, load()); return sources.get(id)! as Promise<T>; };
  for await (const { result } of settledInOrder(page, async ({ item, remove }): Promise<Change> => {
    if (remove) return { resource: item.resource, identity: item.identity, operation: 'remove' };
    let data: unknown;
    if (item.resource === 'alert') data = readAlert(await loadAlertRecord(store, item.ref!, 'coalesced'), new Date(to.as_of));
    else {
      const row = item.row!;
      const ref: PostReference = { id: row.identity.post_id, key: row.source_key, date: '', received_at: '' };
      // Loaders validate the immutable source and reconstruct its public identity.
      if (item.resource === 'story') {
        const publication = await source(`publication:${to.posts}`, () => loadPublication(store, to.posts!));
        const original = publication.posts.find(value => value.id === ref.id)!;
        const post = await source(ref.key, () => loadPost(store, original));
        if (!post.items[row.identity.item_index]) throw new DamagedSource(row.source_key, row.identity.post_id, 'invalid_digest');
        data = storyData(post, row.identity.item_index);
      } else {
        const publication = await source(`publication:${to.events}`, () => currentEvents(store, to.events!));
        const original = publication.posts.find(value => value.id === ref.id)!;
        const post = await source(ref.key, () => loadEvents(store, original));
        if (!post.items[row.identity.item_index]) throw new DamagedSource(row.source_key, row.identity.post_id, 'invalid_digest');
        data = eventData(post, row.identity.item_index);
      }
      if (fingerprint(canonicalJson(data)) !== row.revision) throw new DamagedSource(row.source_key, row.identity.post_id, 'invalid_digest');
    }
    return { resource: item.resource, identity: item.identity, operation: 'upsert', revision: item.revision, data };
  })) { if (result.status === 'rejected') throw result.reason; changes.push(result.value); }
  const next = offset + page.length < changed.length;
  emit('changes_read_result', context, { change_count: changed.length, returned_count: changes.length, ...stats });
  return { as_of: to.as_of, changes, next_cursor: next ? encode({ type: 'page', from, to, offset: offset + page.length }, key) : null,
    sync_cursor: next ? null : encode({ type: 'sync', to }, key) };
}
export function isChangesReply(value: unknown): value is ChangesReply {
  if (!record(value)) return false; if (value.ok === false) return isPublishReply(value);
  const result = value.result;
  return value.ok === true && record(result) && isTimestamp(result.as_of) && Array.isArray(result.changes)
    && (result.next_cursor === null || typeof result.next_cursor === 'string') && (result.sync_cursor === null || typeof result.sync_cursor === 'string')
    && result.changes.every(item => record(item) && ['story', 'alert', 'event'].includes(String(item.resource)) && ['upsert', 'remove'].includes(String(item.operation)) && record(item.identity));
}
