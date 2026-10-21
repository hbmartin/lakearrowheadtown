import { boundary, DamagedManifest, HttpError } from './errors';
import { fingerprint, record, text as textField, httpUrl as url } from './primitives';
import { lastReceivedAt, latestActivity, localDate, recentDates } from './feed';
import { isClientRef, isDate, isTimestamp } from './validation';
import type { BatchRecord, BatchResult, ContentBucket, HistoryIndex, IndexPost, Publication, StoredPost } from './types';

export function indexPost(post: StoredPost): IndexPost {
  return { post_id: post.id, date: post.date, received_at: post.received_at,
    ...(post.client_ref === undefined ? {} : { client_ref: post.client_ref }),
    items: post.items.map((item, item_index) => ({ item_index, post_url: item.post_url, posted_at: item.posted_at,
      last_received_at: lastReceivedAt(post, item), latest_activity_at: latestActivity(item)!,
      updates: (item.updates ?? []).map((update, update_index) => ({ update_index, post_url: update.post_url, posted_at: update.posted_at, received_at: update.received_at })) })) };
}

export function batchRecord(post: StoredPost): BatchRecord {
  return { id: post.id, date: post.date, received_at: post.received_at,
    ...(post.client_ref === undefined ? {} : { client_ref: post.client_ref }),
    ...(post.publisher_fingerprint === undefined ? {} : { publisher_fingerprint: post.publisher_fingerprint }),
    ...(post.retracted_at === undefined ? {} : { retracted_at: post.retracted_at }) };
}

export function retainedBatches(batches: BatchRecord[], now: Date): BatchRecord[] {
  const days = recentDates(now, 30);
  return batches.filter(batch => days.includes(localDate(new Date(batch.received_at))));
}

export async function loadHistoryIndex(bucket: ContentBucket, publication: Publication): Promise<HistoryIndex> {
  if (publication.version !== 3) return { version: 1, posts: [], batches: [] };
  const key = publication.history_index!;
  const object = await boundary('storage', () => bucket.get(key));
  if (!object) throw new DamagedManifest(key, 'missing');
  const text = await boundary('storage', () => object.text());
  let value: HistoryIndex;
  try { value = JSON.parse(text); }
  catch { throw new DamagedManifest(key, 'invalid_json'); }
  if (key !== `history-index/${fingerprint(text)}.json`) throw new DamagedManifest(key, 'invalid_manifest');
  const dated = (v: unknown) => record(v) && typeof v.date === 'string' && isDate(v.date) && isTimestamp(v.received_at)
    && (v.client_ref === undefined || isClientRef(v.client_ref));
  if (!record(value) || value.version !== 1 || !Array.isArray(value.posts) || !Array.isArray(value.batches)
    || value.posts.length !== publication.posts.length || !value.posts.every((post, i) => dated(post) && post.post_id === publication.posts[i].id
      && post.date === publication.posts[i].date && post.received_at === publication.posts[i].received_at && Array.isArray(post.items)
      && post.items.every((item, j) => record(item) && item.item_index === j && url(item.post_url) && isTimestamp(item.posted_at)
        && isTimestamp(item.last_received_at) && isTimestamp(item.latest_activity_at) && Array.isArray(item.updates)
        && item.updates.every((update, k) => record(update) && update.update_index === k && url(update.post_url) && isTimestamp(update.posted_at) && isTimestamp(update.received_at))))
    || !value.batches.every(batch => dated(batch) && textField(batch.id)
      && (batch.publisher_fingerprint === undefined || typeof batch.publisher_fingerprint === 'string' && /^[a-f0-9]{64}$/.test(batch.publisher_fingerprint))
      && (batch.retracted_at === undefined || isTimestamp(batch.retracted_at)))
    || new Set(value.batches.map(batch => batch.id)).size !== value.batches.length
    || new Set(value.batches.flatMap(batch => batch.client_ref === undefined ? [] : [batch.client_ref])).size !== value.batches.filter(batch => batch.client_ref !== undefined).length) {
    throw new DamagedManifest(key, 'invalid_manifest');
  }
  return value;
}

export function findBatch(index: HistoryIndex, clientRef: string, now: Date): BatchResult {
  const batch = retainedBatches(index.batches, now).find(batch => batch.client_ref === clientRef);
  if (!batch) throw new HttpError(404, 'No committed batch with this client_ref exists in the 30-day receipt window.', {}, { code: 'batch_not_found' });
  return { client_ref: clientRef, post: { id: batch.id, date: batch.date, received_at: batch.received_at },
    status: batch.retracted_at ? 'retracted' : 'published', ...(batch.retracted_at ? { retracted_at: batch.retracted_at } : {}) };
}
