import { settledInOrder } from './batches';
import { asHttpError, boundary, DamagedManifest, DamagedSource, HttpError, isPublishReply, publicationFailure, type ValidationIssue } from './errors';
import { emit, OperationTrace, safeError } from './diagnostics';
import { localDate, recentDates } from './feed';
import { canonicalJson, fingerprint, record } from './primitives';
import { eventData, eventRows, refsBinding, validSyncIndexKey, writeSyncIndex, type SyncRow } from './sync-index';
import { isDate, isTimestamp, validateDigest } from './validation';
import { digestItemWarnings } from './warnings';
import type { ContentBucket, DigestItem, OperationContext, PostReference, PublishReply, PublishResult, StoryIdentity } from './types';

export interface EventItem extends DigestItem {
  starts_at: string;
  ends_at?: string;
  all_day: boolean;
  location?: string;
}
export interface EventDigest { title: string; source: string; items: EventItem[] }
export interface EventPost extends EventDigest { id: string; date: string; received_at: string }
export interface EventReference extends PostReference { first_date: string; last_date: string }
export interface EventPublication { version: 1; posts: EventReference[]; published_at: string | null; sync_index?: string; dedup_index?: string }
export interface ReadEvent extends EventItem, StoryIdentity {}
export interface EventsResult { days: number; as_of: string; published_at: string | null; events: ReadEvent[] }
export type EventsReply = { ok: true; result: EventsResult } | Extract<PublishReply, { ok: false }>;

export const EVENTS_KEY = 'events/current.json';
const eventKey = (post: Pick<PostReference, 'date' | 'id'>) => `events/batches/${post.date}/${post.id}.json`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function validateEvents(value: unknown): EventDigest {
  // Share the post fields, URL rules and bounded field-level error format.
  let digest: ReturnType<typeof validateDigest> | undefined;
  const issues: ValidationIssue[] = []; let issueCount = 0;
  try { digest = validateDigest(value, { requireItems: true }); }
  catch (error) { if (!(error instanceof HttpError) || error.status !== 400) throw error; if (Array.isArray(error.details)) issues.push(...error.details); else throw error; issueCount = issues.length + (error.details_truncated ? 1 : 0); }
  const inputs = record(value) && Array.isArray(value.items) ? value.items : [];
  const invalid = (path: string, code: string, message: string) => {
    issueCount++;
    if (issues.length < 50) issues.push({ path, code, message });
  };
  const items = inputs.flatMap((raw, i): EventItem[] => {
    if (!record(raw)) return [];
    const input = raw; const item = digest?.items[i] ?? {} as DigestItem;
    const field = (name: string) => `items[${i}].${name}`;
    if (input.all_day !== undefined && typeof input.all_day !== 'boolean') invalid(field('all_day'), 'invalid_type', 'Expected a boolean.');
    const all_day = input.all_day === true;
    const validTime = (time: unknown): time is string => all_day ? typeof time === 'string' && isDate(time) : isTimestamp(time);
    const message = all_day ? 'Expected a real YYYY-MM-DD date for an all-day event.' : 'Expected an ISO timestamp with an explicit timezone for a timed event.';
    if (!validTime(input.starts_at)) invalid(field('starts_at'), 'invalid_timestamp', message);
    if (input.ends_at !== undefined) {
      if (!validTime(input.ends_at)) invalid(field('ends_at'), 'invalid_timestamp', message);
      else if (validTime(input.starts_at) && Date.parse(input.ends_at) <= Date.parse(input.starts_at)) invalid(field('ends_at'), 'invalid_range', 'ends_at must be later than starts_at; all-day end dates are exclusive.');
    }
    if (input.location !== undefined && typeof input.location !== 'string') invalid(field('location'), 'invalid_type', 'Expected a string.');
    return [{ ...item, starts_at: input.starts_at as string, all_day,
      ...(input.ends_at === undefined ? {} : { ends_at: input.ends_at as string }),
      ...(input.location === undefined ? {} : { location: input.location as string }) }];
  });
  if (issueCount) throw new HttpError(400, 'Event validation failed', {}, { code: 'validation_failed', details: issues, details_truncated: issueCount > issues.length });
  return { title: digest!.title, source: digest!.source, items };
}

export function addDays(date: string, count: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

export function eventDates(item: EventItem): { first: string; last: string } {
  return item.all_day
    ? { first: item.starts_at, last: item.ends_at ? addDays(item.ends_at, -1) : item.starts_at }
    : { first: localDate(new Date(item.starts_at)), last: localDate(new Date(item.ends_at ? Date.parse(item.ends_at) - 1 : item.starts_at)) };
}

const identity = (item: EventItem) => JSON.stringify([item.post_url, item.all_day, item.all_day ? item.starts_at : new Date(item.starts_at).toISOString()]);

export async function currentEvents(bucket: ContentBucket, snapshot?: string): Promise<EventPublication> {
  const key = snapshot ?? EVENTS_KEY;
  const object = await boundary('storage', () => bucket.get(key));
  if (!object && snapshot) throw new DamagedManifest(key, 'missing');
  if (!object) return { version: 1, posts: [], published_at: null };
  const text = await boundary('storage', () => object.text());
  if (snapshot && (!/^events\/snapshots\/[a-f0-9]{64}\.json$/.test(snapshot) || !snapshot.endsWith(`/${fingerprint(text)}.json`))) throw new DamagedManifest(key, 'invalid_manifest');
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new DamagedManifest(key, 'invalid_json'); }
  if (!record(value) || value.version !== 1 || !isTimestamp(value.published_at) || !Array.isArray(value.posts) || value.sync_index !== undefined && !validSyncIndexKey(value.sync_index, 'event')
    || value.dedup_index !== undefined && (typeof value.dedup_index !== 'string' || !/^events\/dedup-index\/[a-f0-9]{64}\.json$/.test(value.dedup_index))
    || !value.posts.every(ref => record(ref) && typeof ref.id === 'string' && uuid.test(ref.id) && typeof ref.date === 'string' && isDate(ref.date)
      && isTimestamp(ref.received_at) && ref.key === eventKey({ id: ref.id, date: ref.date })
      && typeof ref.first_date === 'string' && isDate(ref.first_date) && typeof ref.last_date === 'string' && isDate(ref.last_date) && ref.last_date >= ref.first_date)) {
    throw new DamagedManifest(key, 'invalid_manifest');
  }
  return value as unknown as EventPublication;
}

export async function loadEvents(bucket: ContentBucket, ref: EventReference): Promise<EventPost> {
  const object = await boundary('storage', () => bucket.get(ref.key));
  if (!object) throw new DamagedSource(ref.key, ref.id, 'missing');
  const text = await boundary('storage', () => object.text());
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new DamagedSource(ref.key, ref.id, 'invalid_json'); }
  let digest: EventDigest;
  try { digest = validateEvents(value); }
  catch (error) {
    if (error instanceof HttpError && error.status === 400) throw new DamagedSource(ref.key, ref.id, 'invalid_digest');
    throw error;
  }
  return { ...digest, id: ref.id, date: ref.date, received_at: ref.received_at };
}

export async function loadEventBatches(bucket: ContentBucket, refs: EventReference[]): Promise<EventPost[]> {
  const posts: EventPost[] = [];
  // Bound simultaneous R2 reads and preserve source order for ties and failures.
  for await (const { result } of settledInOrder(refs, ref => loadEvents(bucket, ref))) { if (result.status === 'rejected') throw result.reason; posts.push(result.value); }
  return posts;
}

export function selectEvents(posts: EventPost[], now: Date, days = 30): ReadEvent[] {
  const first = localDate(now);
  const last = addDays(first, days - 1);
  return posts.flatMap(post => post.items.flatMap((item, item_index) => {
    const dates = eventDates(item);
    return dates.last >= first && dates.first <= last ? [{ ...item, post_id: post.id, item_index }] : [];
  })).sort((a, b) => {
    const left = eventDates(a).first;
    const right = eventDates(b).first;
    const date = (left < first ? first : left).localeCompare(right < first ? first : right);
    return date || Number(b.all_day) - Number(a.all_day) || Date.parse(a.starts_at) - Date.parse(b.starts_at);
  });
}

export async function readEvents(bucket: ContentBucket, query = new URLSearchParams(), now = new Date(), pinned?: EventPublication): Promise<EventsResult> {
  if (query.getAll('days').length > 1 || query.has('days') && !/^(?:[1-9]|[12][0-9]|30)$/.test(query.get('days')!)) {
    throw new HttpError(400, 'days must be an integer between 1 and 30.', {}, { code: 'invalid_days' });
  }
  const days = Number(query.get('days') ?? 30);
  const publication = pinned ?? await currentEvents(bucket);
  const first = localDate(now);
  const last = addDays(first, days - 1);
  const posts = await loadEventBatches(bucket, publication.posts.filter(ref => ref.last_date >= first && ref.first_date <= last));
  return { days, as_of: now.toISOString(), published_at: publication.published_at, events: selectEvents(posts, now, days) };
}

interface EventIdentity extends StoryIdentity { occurrence: string; received_at: string; first_date: string; last_date: string; source_key: string; revision: string }
interface EventDedupIndex { version: 1; binding: string; entries: EventIdentity[] }
async function eventIdentities(bucket: ContentBucket, publication: EventPublication): Promise<EventIdentity[]> {
  if (publication.dedup_index) {
    const key = publication.dedup_index;
    const object = await boundary('storage', () => bucket.get(key)); if (!object) throw new DamagedManifest(key, 'missing');
    const body = await boundary('storage', () => object.text()); let value: unknown;
    try { value = JSON.parse(body); } catch { throw new DamagedManifest(key, 'invalid_json'); }
    if (!key.endsWith(`/${fingerprint(body)}.json`) || !record(value) || value.version !== 1 || !Array.isArray(value.entries) || typeof value.binding !== 'string'
      || !value.entries.every(item => record(item) && typeof item.occurrence === 'string' && typeof item.post_id === 'string' && uuid.test(item.post_id) && Number.isSafeInteger(item.item_index) && Number(item.item_index) >= 0
        && isTimestamp(item.received_at) && typeof item.first_date === 'string' && isDate(item.first_date) && typeof item.last_date === 'string' && isDate(item.last_date) && item.last_date >= item.first_date
        && typeof item.source_key === 'string' && /^events\/batches\/\d{4}-\d{2}-\d{2}\/[a-f0-9-]{36}\.json$/.test(item.source_key) && typeof item.revision === 'string' && /^[a-f0-9]{64}$/.test(item.revision))) throw new DamagedManifest(key, 'invalid_manifest');
    if (value.binding === refsBinding(publication.posts)) return value.entries as unknown as EventIdentity[];
  }
  // Only committed references can seed a legacy index. Orphan batches are never discovered.
  const posts = await loadEventBatches(bucket, publication.posts);
  const refs = new Map(publication.posts.map(ref => [ref.id, ref]));
  return posts.flatMap(post => post.items.map((item, item_index) => { const dates = eventDates(item); return { occurrence: identity(item), post_id: post.id, item_index, received_at: post.received_at,
    first_date: dates.first, last_date: dates.last, source_key: refs.get(post.id)!.key, revision: fingerprint(canonicalJson(eventData(post, item_index))) }; }));
}

export async function publishEvents(bucket: ContentBucket, digest: EventDigest, now = new Date(), context?: OperationContext, dryRun = false): Promise<PublishReply> {
  const trace = new OperationTrace(context);
  try {
    const publication = await trace.run('event_manifest_loading', () => currentEvents(bucket));
    const today = localDate(now);
    // Upcoming events stay retained regardless of when their announcements arrived.
    const retained = publication.posts.filter(ref => ref.last_date >= today);
    const dates = recentDates(now, 30);
    const priorEntries = (await trace.run('event_identity_loading', () => eventIdentities(bucket, publication))).filter(item => item.last_date >= today || dates.includes(localDate(new Date(item.received_at))));
    const seen = new Map(priorEntries.map(item => [item.occurrence, { post_id: item.post_id, item_index: item.item_index }]));
    const past = digest.items.flatMap((item, index) => !seen.has(identity(item)) && eventDates(item).last < today ? [{ path: `items[${index}].${item.ends_at ? 'ends_at' : 'starts_at'}`, code: 'event_in_past', message: 'New events must include today or a later Los Angeles date.' }] : []);
    if (past.length) throw new HttpError(400, 'Event validation failed', {}, { code: 'validation_failed', details: past.slice(0, 50), details_truncated: past.length > 50 });
    const id = crypto.randomUUID();
    const items: EventItem[] = [];
    const results: PublishResult['items'] = digest.items.map((item, index) => {
      const key = identity(item);
      const prior = seen.get(key);
      if (prior) return { index, status: 'duplicate', ...prior, message: 'This source URL and event start already exist. No content was changed.',
        suggestion: { action: 'review_existing_event', message: 'Read upcoming events to inspect the existing occurrence.', method: 'GET', path: '/api/events' } };
      const reference = { post_id: id, item_index: items.length };
      seen.set(key, reference);
      items.push(item);
      return { index, status: 'published', ...reference };
    });
    const post: EventPost = { title: digest.title, source: digest.source, items, id, date: today, received_at: now.toISOString() };
    const warnings = digest.items.flatMap((item, index) => digestItemWarnings(item, index, now));
    const result: PublishResult = { post: items.length ? { id, date: today, received_at: post.received_at } : null,
      duplicate: !items.length, counts: { submitted: digest.items.length, published: items.length, duplicates: digest.items.length - items.length }, items: results,
      ...(warnings.length ? { warnings } : {}), ...(dryRun ? { dry_run: true, committed: false, checked_at: now.toISOString() } : {}) };
    if (dryRun || !items.length) return { ok: true, result };
    const ranges = items.map(eventDates);
    const ref: EventReference = { id, date: today, received_at: post.received_at, key: eventKey(post),
      first_date: ranges.reduce((date, value) => value.first < date ? value.first : date, ranges[0].first),
      last_date: ranges.reduce((date, value) => value.last > date ? value.last : date, ranges[0].last) };
    await trace.run('event_source_write', () => boundary('storage', () => bucket.put(ref.key, JSON.stringify(post), { httpMetadata: { contentType: 'application/json' } })));
    const next: EventPublication = { version: 1, posts: [...retained, ref], published_at: now.toISOString() };
    const entries = [...priorEntries, ...items.map((item, item_index) => ({ occurrence: identity(item), post_id: id, item_index, received_at: post.received_at, first_date: ranges[item_index].first, last_date: ranges[item_index].last, source_key: ref.key, revision: fingerprint(canonicalJson(eventData(post, item_index))) }))];
    const selection = new Set(next.posts.map(ref => ref.id));
    const rows: SyncRow[] = entries.filter(item => selection.has(item.post_id)).map(item => ({ resource: 'event', identity: { post_id: item.post_id, item_index: item.item_index }, revision: item.revision, source_key: item.source_key, first_date: item.first_date, last_date: item.last_date }));
    next.sync_index = await trace.run('event_sync_index_write', () => writeSyncIndex(bucket, 'event', next.posts, rows, publication.sync_index));
    const dedup = canonicalJson({ version: 1, binding: refsBinding(next.posts), entries } satisfies EventDedupIndex);
    next.dedup_index = `events/dedup-index/${fingerprint(dedup)}.json`;
    await trace.run('event_identity_write', () => boundary('storage', () => bucket.put(next.dedup_index!, dedup, { httpMetadata: { contentType: 'application/json' } })));
    const serialized = canonicalJson(next); const snapshot = `events/snapshots/${fingerprint(serialized)}.json`;
    await trace.run('event_snapshot_write', () => boundary('storage', () => bucket.put(snapshot, serialized, { httpMetadata: { contentType: 'application/json' } })));
    // Current membership commits only after all immutable artifacts are durable.
    trace.publication_status = 'unknown';
    await trace.run('event_manifest_write', () => boundary('storage', () => bucket.put(EVENTS_KEY, serialized, { httpMetadata: { contentType: 'application/json' } })));
    trace.publication_status = 'committed';
    return { ok: true, result };
  } catch (error) {
    const stage = trace.failed_stage ?? 'event_publication';
    const failure = publicationFailure(error, stage, dryRun ? 'not_attempted' : trace.publication_status, 'event');
    emit('event_publication_failed', context, { stage, error_code: failure.code, publication_status: failure.publication_status, ...safeError(error) }, 'error');
    return { ok: false, failure: { ...failure, details: asHttpError(error).details, details_truncated: asHttpError(error).details_truncated } };
  }
}

export function isEventsReply(value: unknown): value is EventsReply {
  if (!record(value)) return false;
  if (value.ok === false) return isPublishReply(value);
  const result = value.result;
  return value.ok === true && record(result) && Number.isInteger(result.days) && Number(result.days) >= 1 && Number(result.days) <= 30
    && isTimestamp(result.as_of) && (result.published_at === null || isTimestamp(result.published_at)) && Array.isArray(result.events);
}
