import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { captureChanges, readChanges, type ChangesResult, type SyncCheckpoint } from '../src/changes';
import { publishDigest, appendUpdate, currentPublication, loadPost, rebuildHomepage } from '../src/publishing';
import { publishEvents, validateEvents, EVENTS_KEY, addDays } from '../src/events';
import { submitAlert, confirmAlerts, retractAlertEntry, validateAlertInput } from '../src/alerts';
import { canonicalJson, fingerprint } from '../src/primitives';
import { readPosts } from '../src/posts';
import { readAlerts } from '../src/alerts';
import { readEvents } from '../src/events';
import { storyData } from '../src/sync-index';
import type { ContentBucket, Digest, Env } from '../src/types';
const bindings = env as unknown as Env; const bucket = bindings.SITE_BUCKET; const origin = 'https://lakearrowhead.town';
const at = new Date('2026-10-22T18:00:00Z'); const later = (hours: number) => new Date(at.getTime() + hours * 3600000);
const secret = 'test-secret-at-least-thirty-two-characters-long'; const owner = fingerprint(secret); const auth = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
const digest = (name = crypto.randomUUID()): Digest => ({ title: 'Digest', source: 'source', client_ref: `batch-${name}`, items: [{ group: 'Group', group_url: 'https://example.com/group', headline: name, body: 'Body', category: 'announcement', post_url: `https://example.com/${name}`, posted_at: at.toISOString() }] });
const story = (name?: string) => publishDigest(bucket, digest(name), origin, at, true, undefined, { publisherFingerprint: owner });
const alert = (patch: Record<string, unknown> = {}) => submitAlert(bucket, validateAlertInput({ client_ref: crypto.randomUUID(), phase: 'open', category: 'traffic', kind: 'closure', routes: ['SR-138'], headline: 'Closure', source: 'caltrans', source_url: 'https://example.com/138', observed_at: at.toISOString(), ...patch }), owner, at);
const event = async (date = '2026-10-23', name = crypto.randomUUID()) => {
  const input = digest(name); return publishEvents(bucket, validateEvents({ ...input, items: input.items.map(item => ({ ...item, all_day: true, starts_at: date })) }), at);
};
const wrap = (overrides: Partial<ContentBucket>): ContentBucket => ({ get: key => bucket.get(key), head: key => bucket.head(key), put: (key, body, opts) => bucket.put(key, body, opts), list: opts => bucket.list(opts), ...overrides });
const poll = (query = '', now = at, store: ContentBucket = bucket, capture = () => captureChanges(store, now)) => readChanges(store, new URLSearchParams(query), 'server-cursor-key', capture, now);
async function collect(query = '', now = at, store: ContentBucket = bucket) {
  let page = await poll(query, now, store); const changes = [...page.changes]; const as_of = page.as_of;
  while (page.next_cursor) { expect(page.sync_cursor).toBeNull(); page = await poll(`cursor=${encodeURIComponent(page.next_cursor)}`, now, store, async () => { throw new Error('Pages must not recapture'); }); expect(page.as_of).toBe(as_of); changes.push(...page.changes); }
  return { ...page, changes };
}
const since = (result: ChangesResult) => `since=${encodeURIComponent(result.sync_cursor!)}`;
const request = (path: string, init: RequestInit = {}) => worker.fetch(new Request(origin + path, init), bindings);
const inPublisher = runInDurableObject as unknown as <T>(stub: unknown, callback: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
beforeEach(async () => { vi.restoreAllMocks(); await reset(); for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {}); });

it('bootstraps full current public data for stories, alerts and calendar events', async () => {
  const post = await story('one'); const opened = await alert(); await event();
  await confirmAlerts(bucket, [{ client_ref: 'check', alert_id: opened.alert_id, source: 'caltrans', source_url: 'https://example.com/138', observed_at: later(1).toISOString() }], later(1));
  const result = await collect('', later(1)); expect(result.changes.map(item => item.resource)).toEqual(['alert', 'event', 'story']); expect(result.sync_cursor).toBeTruthy();
  const change = result.changes.find(item => item.resource === 'story')! as any;
  const publication = await currentPublication(bucket); const source = await loadPost(bucket, publication.posts[0]);
  expect(change.data).toEqual(storyData(source, 0)); expect(change.identity).toEqual({ post_id: post.post!.id, item_index: 0 });
  const conditions = result.changes[0] as any; expect(conditions.data.history).toHaveLength(2); expect(conditions.data.history[1].confirmation_run.count).toBe(1);
  const serialized = JSON.stringify(result.changes); expect(serialized).not.toContain('publisher_fingerprint'); expect(serialized).not.toContain(owner); expect(serialized).not.toContain('source_key');
});
it('returns empty polls with no historical source-body reads once indexes exist', async () => {
  await story(); await event(); await alert(); const initial = await collect();
  const get = vi.fn((key: string) => { if (/^(posts\/|post-revisions\/|events\/batches\/|alerts\/(revisions|entries|confirmations)\/)/.test(key)) throw new Error('Unchanged history must not load'); return bucket.get(key); });
  const unchanged = await collect(since(initial), later(1), wrap({ get })); expect(unchanged.changes).toEqual([]); expect(unchanged.sync_cursor).toBeTruthy();
});
it('reports appended story data, resolved/retracted alerts and removals', async () => {
  const post = await story(); const opened = await alert(); const initial = await collect();
  await appendUpdate(bucket, post.post!.id, 0, { group: 'Update', post_url: 'https://example.com/update', body: 'New information', posted_at: later(1).toISOString() }, origin, later(1), true);
  const resolved = await submitAlert(bucket, validateAlertInput({ client_ref: 'resolved', phase: 'resolved', alert_id: opened.alert_id, source: 'caltrans', source_url: 'https://example.com/138', observed_at: later(1).toISOString() }), owner, later(1));
  const changed = await collect(since(initial), later(1)); expect(changed.changes).toHaveLength(2); expect((changed.changes.find(item => item.resource === 'story') as any).data.updates[0].body).toBe('New information'); expect((changed.changes[0] as any).data.state).toBe('resolved');
  await retractAlertEntry(bucket, opened.alert_id, resolved.entry_id, owner, later(2));
  const reopened = await collect(since(changed), later(2)); expect((reopened.changes[0] as any).data.state).toBe('open');
  await retractAlertEntry(bucket, opened.alert_id, opened.entry_id, owner, later(3));
  const retracted = await collect(since(reopened), later(3)); expect((retracted.changes[0] as any).data.state).toBe('retracted');
});
it('evaluates expiry, upcoming flags and both date-window directions without writes', async () => {
  await story(); await alert({ starts_at: later(1).toISOString() }); await event('2026-11-21'); const initial = await collect();
  expect(initial.changes.some(item => item.resource === 'event')).toBe(false);
  const started = await collect(since(initial), later(1)); expect((started.changes[0] as any).data.upcoming).toBe(false);
  const expired = await collect(since(started), later(24)); expect((expired.changes.find(item => item.resource === 'alert') as any).data.state).toBe('expired-unconfirmed'); expect(expired.changes.some(item => item.resource === 'event' && item.operation === 'upsert')).toBe(true);
  const evicted = await collect(since(expired), later(24 * 30)); expect(evicted.changes.filter(item => item.operation === 'remove').map(item => item.resource)).toEqual(['alert', 'story']);
  const eventGone = await collect(since(evicted), later(24 * 31)); expect(eventGone.changes).toEqual([expect.objectContaining({ resource: 'event', operation: 'remove' })]);
});
it('pins both inventories and time through concurrent changes between pages', async () => {
  for (let i = 0; i < 23; i++) await story(`page-${i}`);
  const first = await poll(); expect(first.changes).toHaveLength(20); expect(first.sync_cursor).toBeNull();
  const newer = await story('new-between-pages');
  const second = await poll(`cursor=${encodeURIComponent(first.next_cursor!)}`, later(1), bucket, async () => { throw new Error('No recapture'); });
  expect(second.changes).toHaveLength(3); expect(second.as_of).toBe(first.as_of); expect(second.next_cursor).toBeNull();
  const all = [...first.changes, ...second.changes]; expect(new Set(all.map(item => canonicalJson(item.identity))).size).toBe(23); expect(all.some(item => 'post_id' in item.identity && item.identity.post_id === newer.post!.id)).toBe(false);
  const delta = await collect(since(second), later(1)); expect(delta.changes).toHaveLength(1); expect(delta.changes[0].identity).toEqual({ post_id: newer.post!.id, item_index: 0 });
});
it('freezes mutable legacy calendar manifests and retains old pages', async () => {
  for (let i = 0; i < 21; i++) await event('2026-10-23', `calendar-${i}`);
  const current = await (await bucket.get(EVENTS_KEY))!.json<any>(); delete current.sync_index; await bucket.put(EVENTS_KEY, JSON.stringify(current));
  const first = await poll(); expect(first.next_cursor).toBeTruthy();
  await event('2026-10-24', 'new-calendar');
  const second = await poll(`cursor=${encodeURIComponent(first.next_cursor!)}`); expect(second.changes).toHaveLength(1); expect((second.changes[0] as any).data.starts_at).toBe('2026-10-23');
  expect((await collect(since(second))).changes).toHaveLength(1);
});
it('rebuilds missing legacy indexes once and ignores stale indexes after a supported repair', async () => {
  await story('repair'); const initial = await collect();
  const head = (await bucket.get('pages/index.html'))!; const publication = await currentPublication(bucket); const post = await loadPost(bucket, publication.posts[0]);
  post.items[0].body = 'Operator correction'; const key = `post-revisions/${post.id}/${crypto.randomUUID()}.json`; await bucket.put(key, JSON.stringify(post)); publication.posts[0].key = key;
  const repaired = `publications/${crypto.randomUUID()}.json`; await bucket.put(repaired, JSON.stringify(publication)); await bucket.put('pages/index.html', await head.text(), { customMetadata: { ...head.customMetadata, manifest: repaired } });
  const delta = await collect(since(initial)); expect(delta.changes).toHaveLength(1); expect((delta.changes[0] as any).data.body).toBe('Operator correction');
  const get = vi.fn((key: string) => { if (key.startsWith('post-revisions/')) throw new Error('Cached repair must not reload'); return bucket.get(key); });
  expect((await collect(since(delta), at, wrap({ get }))).changes).toEqual([]);
  post.items = []; const emptyKey = `post-revisions/${post.id}/${crypto.randomUUID()}.json`; await bucket.put(emptyKey, JSON.stringify(post)); publication.posts[0].key = emptyKey;
  const removed = `publications/${crypto.randomUUID()}.json`; await bucket.put(removed, JSON.stringify(publication)); const body = (await bucket.get('pages/index.html'))!; await bucket.put('pages/index.html', await body.text(), { customMetadata: { ...body.customMetadata, manifest: removed } });
  expect((await collect(since(delta))).changes).toEqual([{ resource: 'story', identity: { post_id: post.id, item_index: 0 }, operation: 'remove' }]);
});
it('ignores weather-only homepage writes and cosmetic rebuilds', async () => {
  await story(); const initial = await collect();
  const head = (await bucket.get('pages/index.html'))!; await bucket.put('pages/index.html', (await head.text()) + '<!-- weather composition -->', { httpMetadata: head.httpMetadata, customMetadata: head.customMetadata });
  expect((await collect(since(initial))).changes).toEqual([]);
  await rebuildHomepage(bucket, origin); expect((await collect(since(initial))).changes).toEqual([]);
});
it('bounds all source reads to four and reuses shared batch bodies', async () => {
  const input = digest('many'); input.items.push({ ...input.items[0], post_url: 'https://example.com/second' }); await publishDigest(bucket, input, origin, at, true);
  for (let i = 0; i < 6; i++) { const a = await alert(); await confirmAlerts(bucket, [{ client_ref: `check-${i}`, alert_id: a.alert_id, source: 'caltrans', source_url: 'https://example.com/138', observed_at: at.toISOString() }], at); }
  let active = 0; let peak = 0; const reads: string[] = [];
  const get = async (key: string) => { const isSource = /^(posts\/|post-revisions\/|alerts\/(revisions|entries|confirmations)\/)/.test(key); if (isSource) { reads.push(key); active++; peak = Math.max(peak, active); } try { await new Promise(resolve => setTimeout(resolve, 1)); return await bucket.get(key); } finally { if (isSource) active--; } };
  const result = await collect('', at, wrap({ get })); expect(result.changes).toHaveLength(8); expect(peak).toBeLessThanOrEqual(4); expect(reads.filter(key => key.startsWith('posts/'))).toHaveLength(1);
});
it('returns explicit cursor errors and resync at the exact lifetime boundary', async () => {
  const initial = await collect(); const capture = vi.fn(async () => ({ as_of: at.toISOString(), posts: null, alerts: null, events: null } as SyncCheckpoint));
  const pieces = initial.sync_cursor!.split('.'); pieces[1] = (pieces[1][0] === 'A' ? 'B' : 'A') + pieces[1].slice(1);
  for (const query of [`since=${pieces.join('.')}`, `cursor=${initial.sync_cursor}`, `since=${initial.sync_cursor}&cursor=${initial.sync_cursor}`, 'since=bad&since=bad']) await expect(poll(query, at, bucket, capture)).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' });
  expect(capture).not.toHaveBeenCalled();
  await expect(poll(since(initial), later(24 * 30))).rejects.toMatchObject({ status: 410, code: 'resync_required' });
  expect((await poll(since(initial), new Date(later(24 * 30).getTime() - 1))).changes).toEqual([]);
});
it('fails on damaged indexes and requested changed sources instead of returning an empty feed', async () => {
  await story(); const publication = await currentPublication(bucket);
  const damagedIndex = wrap({ get: key => key === publication.sync_index ? Promise.resolve(null) : bucket.get(key) });
  await expect(collect('', at, damagedIndex)).rejects.toMatchObject({ code: 'manifest_damaged' });
  const missingSource = wrap({ get: key => key === publication.posts[0].key ? Promise.resolve(null) : bucket.get(key) });
  await expect(collect('', at, missingSource)).rejects.toMatchObject({ code: 'source_damaged' });
});
it('authenticates HTTP, survives credential rotation and keeps errors actionable', async () => {
  expect((await request('/api/changes')).status).toBe(401);
  const initial = await request('/api/changes', { headers: auth }); expect(initial.status).toBe(200); expect(initial.headers.get('X-API-Version')).toBe('3'); const data = await initial.json<any>();
  expect(data.sync_cursor).toBeTruthy(); expect(data.changes).toEqual([]);
  const head = await request('/api/changes', { method: 'HEAD', headers: auth }); expect(head.status).toBe(200); expect(await head.text()).toBe('');
  expect((await request('/api/changes', { method: 'POST', headers: auth })).status).toBe(405);
  const error = await request('/api/changes?since=bad', { headers: auth }); expect(await error.json()).toMatchObject({ code: 'invalid_cursor', suggestion: { action: 'bootstrap_changes' } });
  const rotated = await worker.fetch(new Request(origin + '/api/changes?since=' + encodeURIComponent(data.sync_cursor), { headers: { Authorization: 'Bearer rotated-secret-at-least-thirty-two-characters-long' } }), { ...bindings, API_SECRET: 'rotated-secret-at-least-thirty-two-characters-long' }); expect(rotated.status).toBe(200);
});

it('converges to the same three-resource state as fresh full reads', async () => {
  const post = await story('convergence'); const opened = await alert(); await event('2026-10-22', 'ending'); await event('2026-11-21', 'entering');
  const initial = await collect(); const state = new Map(initial.changes.map(change => [canonicalJson([change.resource, change.identity]), (change as any).data]));
  await appendUpdate(bucket, post.post!.id, 0, { group: 'Update', body: 'Changed body', post_url: 'https://example.com/converged-update', posted_at: later(25).toISOString() }, origin, later(25), true);
  await confirmAlerts(bucket, [{ client_ref: 'convergence-confirm', alert_id: opened.alert_id, source: 'caltrans', source_url: 'https://example.com/138', observed_at: later(25).toISOString() }], later(25));
  const delta = await collect(since(initial), later(25));
  for (const change of delta.changes) { const key = canonicalJson([change.resource, change.identity]); if (change.operation === 'remove') state.delete(key); else state.set(key, change.data); }
  const expected = new Map<string, unknown>();
  const posts = await readPosts(bucket, new URLSearchParams('days=30'), 'key', later(25));
  for (const batch of posts.posts) { const { items, ...parent } = batch; for (const item of items) expected.set(canonicalJson(['story', { post_id: batch.post_id, item_index: item.item_index }]), { ...parent, ...item }); }
  const alerts = await readAlerts(bucket, new URLSearchParams('history=coalesced'), 'key', later(25)) as any;
  for (const item of alerts.alerts) expected.set(canonicalJson(['alert', { alert_id: item.alert_id }]), item);
  const events = await readEvents(bucket, new URLSearchParams(), later(25));
  for (const item of events.events) expected.set(canonicalJson(['event', { post_id: item.post_id, item_index: item.item_index }]), item);
  expect(state).toEqual(expected);
});

it('releases the publisher queue before hydrating sources and keeps reads pinned', async () => {
  await inPublisher(bindings.PUBLISHER.getByName('site'), async instance => {
    expect((await instance.publishV2(digest('before-concurrent-read'), origin)).ok).toBe(true);
    const ref = (await currentPublication(bucket)).posts[0];
    let signal!: () => void; const reached = new Promise<void>(resolve => { signal = resolve; });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let blocked = false;
    const original = instance.env;
    instance.env = { ...original, SITE_BUCKET: wrap({ get: async key => { if (key === ref.key && !blocked) { blocked = true; signal(); await gate; } return bucket.get(key); } }) };
    const timeout = <T>(promise: Promise<T>) => { let timer: ReturnType<typeof setTimeout>; return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Queue remained locked during hydration')), 1500); })]).finally(() => clearTimeout(timer)); };
    const pending = instance.readChangesV1('');
    try { await timeout(reached); expect((await timeout<any>(instance.publishV2(digest('after-concurrent-read'), origin))).ok).toBe(true); }
    finally { release(); instance.env = original; }
    const result = await pending; expect(result.ok).toBe(true); expect(result.result.changes).toHaveLength(1); expect(result.result.changes[0].data.headline).toBe('before-concurrent-read');
  });
});
it('supports an alert-only homepage and rejects known missing committed manifests', async () => {
  const published = await request('/api/alerts', { method: 'POST', headers: auth, body: JSON.stringify(validateAlertInput({ client_ref: 'only-alert', phase: 'open', category: 'traffic', kind: 'closure', routes: ['SR-138'], headline: 'Only alert', source: 'caltrans', source_url: 'https://example.com/138', observed_at: new Date().toISOString() })) });
  expect(published.status).toBe(200);
  const response = await request('/api/changes', { headers: auth }); expect(response.status).toBe(200); expect((await response.json<any>()).changes).toEqual([expect.objectContaining({ resource: 'alert', operation: 'upsert' })]);
  await expect(captureChanges(bucket, at, true)).rejects.toMatchObject({ code: 'legacy_recovery_required' });
});

it('limits nested body streaming, not merely the requests returning headers', async () => {
  for (let i = 0; i < 4; i++) {
    const a = await alert(); await confirmAlerts(bucket, [{ client_ref: `stream-check-${i}`, alert_id: a.alert_id, source: 'caltrans', source_url: 'https://example.com/138', observed_at: at.toISOString() }], at);
    for (let j = 0; j < 4; j++) await submitAlert(bucket, validateAlertInput({ client_ref: `stream-update-${i}-${j}`, alert_id: a.alert_id, phase: 'update', source: 'caltrans', source_url: 'https://example.com/138', observed_at: at.toISOString(), detail: `Details ${j}` }), owner, at, undefined, false, undefined, 'coalesced');
  }
  let active = 0; let peak = 0;
  const store = wrap({ get: async key => {
    const object = await bucket.get(key); if (!object) return null;
    return new Proxy(object, { get(target, property) {
      if (property === 'arrayBuffer') return async () => { active++; peak = Math.max(peak, active); try { await new Promise(resolve => setTimeout(resolve, 3)); return await target.arrayBuffer(); } finally { active--; } };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } });
  expect((await collect('', at, store)).changes).toHaveLength(4); expect(peak).toBeLessThanOrEqual(4); expect(active).toBe(0);
});
