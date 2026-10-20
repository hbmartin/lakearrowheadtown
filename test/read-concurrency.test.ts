import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { readPosts, type PostsReply } from '../src/posts';
import { currentPublication } from '../src/publishing';
import { localDate } from '../src/feed';
import type { ContentBucket, Digest, Env, Publication, PublishReply, StoredPost } from '../src/types';

const bindings = env as unknown as Env;
const origin = 'https://lakearrowhead.town';
const inPublisher = runInDurableObject as unknown as <T>(stub: unknown, callback: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
const publisher = () => bindings.PUBLISHER.getByName('site');
const digest = (name: string): Digest => ({ title: name, source: 'Source', items: [{ group: 'Group', group_url: 'https://example.com/group', headline: name,
  body: 'Body', post_url: `https://example.com/${name}`, category: '', posted_at: new Date().toISOString() }] });
const bucket = (overrides: Partial<ContentBucket>): ContentBucket => ({ get: key => bindings.SITE_BUCKET.get(key), head: key => bindings.SITE_BUCKET.head(key),
  put: (key, body, options) => bindings.SITE_BUCKET.put(key, body, options), list: options => bindings.SITE_BUCKET.list(options), ...overrides });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function completes<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Operation waited for an unrelated queue barrier')), 1500); })]); }
  finally { clearTimeout(timer); }
}
async function seed(count: number, empty: number[] = []) {
  const time = new Date().toISOString(); const date = localDate(new Date());
  const posts: StoredPost[] = Array.from({ length: count }, (_, i) => ({ ...digest(`Story-${i}`), id: `id-${i}`, date, received_at: time,
    ...(empty.includes(i) ? { items: [] } : {}) }));
  const publication: Publication = { version: 2, posts: posts.map(post => ({ id: post.id, key: `posts/${date}/${post.id}.json`, date, received_at: time })), snapshot_date: date, published_at: time };
  for (let i = 0; i < posts.length; i++) await bindings.SITE_BUCKET.put(publication.posts[i].key, JSON.stringify(posts[i]));
  await bindings.SITE_BUCKET.put('publications/read-fixture.json', JSON.stringify(publication));
  await bindings.SITE_BUCKET.put('pages/index.html', '<html>Fixture</html>', { customMetadata: { manifest: 'publications/read-fixture.json' } });
  return publication;
}
beforeEach(async () => { vi.restoreAllMocks(); for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {}); await reset(); });

it('serves the previous committed snapshot while publishing waits at the index commit', async () => {
  await inPublisher(publisher(), async instance => {
    expect((await instance.publishV2(digest('First'), origin)).ok).toBe(true);
    await instance.readPostsV1('');
    const reached = deferred(); const release = deferred(); const original = instance.env;
    instance.env = { ...original, SITE_BUCKET: bucket({ put: async (key, body, options) => {
      if (key === 'pages/index.html') { reached.resolve(); await release.promise; }
      return bindings.SITE_BUCKET.put(key, body, options);
    } }) };
    const publishing = instance.publishV2(digest('Second'), origin);
    try {
      await completes(reached.promise);
      const read = await completes<PostsReply>(instance.readPostsV1(''));
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error(read.failure.error);
      expect(read.result.posts.map(post => post.title)).toEqual(['First']);
    } finally { release.resolve(); await publishing; instance.env = original; }
    expect((await instance.readPostsV1('')).result.posts).toHaveLength(2);
  });
});

it('allows publishing during a slow story read and keeps that read pinned to its original revisions', async () => {
  await inPublisher(publisher(), async instance => {
    await instance.publishV2(digest('First'), origin);
    await instance.readPostsV1('');
    const ref = (await currentPublication(bindings.SITE_BUCKET)).posts[0];
    const reached = deferred(); const release = deferred(); let blocked = false;
    const original = instance.env;
    instance.env = { ...original, SITE_BUCKET: bucket({ get: async key => {
      if (key === ref.key && !blocked) { blocked = true; reached.resolve(); await release.promise; }
      return bindings.SITE_BUCKET.get(key);
    } }) };
    const reading = instance.readPostsV1('');
    try {
      await completes(reached.promise);
      expect((await completes<PublishReply>(instance.publishV2(digest('Second'), origin))).ok).toBe(true);
    } finally { release.resolve(); instance.env = original; }
    const read = await reading;
    expect(read.result.posts.map((post: any) => post.title)).toEqual(['First']);
  });
});

it('shares cold cursor-key initialization and recovers after an initialization failure', async () => {
  await seed(25);
  await inPublisher(publisher(), async (instance, state) => {
    const transaction = state.storage.transaction.bind(state.storage);
    const spy = vi.spyOn(state.storage, 'transaction').mockRejectedValueOnce(new Error('Injected cursor storage failure'));
    const failure = await instance.readPostsV1('');
    expect(failure).toMatchObject({ ok: false, failure: { code: 'storage_error', stage: 'cursor_key', retryable: true } });
    spy.mockImplementation(callback => transaction(callback));
    const reads = await Promise.all(Array.from({ length: 4 }, () => instance.readPostsV1('')));
    expect(spy).toHaveBeenCalledTimes(2);
    const key = (await state.storage.get<string>('posts_cursor_key'))!;
    for (const read of reads) {
      expect(read.ok).toBe(true);
      const next = await readPosts(bindings.SITE_BUCKET, new URLSearchParams({ cursor: read.result.next_cursor }), key);
      expect(next.posts).toHaveLength(5);
    }
  });
});

it('loads at most four sources concurrently, preserves order, and never reads beyond the completed page', async () => {
  const publication = await seed(24, [0, 3]);
  let active = 0; let peak = 0; const reads: string[] = []; const gate = deferred();
  const store = bucket({ get: async key => {
    if (!key.startsWith('posts/')) return bindings.SITE_BUCKET.get(key);
    reads.push(key); active++; peak = Math.max(peak, active);
    try { await gate.promise; return await bindings.SITE_BUCKET.get(key); }
    finally { active--; }
  } });
  const pending = readPosts(store, new URLSearchParams('days=30'), 'private-key');
  try { await vi.waitFor(() => expect(active).toBe(4)); }
  finally { gate.resolve(); }
  const result = await pending;
  expect(peak).toBe(4); expect(result.posts).toHaveLength(20);
  expect(result.posts.map(post => post.post_id)).toEqual(Array.from({ length: 22 }, (_, i) => `id-${i}`).filter(id => !['id-0', 'id-3'].includes(id)));
  expect(reads).toEqual(publication.posts.slice(0, 22).map(ref => ref.key));
  expect(reads).not.toContain(publication.posts[22].key);
  const next = await readPosts(bindings.SITE_BUCKET, new URLSearchParams({ cursor: result.next_cursor! }), 'private-key');
  expect(next.posts.map(post => post.post_id)).toEqual(['id-22', 'id-23']);
});

it('reports the first source failure in manifest order even when a later failure completes earlier', async () => {
  const publication = await seed(4); const release = deferred(); const reached = deferred();
  const store = bucket({ get: async key => {
    if (key === publication.posts[0].key) { await release.promise; return null; }
    if (key === publication.posts[1].key) { reached.resolve(); throw new Error('Later failure'); }
    return bindings.SITE_BUCKET.get(key);
  } });
  const pending = readPosts(store, new URLSearchParams(), 'private-key');
  try { await completes(reached.promise); }
  finally { release.resolve(); }
  await expect(pending).rejects.toMatchObject({ source_key: publication.posts[0].key, reason: 'missing' });
});
