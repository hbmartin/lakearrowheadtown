import { env } from 'cloudflare:workers';
import { reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { fingerprint } from '../src/diagnostics';
import { publicationFailure } from '../src/errors';
import { IMAGE_LIMIT } from '../src/images';
import * as rendering from '../src/render';
import { currentPublication, loadPost, postKey, publishDigest, rebuildHomepage } from '../src/publishing';
import { recentDates, renderPage } from '../src/render';
import type { ContentBucket, Digest, Env, OperationContext, Publication, PublishReply, PublishResult, RebuildJob, StoredPost } from '../src/types';

const bindings = env as unknown as Env;
// Avoid recursively expanding Env.PUBLISHER's RPC types in the test helper.
const inPublisher = runInDurableObject as unknown as <T>(stub: unknown, callback: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
const base = 'https://lakearrowhead.town';
const secret = 'test-secret-at-least-thirty-two-characters-long';
const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
const input = (url = 'https://example.com/story'): Digest => ({ title: 'Batch', source: 'source', items: [{
  group: 'Community', group_url: 'https://example.com/group', headline: 'Original headline', body: 'Original body',
  post_url: url, category: '', posted_at: new Date().toISOString(),
}] });
function request(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) {
  return worker.fetch(new Request(base + path, init), { ...bindings, CF_VERSION_METADATA: { id: 'test-release' }, ENVIRONMENT: 'preview', ...overrides });
}
const submit = (value: unknown, overrides: Partial<Env> = {}) => request('/api/digests', { method: 'POST', headers, body: JSON.stringify(value) }, overrides);
const bucketWith = (overrides: Partial<ContentBucket>): ContentBucket => ({
  get: key => bindings.SITE_BUCKET.get(key), head: key => bindings.SITE_BUCKET.head(key),
  put: (key, value, options) => bindings.SITE_BUCKET.put(key, value, options), list: options => bindings.SITE_BUCKET.list(options), ...overrides,
});
async function snapshot() {
  const page = await bindings.SITE_BUCKET.get('pages/index.html');
  return { manifest: await currentPublication(bindings.SITE_BUCKET), html: await page?.text(), etag: page?.etag,
    uploaded: page?.uploaded.toISOString(), keys: (await bindings.SITE_BUCKET.list()).objects.map(object => object.key) };
}
async function seed(posts: StoredPost[]) {
  const publication: Publication = { version: 1, posts: posts.map(post => ({ id: post.id, date: post.date, received_at: post.received_at, key: postKey(post) })), snapshot_date: posts[0].date, published_at: posts[0].received_at };
  for (const post of posts) await bindings.SITE_BUCKET.put(postKey(post), JSON.stringify(post));
  await bindings.SITE_BUCKET.put('publications/seed.json', JSON.stringify(publication));
  await bindings.SITE_BUCKET.put('pages/index.html', renderPage(posts, { origin: base, publication }), { customMetadata: { manifest: 'publications/seed.json' } });
}

let infoEvents: unknown[][] = [];
let errorEvents: unknown[][] = [];
beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  infoEvents = []; errorEvents = [];
  vi.spyOn(console, 'info').mockImplementation((...args) => { infoEvents.push(args); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((...args) => { errorEvents.push(args); });
});

describe('source URL duplicate suppression', () => {
  it('returns original item identities without any writes on identical or edited retries', async () => {
    const digest = input();
    const first = await (await submit(digest)).json<PublishResult>();
    const before = await snapshot();
    for (const payload of [digest, { ...digest, title: 'Different batch', source: 'other', items: [{ ...digest.items[0], headline: 'Edited headline', body: 'Edited body' }] }]) {
      const response = await submit(payload);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, url: '/', post: null, duplicate: true,
        counts: { submitted: 1, published: 0, duplicates: 1 }, items: [{ index: 0, status: 'duplicate', post_id: first.post!.id, item_index: 0 }] });
      expect(await snapshot()).toEqual(before);
    }
  });
  it('filters overlapping and intra-batch URLs while preserving new item order and original indexes', async () => {
    const old = await (await submit(input('https://example.com/old'))).json<PublishResult>();
    const digest = input();
    digest.items = ['old', 'new-b', 'new-b', 'new-a', 'old'].map(name => ({ ...digest.items[0], post_url: `https://example.com/${name}`, headline: name }));
    const result = await (await submit(digest)).json<PublishResult>();
    expect(result.counts).toEqual({ submitted: 5, published: 2, duplicates: 3 });
    expect(result.duplicate).toBe(false);
    expect(result.items).toEqual([
      { index: 0, status: 'duplicate', post_id: old.post!.id, item_index: 0 },
      { index: 1, status: 'published', post_id: result.post!.id, item_index: 0 },
      { index: 2, status: 'duplicate', post_id: result.post!.id, item_index: 0 },
      { index: 3, status: 'published', post_id: result.post!.id, item_index: 1 },
      { index: 4, status: 'duplicate', post_id: old.post!.id, item_index: 0 },
    ]);
    const stored = await (await bindings.SITE_BUCKET.get(postKey(result.post!)))!.json<StoredPost>();
    expect(stored.items.map(item => item.headline)).toEqual(['new-b', 'new-a']);
  });
  it('treats query strings and fragments as part of the exact URL', async () => {
    const digest = input();
    digest.items = ['', '?a=1', '?a=2', '#a', '#b', '/'].map(suffix => ({ ...digest.items[0], post_url: 'https://example.com/story' + suffix }));
    expect((await (await submit(digest)).json<PublishResult>()).counts.published).toBe(6);
  });
  it('counts hidden historical items as duplicates even when their timestamps are corrected', async () => {
    const digest = input(); digest.items[0].posted_at = '2000-01-01T00:00:00Z';
    const first = await (await submit(digest)).json<PublishResult>();
    expect(await (await request('/')).text()).not.toContain('Original headline');
    const before = await snapshot();
    const corrected = await (await submit(input())).json<PublishResult>();
    expect(corrected).toMatchObject({ duplicate: true, post: null, items: [{ post_id: first.post!.id }] });
    expect(await snapshot()).toEqual(before);
  });
  it('deduplicates against eligible legacy sources discovered during the same publication', async () => {
    await submit(input('https://example.com/committed'));
    await bindings.SITE_BUCKET.put('digests/2099-01-01.json', JSON.stringify(input()));
    const before = await snapshot();
    const duplicate = await (await submit(input())).json<PublishResult>();
    expect(duplicate).toMatchObject({ duplicate: true, items: [{ post_id: 'legacy-2099-01-01', item_index: 0 }] });
    expect(await snapshot()).toEqual(before);
    const mixed = input(); mixed.items.push(input('https://example.com/new').items[0]);
    expect((await (await submit(mixed)).json<PublishResult>()).counts).toEqual({ submitted: 2, published: 1, duplicates: 1 });
    expect((await (await request('/')).text()).match(/class="digest-item"/g)).toHaveLength(3);
  });
  it('serializes simultaneous submissions of the same URLs', async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () => submit(input())));
    const results = await Promise.all(responses.map(response => response.json<PublishResult>()));
    expect(results.reduce((count, result) => count + result.counts.published, 0)).toBe(1);
    expect(new Set(results.map(result => result.items[0].post_id)).size).toBe(1);
    expect((await bindings.SITE_BUCKET.list({ prefix: 'posts/' })).objects).toHaveLength(1);
  });
  it.each([
    ['2026-10-18T06:59:59Z', '2026-10-24T06:59:59Z', '2026-10-24T07:00:00Z'],
    ['2026-03-07T08:00:00Z', '2026-03-14T06:59:59Z', '2026-03-14T07:00:00Z'],
    ['2026-10-31T07:00:00Z', '2026-11-07T07:59:59Z', '2026-11-07T08:00:00Z'],
  ])('uses original LA receipt dates across midnight and DST: %s', async (firstTime, lastTime, expiredTime) => {
    const digest = input();
    const first = await publishDigest(bindings.SITE_BUCKET, digest, base, new Date(firstTime), true);
    const before = await snapshot();
    const duplicate = await publishDigest(bindings.SITE_BUCKET, digest, base, new Date(lastTime), true);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.items[0].post_id).toBe(first.post!.id);
    expect(await snapshot()).toEqual(before);
    const expired = await publishDigest(bindings.SITE_BUCKET, digest, base, new Date(expiredTime), true);
    expect(expired.duplicate).toBe(false);
    expect(expired.post!.id).not.toBe(first.post!.id);
  });
  it('preserves historical duplicates and deterministically references the oldest receipt, ID and position', async () => {
    const now = new Date();
    const oldTime = new Date(now.getTime() - 60000).toISOString();
    const make = (id: string, received_at: string, twice = false): StoredPost => ({ ...input(), id, received_at, date: recentDates(now)[0], items: twice ? [input().items[0], input().items[0]] : input().items });
    const posts = [make('z', now.toISOString()), make('b', oldTime), make('a', oldTime, true)];
    await seed(posts);
    const before = await snapshot();
    const result = await (await submit(input())).json<PublishResult>();
    expect(result.items[0]).toMatchObject({ post_id: 'a', item_index: 0 });
    expect(await snapshot()).toEqual(before);
    await submit(input('https://example.com/new'));
    const html = await (await request('/')).text();
    expect(html.match(/class="digest-item"/g)).toHaveLength(5);
  });
  it('does not reserve URLs belonging to orphaned source objects', async () => {
    const orphan: StoredPost = { ...input(), id: 'orphan', date: recentDates(new Date())[0], received_at: new Date().toISOString() };
    await bindings.SITE_BUCKET.put(postKey(orphan), JSON.stringify(orphan));
    const result = await (await submit(input())).json<PublishResult>();
    expect(result.counts.published).toBe(1);
    expect((await currentPublication(bindings.SITE_BUCKET)).posts.map(post => post.id)).not.toContain('orphan');
  });
  it('reads empty historical sources and supports the documented manual cleanup and restoration', async () => {
    const result = await (await submit(input())).json<PublishResult>();
    const ref = (await currentPublication(bindings.SITE_BUCKET)).posts[0];
    const original = await (await bindings.SITE_BUCKET.get(ref.key))!.json<StoredPost>();
    await bindings.SITE_BUCKET.put('operator-backups/saved.json', JSON.stringify(original));
    await bindings.SITE_BUCKET.put(ref.key, JSON.stringify({ ...original, items: [] }));
    expect((await loadPost(bindings.SITE_BUCKET, ref)).items).toEqual([]);
    await rebuildHomepage(bindings.SITE_BUCKET, base);
    expect(await (await request('/')).text()).not.toContain('Original headline');
    expect((await (await submit(input())).json<PublishResult>()).post!.id).not.toBe(result.post!.id);
    await bindings.SITE_BUCKET.put(ref.key, JSON.stringify(original));
    await rebuildHomepage(bindings.SITE_BUCKET, base);
    expect(await (await request('/')).text()).toContain('Original headline');
  });
  it('matches a repaired omitted source without writes, then restores it on the next new publication', async () => {
    const first = await (await submit(input())).json<PublishResult>();
    const ref = (await currentPublication(bindings.SITE_BUCKET)).posts[0];
    const source = await (await bindings.SITE_BUCKET.get(ref.key))!.text();
    await bindings.SITE_BUCKET.delete(ref.key);
    await submit(input('https://example.com/healthy'));
    expect((await currentPublication(bindings.SITE_BUCKET)).omitted_posts).toEqual([ref]);
    await bindings.SITE_BUCKET.put(ref.key, source);
    const before = await snapshot();
    const result = await (await submit(input())).json<PublishResult>();
    expect(result).toMatchObject({ duplicate: true, post: null, counts: { published: 0, duplicates: 1 }, items: [{ post_id: first.post!.id }] });
    expect(await snapshot()).toEqual(before);
    const mixed = input(); mixed.items.push(input('https://example.com/new').items[0]);
    expect((await (await submit(mixed)).json<PublishResult>()).counts).toEqual({ submitted: 2, published: 1, duplicates: 1 });
    expect((await currentPublication(bindings.SITE_BUCKET)).omitted_posts).toBeUndefined();
    expect((await (await request('/')).text()).match(/class="digest-item"/g)).toHaveLength(3);
  });
});

describe('commit failures and retries', () => {
  it('keeps old Workers and the existing preview Worker compatible with the legacy RPC', async () => {
    const publisher = bindings.PUBLISHER.getByName('site');
    // A pre-v2 Worker ignores the value; the current preview Worker reads .ok.
    await publisher.publish(input(), base);
    const previewReply = await publisher.publish(input('https://example.com/preview'), base);
    expect(previewReply).toMatchObject({ ok: true, result: { counts: { published: 1 } } });
    const before = await snapshot();
    await bindings.SITE_BUCKET.put('publications/invalid.json', '{}');
    await bindings.SITE_BUCKET.put('pages/index.html', before.html!, { customMetadata: { manifest: 'publications/invalid.json' } });
    let rejected = false;
    try { await publisher.publish(input('https://example.com/failure'), base); }
    catch { rejected = true; }
    expect(rejected).toBe(true);
    expect(await publisher.publishV2(input('https://example.com/failure'), base)).toMatchObject({ ok: false, failure: { status: 500, code: 'manifest_damaged', retryable: false, publication_status: 'not_committed' } });
  });
  it.each([undefined, { ok: true }, { ok: false, failure: { status: '500' } }])('rejects invalid RPC replies without falling back to a legacy publish: %j', async reply => {
    const legacy = vi.fn();
    const PUBLISHER = { getByName: () => ({ publish: legacy, publishV2: async () => reply }) } as unknown as Env['PUBLISHER'];
    const response = await submit(input(), { PUBLISHER });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'service_unavailable', retryable: true, publication_status: 'unknown' });
    expect(legacy).not.toHaveBeenCalled();
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });
  it('returns a retryable response when an old Durable Object has no versioned RPC', async () => {
    const legacy = vi.fn(async () => undefined);
    const response = await submit(input(), { PUBLISHER: { getByName: () => ({ publish: legacy }) } as unknown as Env['PUBLISHER'] });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ publication_status: 'unknown', retryable: true });
    expect(legacy).not.toHaveBeenCalled();
    expect(await (await submit(input())).json()).toMatchObject({ counts: { published: 1 } });
  });
  it('classifies actual storage failures, rendering failures, and unexpected code failures separately', async () => {
    const publisher = bindings.PUBLISHER.getByName('site');
    const stored = await inPublisher<PublishReply>(publisher, async (instance) => {
      const original = instance.env;
      instance.env = { ...original, SITE_BUCKET: bucketWith({ head: async () => { throw new Error('private storage detail'); } }) };
      try { return await instance.publishV2(input(), base); }
      finally { instance.env = original; }
    });
    expect(stored).toMatchObject({ ok: false, failure: { status: 500, code: 'storage_error', retryable: true } });
    const render = vi.spyOn(rendering, 'renderPage').mockImplementation(() => { throw new Error('private render data'); });
    expect(await publisher.publishV2(input(), base)).toMatchObject({ ok: false, failure: { code: 'render_failed', retryable: false, stage: 'rendering' } });
    render.mockRestore();
    expect(publicationFailure(new TypeError('private bug'), 'processing', 'not_committed')).toMatchObject({ code: 'internal_error', retryable: false });
    const uncertain = publicationFailure(new TypeError('private bug'), 'index_write', 'unknown');
    expect(uncertain.retryable).toBe(true);
    expect(uncertain.error).toContain('unchanged payload');
  });
  it.each(['source_write', 'manifest_write', 'index_write'] as const)('does not suppress a retry after a failed %s', async stage => {
    const broken = bucketWith({ put: async (key, value, options) => {
      if ((stage === 'source_write' && key.startsWith('posts/')) || (stage === 'manifest_write' && key.startsWith('publications/')) || (stage === 'index_write' && key === 'pages/index.html')) throw new Error('private upstream value');
      return bindings.SITE_BUCKET.put(key, value, options);
    } });
    await expect(publishDigest(broken, input(), base, new Date(), true)).rejects.toMatchObject({ stage, publication_status: stage === 'index_write' ? 'unknown' : 'not_committed' });
    expect((await currentPublication(bindings.SITE_BUCKET)).posts).toEqual([]);
    const retried = await publishDigest(bindings.SITE_BUCKET, input(), base, new Date(), true);
    expect(retried.counts.published).toBe(1);
    expect((await currentPublication(bindings.SITE_BUCKET)).posts).toHaveLength(1);
  });
  it('detects a committed publication after an index write acknowledgement is lost', async () => {
    const broken = bucketWith({ put: async (key, value, options) => {
      const result = await bindings.SITE_BUCKET.put(key, value, options);
      if (key === 'pages/index.html') throw new Error('lost acknowledgement');
      return result;
    } });
    await expect(publishDigest(broken, input(), base, new Date(), true)).rejects.toMatchObject({ stage: 'index_write', publication_status: 'unknown' });
    const before = await snapshot();
    expect((await publishDigest(bindings.SITE_BUCKET, input(), base, new Date(), true)).duplicate).toBe(true);
    expect(await snapshot()).toEqual(before);
  });
  it('reports a lost RPC acknowledgement as unknown and deduplicates the unchanged HTTP retry', async () => {
    const PUBLISHER = { getByName: () => ({ publishV2: async (digest: Digest, origin: string, context: OperationContext) => {
      await bindings.PUBLISHER.getByName('site').publishV2(digest, origin, context);
      throw new Error('private lost response');
    } }) } as unknown as Env['PUBLISHER'];
    const failed = await submit(input(), { PUBLISHER });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: 'service_unavailable', publication_status: 'unknown', retryable: true });
    const before = await snapshot();
    expect(await (await submit(input())).json()).toMatchObject({ duplicate: true, post: null });
    expect(await snapshot()).toEqual(before);
  });
  it('preserves typed publisher failure metadata at the HTTP boundary', async () => {
    const reply: PublishReply = { ok: false, failure: { status: 500, code: 'storage_error', error: 'Storage unavailable; retry the unchanged payload.', stage: 'source_loading', publication_status: 'not_committed', retryable: true } };
    const PUBLISHER = { getByName: () => ({ publishV2: async () => reply }) } as unknown as Env['PUBLISHER'];
    const response = await submit(input(), { PUBLISHER });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'storage_error', publication_status: 'not_committed', details: { stage: 'source_loading' } });
  });
  it('uses the HTTP status supplied by typed failures and overrides unsafe advice for unknown outcomes', async () => {
    const failure = { status: 503, code: 'service_unavailable', error: 'Unavailable', stage: 'migration_state', publication_status: 'unknown', retryable: false };
    const response = await submit(input(), { PUBLISHER: { getByName: () => ({ publishV2: async () => ({ ok: false, failure }) }) } as unknown as Env['PUBLISHER'] });
    expect(response.status).toBe(503);
    const result = await response.json<any>();
    expect(result).toMatchObject({ code: 'service_unavailable', publication_status: 'unknown', retryable: true });
    expect(result.error).toContain('unchanged payload');
  });
});

describe('actionable diagnostics', () => {
  it('reports one structural issue per invalid object and keeps later field errors visible', async () => {
    const root = await (await submit(null)).json<any>();
    expect(root.details).toEqual([{ path: 'digest', code: 'invalid_type', message: 'Expected an object.' }]);
    const payload = input();
    const result = await (await submit({ ...payload, items: [...Array(7).fill(null), { ...payload.items[0], headline: 3 }] })).json<any>();
    expect(result.details).toHaveLength(8);
    expect(result.details[7]).toMatchObject({ path: 'items[7].headline', code: 'invalid_type' });
    expect(result.details_truncated).toBe(false);
  });
  it.each(['position 12 abcdefghijklmnopqrstuvwxyz', '"position 12" trailing', '{"x":"position 12",\n}'])('does not use quoted input as a syntax position: %s', async body => {
    const response = await request('/api/digests', { method: 'POST', headers, body });
    const result = await response.json<any>();
    expect(result.code).toBe('invalid_json');
    if (body.startsWith('position')) expect(result.details).toEqual({});
    else expect(result.details.position).toBe(body.indexOf(body.startsWith('"') ? 'trailing' : '}'));
    expect(JSON.stringify(result)).not.toContain('position 12');
  });
  it.each(['/api/digests', '/api/images'])('distinguishes declared size from bytes read on early rejection at %s', async path => {
    const length = path.endsWith('images') ? IMAGE_LIMIT + 65537 : 1048577;
    for (const body of ['small', undefined]) {
      const response = await request(path, { method: 'POST', headers: { ...headers, 'Content-Type': path.endsWith('images') ? 'multipart/form-data; boundary=test' : 'application/json', 'Content-Length': String(length) }, body });
      expect(response.status).toBe(413);
      const result = await response.json<any>();
      expect(result.diagnostics).toMatchObject({ declared_body_bytes: length, bytes_received: 0, body_complete: false });
      expect(result.diagnostics.body_sha256).toBeUndefined();
    }
  });
  it('records EOF for a fully read but malformed multipart body', async () => {
    const body = '--test\r\nContent-Disposition: form-data; name="file"; filename="x"\r\n\r\npayload';
    const response = await request('/api/images', { method: 'POST', headers: { ...headers, 'Content-Type': 'multipart/form-data; boundary=test' }, body });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_multipart', diagnostics: { bytes_received: body.length, body_complete: true } });
  });
  it('distinguishes a multipart stream failure from malformed form syntax', async () => {
    let pulls = 0;
    const body = new ReadableStream({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('--test\r\n'));
      else controller.error(new Error('private stream data'));
    } });
    const response = await request('/api/images', { method: 'POST', headers: { ...headers, 'Content-Type': 'multipart/form-data; boundary=test' }, body });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'body_read_failed', retryable: true, diagnostics: { body_complete: false } });
  });
  it('requires repair for configuration errors and preserves minimal public errors', async () => {
    const response = await submit(input(), { API_SECRET: '' });
    expect(await response.json()).toMatchObject({ code: 'configuration_error', retryable: false });
    for (const path of ['/missing', `/images/${'a'.repeat(64)}.png`]) {
      expect(await (await request(path)).json()).toEqual({ ok: false, error: 'Not found' });
    }
    expect(await (await request('/api/missing')).json()).toMatchObject({ code: 'not_found', diagnostics: { stage: 'public_read' } });
  });
  it('records duplicate-only successes without a failure-oriented publication status', async () => {
    await submit(input());
    const response = await submit(input());
    const result = await response.json<any>();
    const events = infoEvents.map(args => args[0] as any).filter(event => event.request_id === result.request_id);
    for (const name of ['publish_result', 'request_completed']) {
      const event = events.find(event => event.event === name);
      expect(event).toMatchObject({ publication_outcome: 'duplicate' });
      expect(event.publication_status).toBeUndefined();
    }
  });
  it('separates RPC transport success from the delivered application failure', async () => {
    const reply: PublishReply = { ok: false, failure: { status: 500, code: 'render_failed', error: 'Rendering requires repair.', stage: 'rendering', publication_status: 'not_committed', retryable: false } };
    const response = await submit(input(), { PUBLISHER: { getByName: () => ({ publishV2: async () => reply }) } as unknown as Env['PUBLISHER'] });
    const result = await response.json<any>();
    expect(result).toMatchObject({ code: 'render_failed', retryable: false, diagnostics: { stage: 'rendering' } });
    const events = infoEvents.map(args => args[0] as any).filter(event => event.request_id === result.request_id);
    expect(events.find(event => event.stage === 'publisher_rpc')).toMatchObject({ outcome: 'error', transport_outcome: 'ok' });
    expect(events.find(event => event.event === 'request_completed')).toMatchObject({ status: 500, publication_outcome: 'failed' });
  });
  it.each(['enqueue_rebuild', 'rebuild_status', 'resume_rebuild'])('classifies unavailable rebuild RPCs at %s', async stage => {
    const id = '00000000-0000-0000-0000-000000000000';
    const path = stage === 'enqueue_rebuild' ? '/api/rebuild' : `/api/rebuild/${id}${stage === 'resume_rebuild' ? '/resume' : ''}`;
    const failed = () => { throw new Error('private RPC failure'); };
    const response = await request(path, { method: stage === 'rebuild_status' ? 'GET' : 'POST', headers }, { PUBLISHER: { getByName: () => ({ enqueueRebuild: failed, jobStatus: failed, resumeRebuild: failed }) } as unknown as Env['PUBLISHER'] });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'service_unavailable', retryable: true, diagnostics: { stage } });
  });
  it('attributes rebuild bookkeeping failures after a successful index write to finalization', async () => {
    await submit(input());
    const response = await request('/api/rebuild', { method: 'POST', headers });
    const result = await response.json<any>();
    const publisher = bindings.PUBLISHER.getByName('site');
    const failed = await inPublisher<RebuildJob | undefined>(publisher, async (instance, state) => {
      const original = state.storage.transaction.bind(state.storage);
      let calls = 0;
      const spy = vi.spyOn(state.storage, 'transaction').mockImplementation(async callback => {
        if (++calls === 2) throw new Error('private finalize failure');
        return original(callback);
      });
      try { await instance.alarm(); }
      finally { spy.mockRestore(); }
      return state.storage.get<RebuildJob>(`job:${result.job.id}`);
    });
    expect(failed).toMatchObject({ status: 'failed', failed_stage: 'rebuild_finalize', error_code: 'storage_error' });
    const event = errorEvents.map(args => args[0] as any).find(event => event.event === 'rebuild_failed');
    expect(event).toMatchObject({ job_id: result.job.id, request_id: result.request_id, stage: 'rebuild_finalize', publication_status: 'committed' });
    expect(await (await request('/')).text()).toContain('Original headline');
  });
  it('reports multiple field issues and rejects the entire batch before writes', async () => {
    const digest = input();
    const response = await submit({ ...digest, title: '', source: 1, items: [...digest.items, { ...digest.items[0], posted_at: 'private-invalid-timestamp', post_url: 'private-invalid-url' }] });
    expect(response.status).toBe(400);
    const result = await response.json<any>();
    expect(result).toMatchObject({ ok: false, code: 'validation_failed', retryable: false, publication_status: 'not_attempted', details_truncated: false });
    expect(result.details.map((issue: any) => issue.path)).toEqual(['title', 'source', 'items[1].post_url', 'items[1].posted_at']);
    expect(JSON.stringify(result)).not.toContain('private-invalid');
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });
  it('bounds error details and explicitly rejects empty batches', async () => {
    const response = await submit({ ...input(), items: Array.from({ length: 20 }, () => ({})) });
    const result = await response.json<any>();
    expect(result.details).toHaveLength(50);
    expect(result.details_truncated).toBe(true);
    const empty = await submit({ ...input(), items: [] });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ details: [{ path: 'items', code: 'empty_items', message: 'At least one story is required.' }] });
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });
  it.each([
    ['invalid_utf8', new Uint8Array([0xc3, 0x28])],
    ['invalid_json', new TextEncoder().encode('{"title":"x",\n}')],
  ])('distinguishes %s and fingerprints the actual bytes without excerpts', async (code, body) => {
    const response = await request('/api/digests', { method: 'POST', headers, body });
    expect(response.status).toBe(400);
    const result = await response.json<any>();
    expect(result).toMatchObject({ code, publication_status: 'not_attempted', diagnostics: { bytes_received: body.length, body_complete: true, body_sha256: fingerprint(body) } });
    if (code === 'invalid_json') expect(result.details).toMatchObject({ line: 2, column: 1, position: 14 });
  });
  it('never presents a partial oversized read as a complete body hash', async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(600000)); controller.enqueue(new Uint8Array(600000)); controller.close(); } });
    const response = await request('/api/digests', { method: 'POST', headers, body });
    expect(response.status).toBe(413);
    const result = await response.json<any>();
    expect(result.diagnostics).toMatchObject({ bytes_received: 1200000, body_complete: false });
    expect(result.diagnostics.body_sha256).toBeUndefined();
  });
  it('classifies body stream failures without implying publication was attempted', async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([123])); controller.error(new Error('private stream content')); } });
    const response = await request('/api/digests', { method: 'POST', headers, body });
    expect(response.status).toBe(500);
    const result = await response.json<any>();
    expect(result).toMatchObject({ code: 'body_read_failed', publication_status: 'not_attempted', retryable: true });
    expect(result.diagnostics.body_sha256).toBeUndefined();
  });
  it('returns correlation and deployed version headers for API successes, errors, unknown routes, and HEAD', async () => {
    const responses = [await submit(input()), await submit({ ...input(), items: [] }),
      await request('/api/digests'), await request('/api/images', { method: 'POST' }),
      await request('/api/rebuild/00000000-0000-0000-0000-000000000000', { headers }),
      await request('/api/unknown'), await request('/api/digests', { method: 'HEAD' })];
    const ids = new Set();
    for (const response of responses) {
      const id = response.headers.get('X-Request-ID'); ids.add(id);
      expect(id).toMatch(/^[a-f0-9-]{36}$/);
      expect(response.headers.get('X-Worker-Version')).toBe('test-release');
      expect(response.headers.get('X-API-Version')).toBe('2');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const text = await response.text();
      if (text) expect(JSON.parse(text).request_id).toBe(id);
    }
    expect(ids.size).toBe(responses.length);
  });
  it('correlates publisher stages and request outcomes without retaining submitted values or credentials', async () => {
    const logs = infoEvents;
    const payload = input('https://example.com/private-source-url');
    payload.title = 'private-batch-label'; payload.items[0].body = 'private-body-content';
    const response = await submit(payload);
    const result = await response.json<any>();
    const events = logs.map(args => args[0] as any).filter(event => event.request_id === result.request_id);
    expect(events.find(event => event.event === 'request_completed')).toMatchObject({ worker_version: 'test-release', status: 200, counts: { submitted: 1, published: 1, duplicates: 0 }, publication_status: 'committed', body_sha256: fingerprint(JSON.stringify(payload)) });
    const stages = events.filter(event => event.event === 'operation_stage').map(event => event.stage);
    expect(stages).toEqual(expect.arrayContaining(['authentication', 'body_reading', 'parsing', 'validation', 'queue_wait', 'source_loading', 'duplicate_filtering', 'source_write', 'rendering', 'manifest_write', 'index_write']));
    const serialized = JSON.stringify(logs);
    for (const value of [secret, payload.title, payload.items[0].body, payload.items[0].post_url]) expect(serialized).not.toContain(value);
  });
  it('sanitizes unexpected exception messages and query strings', async () => {
    const response = await request('/?private-query-value', {}, { SITE_BUCKET: { head: () => { throw new Error('private-error-value'); } } as unknown as R2Bucket });
    expect(response.status).toBe(500);
    const captured = JSON.stringify([infoEvents, errorEvents]);
    expect(captured).not.toMatch(/private-error-value|private-query-value/);
    expect(captured).toContain('stack_frames');
  });
  it('correlates rebuild completion back to its enqueue request', async () => {
    const response = await request('/api/rebuild', { method: 'POST', headers });
    const result = await response.json<any>();
    await runDurableObjectAlarm(bindings.PUBLISHER.getByName('site'));
    const completion = infoEvents.map(args => args[0] as any).find(event => event.event === 'rebuild_completed');
    expect(completion).toMatchObject({ request_id: result.request_id, job_id: result.job.id });
  });
  it('quietly accepts old and future timestamps without changing the submitted source dates', async () => {
    for (const posted_at of ['2000-01-01T00:00:00Z', '2099-01-01T00:00:00Z']) {
      const payload = input('https://example.com/' + posted_at);
      payload.items[0].posted_at = posted_at;
      const response = await submit(payload);
      expect(response.status).toBe(200);
      const result = await response.json<any>();
      expect(result.warnings).toBeUndefined();
      const stored = await (await bindings.SITE_BUCKET.get(postKey(result.post)))!.json<StoredPost>();
      expect(stored.items[0].posted_at).toBe(posted_at);
    }
  });
});
