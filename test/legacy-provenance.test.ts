import { env } from 'cloudflare:workers';
import { reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { appendUpdate, currentPublication, loadPublication, postKey, publishDigest, rebuildHomepage } from '../src/publishing';
import { localDate } from '../src/feed';
import * as social from '../src/social';
import type { ContentBucket, Digest, Env, PostReference, Publication, StoredPost } from '../src/types';

const bindings = env as unknown as Env;
const origin = 'https://lakearrowhead.town';
const now = new Date('2026-10-20T18:00:00.000Z');
const oldTime = '2026-09-15T18:00:00.000Z';
const legacyId = 'legacy-2026-08-01';
const rawKey = 'digests/2026-08-01.json';
const digest = (name: string, posted_at = now.toISOString()): Digest => ({ title: 'Batch', source: 'Groups', items: [{
  group: 'Community', group_url: 'https://example.com/group', headline: name, body: '', category: '',
  post_url: `https://example.com/${name}`, posted_at,
}] });
const store = (overrides: Partial<ContentBucket> = {}): ContentBucket => ({
  get: key => bindings.SITE_BUCKET.get(key), head: key => bindings.SITE_BUCKET.head(key),
  put: (key, body, options) => bindings.SITE_BUCKET.put(key, body, options), list: options => bindings.SITE_BUCKET.list(options), ...overrides,
});
async function seed(placement: 'posts' | 'omitted_posts', version: 1 | 2 = 2) {
  const post: StoredPost = { ...digest('Original legacy', oldTime), id: legacyId, date: localDate(new Date(oldTime)), received_at: oldTime };
  const ref: PostReference = { id: post.id, key: postKey(post), date: post.date, received_at: post.received_at };
  const publication: Publication = { version, posts: [], snapshot_date: localDate(now), published_at: now.toISOString(), [placement]: [ref] };
  await bindings.SITE_BUCKET.put(ref.key, JSON.stringify(post));
  await bindings.SITE_BUCKET.put('publications/seed.json', JSON.stringify(publication));
  await bindings.SITE_BUCKET.put('pages/index.html', 'Saved homepage', { customMetadata: { manifest: 'publications/seed.json' } });
  // Even recent activity in a freshly uploaded backup must not reset its identity.
  await bindings.SITE_BUCKET.put(rawKey, JSON.stringify(digest('Backup should not return')));
  return ref;
}
beforeEach(async () => { vi.restoreAllMocks(); for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {}); await reset(); });

it.each(['posts', 'omitted_posts'] as const)('keeps expired %s identities anchored across later publications and appends', async placement => {
  await seed(placement);
  const first = await publishDigest(bindings.SITE_BUCKET, digest('New'), origin, now);
  for (const action of [
    async () => {},
    () => appendUpdate(bindings.SITE_BUCKET, first.post!.id, 0, { group: 'Community', body: '', post_url: 'https://example.com/followup', posted_at: now.toISOString() }, origin, now),
    () => publishDigest(bindings.SITE_BUCKET, digest('Another'), origin, now),
  ]) {
    await action();
    const publication = await currentPublication(bindings.SITE_BUCKET);
    expect(publication.posts.some(ref => ref.id === legacyId)).toBe(false);
    expect(publication.omitted_posts?.some(ref => ref.id === legacyId) ?? false).toBe(false);
    expect(publication.legacy_receipts).toEqual({ [legacyId]: oldTime });
    expect(await (await bindings.SITE_BUCKET.get('pages/index.html'))!.text()).not.toContain('Backup should not return');
  }
  const before = await currentPublication(bindings.SITE_BUCKET);
  const put = vi.fn(store().put);
  expect((await publishDigest(store({ put }), digest('New'), origin, now, true)).duplicate).toBe(true);
  expect(put).not.toHaveBeenCalled();
  expect(await currentPublication(bindings.SITE_BUCKET)).toEqual(before);
  const list = vi.fn(store().list);
  await publishDigest(store({ list }), digest('After migration'), origin, now, true);
  expect(list).not.toHaveBeenCalled();
  expect((await currentPublication(bindings.SITE_BUCKET)).legacy_receipts).toBeUndefined();
});

it('never refreshes an existing anchor from a newer committed receipt', async () => {
  await seed('posts', 1);
  const publication = await currentPublication(bindings.SITE_BUCKET);
  publication.legacy_receipts = { [legacyId]: '2026-09-01T18:00:00.000Z' };
  await bindings.SITE_BUCKET.put('publications/seed.json', JSON.stringify(publication));
  await publishDigest(bindings.SITE_BUCKET, digest('New'), origin, now);
  expect((await currentPublication(bindings.SITE_BUCKET)).legacy_receipts?.[legacyId]).toBe('2026-09-01T18:00:00.000Z');
});

it('shares one paginated bootstrap discovery and still discovers late arrivals on v2 sites', async () => {
  for (const date of ['2026-08-01', '2026-08-02']) await bindings.SITE_BUCKET.put(`digests/${date}.json`, JSON.stringify(digest(date)));
  const all = (await bindings.SITE_BUCKET.list({ prefix: 'digests/' })).objects;
  const list = vi.fn(async (options?: R2ListOptions): Promise<R2Objects> => ({
    objects: [all[options?.cursor ? 1 : 0]], truncated: !options?.cursor, cursor: options?.cursor ? undefined : 'next', delimitedPrefixes: [],
  } as R2Objects));
  await publishDigest(store({ list }), digest('First'), origin, now);
  expect(list).toHaveBeenCalledTimes(2); // One traversal, not one traversal per consumer.
  expect((await currentPublication(bindings.SITE_BUCKET)).posts).toHaveLength(3);
  await bindings.SITE_BUCKET.put('digests/2026-08-03.json', JSON.stringify(digest('Late')));
  await publishDigest(bindings.SITE_BUCKET, digest('Next'), origin, now);
  const publication = await currentPublication(bindings.SITE_BUCKET);
  expect(publication.version).toBe(2);
  expect(publication.posts.some(ref => ref.id === 'legacy-2026-08-03')).toBe(true);
  expect(publication.legacy_receipts?.['legacy-2026-08-03']).toBeDefined();
});

it('preserves anchors through direct rebuilds and clears them after a completed migration rebuild', async () => {
  await seed('posts');
  await publishDigest(bindings.SITE_BUCKET, digest('New'), origin, now);
  await rebuildHomepage(bindings.SITE_BUCKET, origin);
  expect((await currentPublication(bindings.SITE_BUCKET)).legacy_receipts).toEqual({ [legacyId]: oldTime });
  const publisher = bindings.PUBLISHER.getByName('site');
  const job = await publisher.enqueueRebuild(origin);
  await runDurableObjectAlarm(publisher);
  expect(await publisher.jobStatus(job.id)).toMatchObject({ status: 'completed' });
  expect((await currentPublication(bindings.SITE_BUCKET)).legacy_receipts).toBeUndefined();
});

it('keeps completed-migration bootstrap and mutations free of raw discovery', async () => {
  await bindings.SITE_BUCKET.put(rawKey, JSON.stringify(digest('Uncommitted')));
  const list = vi.fn(store().list);
  await rebuildHomepage(store({ list }), origin, undefined, true);
  const first = await publishDigest(store({ list }), digest('First'), origin, now, true);
  await appendUpdate(store({ list }), first.post!.id, 0, { group: 'Group', body: '', post_url: 'https://example.com/update', posted_at: now.toISOString() }, origin, now, true);
  expect(list).not.toHaveBeenCalled();
  expect((await currentPublication(bindings.SITE_BUCKET)).posts.some(ref => ref.id === legacyId)).toBe(false);
});

it('retries an initial migration render without losing its legacy bootstrap or double-counting imports', async () => {
  await bindings.SITE_BUCKET.put(rawKey, JSON.stringify(digest('Bootstrap')));
  const publisher = bindings.PUBLISHER.getByName('site');
  const job = await publisher.enqueueRebuild(origin);
  vi.spyOn(social, 'dailyCard').mockRejectedValueOnce(new Error('Injected initial rendering failure'));
  await runDurableObjectAlarm(publisher);
  expect(await publisher.jobStatus(job.id)).toMatchObject({ status: 'failed', processed: 1 });
  const inPublisher = runInDurableObject as unknown as <T>(stub: unknown, callback: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
  expect(await inPublisher(publisher, async (_instance, state) => state.storage.get('migration'))).toMatchObject({ complete: false, processed: 0 });
  expect(await bindings.SITE_BUCKET.head('pages/index.html')).toBeNull();
  await publisher.resumeRebuild(job.id);
  await runDurableObjectAlarm(publisher);
  expect(await publisher.jobStatus(job.id)).toMatchObject({ status: 'completed', processed: 1 });
  expect((await currentPublication(bindings.SITE_BUCKET)).posts.map(ref => ref.id)).toEqual([legacyId]);
  expect(await inPublisher(publisher, async (_instance, state) => state.storage.get('migration'))).toMatchObject({ complete: true, processed: 1 });
});

it('keeps ordinary API source URL reuse after the 30-day window', async () => {
  const input = digest('Reusable', oldTime);
  const first = await publishDigest(bindings.SITE_BUCKET, input, origin, new Date(oldTime), true);
  const second = await publishDigest(bindings.SITE_BUCKET, { ...input, items: [{ ...input.items[0], posted_at: now.toISOString() }] }, origin, now, true);
  expect(second.duplicate).toBe(false);
  expect(second.post!.id).not.toBe(first.post!.id);
});

it.each([null, [], { invalid: oldTime }, { 'legacy-2026-02-30': oldTime }, { [legacyId]: 'invalid' }])('rejects malformed private provenance: %j', async legacy_receipts => {
  await bindings.SITE_BUCKET.put('publications/invalid.json', JSON.stringify({ version: 2, posts: [], snapshot_date: null, published_at: null, legacy_receipts }));
  await expect(loadPublication(bindings.SITE_BUCKET, 'publications/invalid.json')).rejects.toMatchObject({ code: 'manifest_damaged' });
});
