import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { currentPublication, publishDigest, rebuildHomepage } from '../src/publishing';
import { loadHistoryIndex } from '../src/history-index';
import { createImageResolutionCache, createImageResolver, metadataKey } from '../src/image-metadata';
import { OperationTrace } from '../src/diagnostics';
import { prepareWrites } from '../src/prepared-writes';
import { publicationFailure } from '../src/errors';
import type { ContentBucket, Digest, Env, Publication, StoredPost } from '../src/types';

const bindings = env as unknown as Env;
const origin = 'https://lakearrowhead.town';
const at = new Date('2026-10-20T18:00:00Z');
const secret = 'test-secret-at-least-thirty-two-characters-long';
const digest = (name: string): Digest => ({ title: name, source: 'Community', items: [{ group: 'Group', group_url: origin,
  headline: name, body: 'Story body', category: '', post_url: `${origin}/source/${name}`, posted_at: at.toISOString() }] });
const store = (overrides: Partial<ContentBucket> = {}): ContentBucket => ({ get: key => bindings.SITE_BUCKET.get(key),
  head: key => bindings.SITE_BUCKET.head(key), put: (key, body, options) => bindings.SITE_BUCKET.put(key, body, options),
  list: options => bindings.SITE_BUCKET.list(options), ...overrides });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function seedSources(count = 8) {
  const posts: StoredPost[] = Array.from({ length: count }, (_, i) => ({ ...digest(`Source-${i}`), id: `source-${i}`, date: '2026-10-20', received_at: at.toISOString() }));
  const publication: Publication = { version: 2, posts: posts.map(post => ({ id: post.id, key: `posts/${post.date}/${post.id}.json`, date: post.date, received_at: post.received_at })),
    snapshot_date: '2026-10-20', published_at: at.toISOString() };
  for (let i = 0; i < posts.length; i++) await bindings.SITE_BUCKET.put(publication.posts[i].key, JSON.stringify(posts[i]));
  await bindings.SITE_BUCKET.put('publications/sources.json', JSON.stringify(publication));
  await bindings.SITE_BUCKET.put('pages/index.html', 'Original homepage', { customMetadata: { manifest: 'publications/sources.json' } });
  return publication;
}
beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
});

it('loads rebuild sources four at a time and preserves publication order after reversed completions', async () => {
  const original = await seedSources();
  const gates = new Map<string, ReturnType<typeof deferred>>(); const reads: string[] = [];
  let active = 0; let peak = 0; let released = false;
  const rebuilding = rebuildHomepage(store({ get: async key => {
    if (!key.startsWith('posts/')) return bindings.SITE_BUCKET.get(key);
    const gate = deferred(); gates.set(key, gate); reads.push(key); active++; peak = Math.max(peak, active);
    try { if (!released) await gate.promise; return await bindings.SITE_BUCKET.get(key); }
    finally { active--; }
  } }), origin);
  try {
    await vi.waitFor(() => expect(reads).toHaveLength(4));
    expect(active).toBe(4); expect(reads).toEqual(original.posts.slice(0, 4).map(ref => ref.key));
    for (const ref of original.posts.slice(0, 4).reverse()) gates.get(ref.key)!.resolve();
    await vi.waitFor(() => expect(reads).toHaveLength(8));
    expect(active).toBe(4);
  } finally { released = true; for (const gate of gates.values()) gate.resolve(); }
  expect(await rebuilding).toEqual({ kind: 'committed' });
  expect(peak).toBe(4); expect(active).toBe(0);
  expect(reads).toEqual(original.posts.map(ref => ref.key));
  const index = await loadHistoryIndex(bindings.SITE_BUCKET, await currentPublication(bindings.SITE_BUCKET));
  expect(index.posts.map(post => post.post_id)).toEqual(original.posts.map(ref => ref.id));
});

it('settles failed source batches and chooses the first failure in publication order', async () => {
  const original = await seedSources();
  const gates = new Map<string, ReturnType<typeof deferred>>(); const reads: string[] = [];
  const put = vi.fn(store().put); let active = 0; let settled = false;
  const trace = new OperationTrace();
  const outcome = rebuildHomepage(store({ put, get: async key => {
    if (!key.startsWith('posts/')) return bindings.SITE_BUCKET.get(key);
    const gate = deferred(); gates.set(key, gate); reads.push(key); active++;
    try { await gate.promise; return key === original.posts[0].key || key === original.posts[1].key ? null : await bindings.SITE_BUCKET.get(key); }
    finally { active--; }
  } }), origin, trace).then(result => ({ result, error: undefined }), error => ({ result: undefined, error })).finally(() => { settled = true; });
  try {
    await vi.waitFor(() => expect(reads).toHaveLength(4));
    gates.get(original.posts[1].key)!.resolve();
    await vi.waitFor(() => expect(active).toBe(3));
    expect(settled).toBe(false);
  } finally { for (const gate of gates.values()) gate.resolve(); }
  expect((await outcome).error).toMatchObject({ code: 'source_damaged', post_id: original.posts[0].id });
  expect(active).toBe(0); expect(reads).toHaveLength(4); expect(put).not.toHaveBeenCalled();
  expect(trace.failed_stage).toBe('source_loading'); expect(trace.phase).toBeUndefined();
});

it('shares image results across committed daily staging views and the final homepage', async () => {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
  const paths = ['a', 'b', 'c', 'd'].map(char => `images/${char.repeat(64)}.png`);
  await bindings.SITE_BUCKET.put(paths[0], png); await bindings.SITE_BUCKET.put(paths[1], 'invalid image');
  await bindings.SITE_BUCKET.put(paths[3], png);
  const input = digest('Across-days');
  input.items[0].posted_at = '2026-10-19T18:00:00Z';
  input.items[0].body = paths.slice(0, 3).map(path => `![Image](/${path})`).join('\n\n');
  const post: StoredPost['items'][number] = { ...input.items[0], updates: [{ group: 'Group', body: 'Update',
    post_url: `${origin}/update`, posted_at: at.toISOString(), received_at: at.toISOString() }] };
  input.items = [post, { ...digest('Second-day-image').items[0], body: `![Later image](/${paths[3]})` }];
  await publishDigest(bindings.SITE_BUCKET, input, origin, at, true);
  for (const char of ['a', 'd']) await bindings.SITE_BUCKET.delete(metadataKey(char.repeat(64)));
  const reads = new Map<string, number>(); const writes: string[] = [];
  const result = await rebuildHomepage(store({ get: key => { reads.set(key, (reads.get(key) ?? 0) + 1); return bindings.SITE_BUCKET.get(key); },
    put: (key, body, options) => { writes.push(key); return bindings.SITE_BUCKET.put(key, body, options); } }), origin, undefined, true, undefined, { jobId: crypto.randomUUID() });
  expect(result).toMatchObject({ kind: 'committed', progress: { completed_days: 2, total_days: 2 } });
  for (const path of paths) {
    expect(reads.get(path)).toBe(1);
    expect(reads.get(metadataKey(path.split('/')[1].slice(0, 64)))).toBe(1);
  }
  for (const char of ['a', 'd']) {
    const key = metadataKey(char.repeat(64));
    expect(writes.filter(written => written === key)).toHaveLength(1);
    expect(await (await bindings.SITE_BUCKET.get(key))!.json()).toEqual({ width: 1, height: 1, type: 'image/png' });
  }
  // A later alarm gets fresh cache state and can discover a repaired image.
  await bindings.SITE_BUCKET.put(paths[1], png);
  await rebuildHomepage(bindings.SITE_BUCKET, origin, undefined, true, undefined, { jobId: crypto.randomUUID() });
  expect(await bindings.SITE_BUCKET.get(metadataKey('b'.repeat(64)))).not.toBeNull();
});

it('shares the two-request image limiter and in-flight results across resolver views', async () => {
  const gate = deferred(); let active = 0; let peak = 0; let reads = 0;
  const observed = store({ get: async key => {
    active++; peak = Math.max(peak, active); reads++;
    try { await gate.promise; return await bindings.SITE_BUCKET.get(key); }
    finally { active--; }
  } });
  const cache = createImageResolutionCache();
  const first = createImageResolver(observed, origin, cache); const second = createImageResolver(observed, origin, cache);
  const items = (chars: string[]) => [{ ...digest('Image').items[0], body: chars.map(char => `![Image](/images/${char.repeat(64)}.png)`).join('\n\n') }];
  const resolving = Promise.all([first(items(['a', 'b'])), second(items(['b', 'c', 'd']))]);
  try { await vi.waitFor(() => expect(active).toBe(2)); }
  finally { gate.resolve(); }
  await resolving;
  expect(peak).toBe(2); expect(active).toBe(0); expect(reads).toBe(8);
});

it.each([['a', 'b'], ['b', 'a']])('keeps stage and error attribution together when writes %s and %s fail concurrently', async (first, second) => {
  const rejects = new Map<string, (error: Error) => void>(); const errors = { a: new Error('a'), b: new Error('b') };
  const trace = new OperationTrace(); const written: string[] = [];
  const prepared = prepareWrites(store({ put: key => { written.push(key); return new Promise((_resolve, reject) => { rejects.set(key, reject); }); } }), trace);
  for (const key of ['a', 'b', 'pages/index.html']) await trace.run(key, () => prepared.bucket.put(key, key));
  const outcome = prepared.commit().then(() => undefined, error => error);
  rejects.get(first)!(errors[first as keyof typeof errors]); rejects.get(second)!(errors[second as keyof typeof errors]);
  expect((await outcome).cause).toBe(errors[first as keyof typeof errors]);
  expect(trace.failed_stage).toBe(first); expect(trace.phase).toBeUndefined();
  expect(written).toEqual(['a', 'b']);
});

it('uses retraction wording for committed failures without changing certainty or retryability', async () => {
  for (const retryable of [true, false]) {
    const failure = publicationFailure(new Error('private error'), 'after_commit', 'committed', 'retract');
    expect(failure).toMatchObject({ publication_status: 'committed', retryable: false });
    expect(failure.error).toBe('Retraction committed, but subsequent processing failed. Use the request ID to contact the operator.');
    const response = await worker.fetch(new Request(`${origin}/api/posts/owned/retract`, { method: 'POST', headers: { Authorization: `Bearer ${secret}` } }), {
      ...bindings, PUBLISHER: { getByName: () => ({ retractPostV1: async () => ({ ok: false, failure: { status: 500, code: 'storage_error',
        error: 'Publication committed', stage: 'after_commit', publication_status: 'committed', retryable } }) }) } as unknown as Env['PUBLISHER'],
    });
    expect(await response.json()).toMatchObject({ publication_status: 'committed', retryable, message: failure.error });
  }
});
