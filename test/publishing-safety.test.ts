import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { appendUpdate, currentPublication, loadPost, postKey, publishDigest, rebuildHomepage, retractPost } from '../src/publishing';
import { findBatch, loadHistoryIndex } from '../src/history-index';
import { readPosts } from '../src/posts';
import { fingerprint } from '../src/diagnostics';
import { loadCatalog, stableJson } from '../src/archives';
import { localDate } from '../src/feed';
import * as rendering from '../src/render';
import type { AppendResult, ContentBucket, Digest, Env, Publication, PublishResult, StoredPost } from '../src/types';

const bindings = env as unknown as Env;
const origin = 'https://lakearrowhead.town';
const secret = 'test-secret-at-least-thirty-two-characters-long';
const owner = fingerprint(secret);
const at = new Date('2026-10-20T18:00:00.000Z');
const input = (name = 'story', client_ref?: string, posted_at = new Date().toISOString()): Digest => ({
  title: 'Batch', source: 'community', ...(client_ref === undefined ? {} : { client_ref }),
  items: [{ group: 'Community', group_url: 'https://example.com/group', headline: name, body: 'A **story**.',
    post_url: `https://example.com/${name}`, category: 'news', posted_at }],
});
const update = (name = 'update') => ({ group: 'Community', body: 'More **information**.', post_url: `https://example.com/${name}`, posted_at: new Date().toISOString() });
const request = (path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) => worker.fetch(new Request(origin + path, {
  headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, ...init,
}), { ...bindings, ...overrides });
const post = (data: unknown, query = '') => request(`/api/digests${query}`, { method: 'POST', body: JSON.stringify(data) });
const submit = async (name = 'story', ref?: string) => {
  const response = await post(input(name, ref));
  expect(response.status).toBe(200);
  return response.json<PublishResult>();
};
const append = (id: string, name = 'update', query = '') => request(`/api/posts/${id}/items/0/updates${query}`, { method: 'POST', body: JSON.stringify(update(name)) });
const retract = (id: string) => request(`/api/posts/${id}/retract`, { method: 'POST' });
const lookup = (ref: string) => request(`/api/digests?client_ref=${encodeURIComponent(ref)}`);
const wrap = (overrides: Partial<ContentBucket>): ContentBucket => ({ get: key => bindings.SITE_BUCKET.get(key), head: key => bindings.SITE_BUCKET.head(key),
  put: (key, value, options) => bindings.SITE_BUCKET.put(key, value, options), list: options => bindings.SITE_BUCKET.list(options), ...overrides });
const history = async () => loadHistoryIndex(bindings.SITE_BUCKET, await currentPublication(bindings.SITE_BUCKET));
async function snapshot() {
  const objects = [];
  let cursor: string | undefined;
  do {
    const page = await bindings.SITE_BUCKET.list({ cursor });
    objects.push(...page.objects.map(object => ({ key: object.key, etag: object.etag })));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}
const inPublisher = runInDurableObject as unknown as <T>(stub: unknown, callback: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
const durableState = () => inPublisher(bindings.PUBLISHER.getByName('site'), async (_instance, state) => [...(await state.storage.list()).entries()]);

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
});

describe('production-state previews', () => {
  it('previews an unpublished site without any persistent or Durable Object writes', async () => {
    const before = await durableState();
    const response = await post(input('new', 'batch:preview'), '?dry_run=true');
    expect(response.status).toBe(200);
    expect(response.headers.get('X-API-Version')).toBe('3');
    const result = await response.json<PublishResult>();
    expect(result).toMatchObject({ ok: true, dry_run: true, committed: false, checked_at: expect.any(String), client_ref: 'batch:preview',
      warnings: [{ index: 0, field: 'items[0].category', code: 'unknown_category', value: 'news' }],
      counts: { submitted: 1, published: 1, duplicates: 0 }, items: [{ status: 'published', post_id: result.post!.id, item_index: 0 }] });
    expect(await snapshot()).toEqual([]);
    expect(await durableState()).toEqual(before);
    expect((await lookup('batch:preview')).status).toBe(404);
    const committed = await submit('new', 'batch:preview');
    expect(committed.post!.id).not.toBe(result.post!.id);
  });

  it('matches mixed and intra-batch deduplication against original and appended sources', async () => {
    const original = await submit();
    await append(original.post!.id);
    const data = input('fresh');
    data.items = [input().items[0], data.items[0], { ...data.items[0] }, { ...data.items[0], post_url: update().post_url }];
    const before = await snapshot();
    const preview = await (await post(data, '?dry_run=true')).json<PublishResult>();
    expect(preview.counts).toEqual({ submitted: 4, published: 1, duplicates: 3 });
    expect(preview.items).toMatchObject([
      { status: 'duplicate', post_id: original.post!.id, item_index: 0 },
      { status: 'published', post_id: preview.post!.id, item_index: 0 },
      { status: 'duplicate', post_id: preview.post!.id, item_index: 0 },
      { status: 'duplicate', post_id: original.post!.id, item_index: 0, update_index: 0 },
    ]);
    expect(await snapshot()).toEqual(before);
    const committed = await (await post(data)).json<PublishResult>();
    expect(committed.counts).toEqual(preview.counts);
    expect(committed.items.map(item => item.status)).toEqual(preview.items.map(item => item.status));
  });

  it('previews appends and duplicate appends without reserving indexes or URLs', async () => {
    const first = await submit();
    const before = await snapshot();
    const preview = await (await append(first.post!.id, 'update', '?dry_run=true')).json<AppendResult>();
    expect(preview).toMatchObject({ dry_run: true, committed: false, status: 'appended', post_id: first.post!.id, item_index: 0, update_index: 0 });
    expect(await snapshot()).toEqual(before);
    expect(await (await append(first.post!.id)).json()).toMatchObject({ status: 'appended', update_index: 0 });
    const committed = await snapshot();
    expect(await (await append(first.post!.id, 'update', '?dry_run=true')).json()).toMatchObject({ status: 'duplicate', dry_run: true, update_index: 0 });
    expect(await snapshot()).toEqual(committed);
    const absent = await append('missing', 'update', '?dry_run=true');
    expect(absent.status).toBe(404);
    expect(await absent.json()).toMatchObject({ code: 'story_not_found', publication_status: 'not_attempted', committed: false });
  });

  it('suppresses image-cache and archive writes and executes the real renderer', async () => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const hash = fingerprint(png);
    await bindings.SITE_BUCKET.put(`images/${hash}.png`, png);
    const data = input(); data.items[0].body = `![Photo](${origin}/images/${hash}.png)`;
    const before = await snapshot();
    const readonly = wrap({ put: async () => { throw new Error('Unexpected persistent write'); } });
    expect(await publishDigest(readonly, data, origin, new Date(), true, undefined, { dryRun: true })).toMatchObject({ dry_run: true });
    expect(await snapshot()).toEqual(before);
    expect(await bindings.SITE_BUCKET.get(`image-metadata/${hash}.json`)).toBeNull();
    vi.spyOn(rendering, 'renderPage').mockImplementationOnce(() => { throw new Error('injected renderer failure'); });
    const failed = await post(data, '?dry_run=true');
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ code: 'render_failed', publication_status: 'not_attempted', dry_run: true, committed: false });
    expect(await snapshot()).toEqual(before);
  });

  it.each(['', '1', 'TRUE', 'true&dry_run=false'])('rejects unsafe dry_run values before publication: %s', async value => {
    const response = await post(input(), `?dry_run=${value}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_dry_run', publication_status: 'not_attempted' });
    expect(await snapshot()).toEqual([]);
  });

  it('keeps ordinary validation and fails closed when preview RPCs are unavailable or malformed', async () => {
    expect((await post({ items: [] }, '?dry_run=true')).status).toBe(400);
    expect((await request('/api/digests?dry_run=true', { method: 'POST', headers: {}, body: '{}' })).status).toBe(401);
    expect((await request('/api/digests?dry_run=true', { method: 'POST', headers: { Authorization: `Bearer ${secret}` }, body: '{}' })).status).toBe(415);
    const publish = vi.fn();
    for (const previewDigestV1 of [undefined, async () => ({ ok: true, result: { post: { id: 'fake', date: localDate(new Date()), received_at: new Date().toISOString() },
      duplicate: false, counts: { submitted: 1, published: 1, duplicates: 0 }, items: [{ index: 0, status: 'published', post_id: 'fake', item_index: 0 }] } })]) {
      const response = await request('/api/digests?dry_run=true', { method: 'POST', body: JSON.stringify(input()) }, {
        PUBLISHER: { getByName: () => ({ publishV2: publish, previewDigestV1 }) } as unknown as Env['PUBLISHER'],
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ publication_status: 'not_attempted', dry_run: true, committed: false });
    }
    expect(publish).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual([]);
  });

  it.each(['missing_rpc', 'missing_dry_run', 'missing_committed', 'invalid_checked_at', 'committed', 'unknown', 'not_committed'] as const)('keeps append preview boundaries safe for a %s reply', async scenario => {
    const first = await submit();
    const before = await snapshot(); const stateBefore = await durableState();
    const appendUpdateV1 = vi.fn(); const publishV2 = vi.fn();
    const result: Record<string, unknown> = { status: 'appended', post_id: first.post!.id, item_index: 0, update_index: 0,
      message: 'Proposed update', dry_run: true, committed: false, checked_at: at.toISOString() };
    if (scenario === 'missing_dry_run') delete result.dry_run;
    if (scenario === 'missing_committed') delete result.committed;
    if (scenario === 'invalid_checked_at') result.checked_at = 'not a timestamp';
    const failure = ['committed', 'unknown', 'not_committed'].includes(scenario);
    const previewAppendV1 = scenario === 'missing_rpc' ? undefined : vi.fn(async () => failure
      ? { ok: false, failure: { status: 500, code: 'storage_error', error: 'Injected preview failure', retryable: true,
        stage: 'source_loading', publication_status: scenario } }
      : { ok: true, result });
    const response = await request(`/api/posts/${first.post!.id}/items/0/updates?dry_run=true`, { method: 'POST', body: JSON.stringify(update()) }, {
      PUBLISHER: { getByName: () => ({ appendUpdateV1, publishV2, previewAppendV1 }) } as unknown as Env['PUBLISHER'],
    });
    expect(response.status).toBe(failure ? 500 : 503);
    expect(await response.json()).toMatchObject({ publication_status: 'not_attempted', dry_run: true, committed: false });
    expect(appendUpdateV1).not.toHaveBeenCalled(); expect(publishV2).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before); expect(await durableState()).toEqual(stateBefore);
  });
});

describe('lookup-only client batch references', () => {
  it('echoes exact references through responses, full/compact reads, appends, rebuilds and eviction', async () => {
    const ref = 'Morning:20 / Batch A';
    const result = await submit('story', ref);
    expect(result.client_ref).toBe(ref);
    await append(result.post!.id);
    await rebuildHomepage(bindings.SITE_BUCKET, origin);
    await evictDurableObject(bindings.PUBLISHER.getByName('site'));
    expect(await (await lookup(ref)).json()).toMatchObject({ ok: true, client_ref: ref, post: result.post, status: 'published' });
    for (const fields of ['full', 'index']) expect(await (await request(`/api/posts?days=30&fields=${fields}`)).json()).toMatchObject({ posts: [{ client_ref: ref }] });
    expect((await lookup(ref.toLowerCase())).status).toBe(404);
    expect((await request(`/api/digests?client_ref=${encodeURIComponent(ref)}`, { method: 'HEAD' })).status).toBe(200);
  });

  it('rejects another commit using a reference but preserves duplicate-only retry behavior', async () => {
    const first = await submit('story', 'batch');
    const before = await snapshot();
    for (const query of ['', '?dry_run=true']) {
      const conflict = await post(input('another', 'batch'), query);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ code: 'client_ref_conflict' });
    }
    expect(await (await post(input('story', 'batch'))).json()).toMatchObject({ client_ref: 'batch', duplicate: true, post: null });
    expect(await (await post(input('story', 'unused'))).json()).toMatchObject({ client_ref: 'unused', duplicate: true });
    expect((await lookup('unused')).status).toBe(404);
    expect(await (await lookup('batch')).json()).toMatchObject({ post: first.post });
    expect(await snapshot()).toEqual(before);
  });

  it('serializes simultaneous reference claims', async () => {
    const responses = await Promise.all([post(input('a', 'one')), post(input('b', 'one'))]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect((await history()).batches.filter(batch => batch.client_ref === 'one')).toHaveLength(1);
  });

  it.each([null, '', ' ', 42, 'x'.repeat(129), 'bad\nref'])('rejects invalid references: %j', async client_ref => {
    const response = await post({ ...input(), client_ref });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'validation_failed', details: [{ path: 'client_ref', code: 'invalid_client_ref' }] });
    expect(await snapshot()).toEqual([]);
  });

  it('keeps reference records through source omission and expires them by original receipt dates', async () => {
    const first = await submit('damaged', 'recover');
    const publication = await currentPublication(bindings.SITE_BUCKET);
    await bindings.SITE_BUCKET.put(publication.posts[0].key, 'not JSON');
    await submit('other');
    expect(await (await lookup('recover')).json()).toMatchObject({ post: first.post, status: 'published' });
    const old = new Date('2026-10-01T18:00:00Z');
    const published = await publishDigest(bindings.SITE_BUCKET, input('old', 'dated', old.toISOString()), origin, old, true, undefined, { publisherFingerprint: owner });
    await appendUpdate(bindings.SITE_BUCKET, published.post!.id, 0, update('recent'), origin, new Date('2026-10-30T18:00:00Z'), true);
    const index = await history();
    expect(findBatch(index, 'dated', new Date('2026-10-30T18:00:00Z')).post).toEqual(published.post);
    expect(() => findBatch(index, 'dated', new Date('2026-10-31T18:00:00Z'))).toThrow();
    expect((await publishDigest(bindings.SITE_BUCKET, input('replacement', 'dated'), origin, new Date('2026-10-31T18:00:00Z'), true)).post).not.toBeNull();
  });
});

describe('caller-scoped whole-batch retraction', () => {
  it('removes current public and authenticated copies, releases URLs, and preserves private sources', async () => {
    const first = await submit('retract-me', 'batch');
    const id = first.post!.id;
    const original = await (await bindings.SITE_BUCKET.get(postKey(first.post!)))!.text();
    await append(id);
    const response = await retract(id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, post_id: id, status: 'retracted', retracted_at: expect.any(String) });
    for (const path of ['/', '/rss.xml']) expect(await (await request(path)).text()).not.toContain('retract-me');
    for (const fields of ['full', 'index']) expect(await (await request(`/api/posts?days=30&fields=${fields}`)).json()).toMatchObject({ posts: [] });
    const publication = await currentPublication(bindings.SITE_BUCKET);
    expect((await loadCatalog(bindings.SITE_BUCKET, publication.archives)).days).toEqual({});
    expect(await (await bindings.SITE_BUCKET.get(postKey(first.post!)))!.text()).toBe(original);
    expect((await loadPost(bindings.SITE_BUCKET, publication.posts[0])).items).toEqual([]);
    expect(await (await lookup('batch')).json()).toMatchObject({ post: first.post, status: 'retracted' });
    const before = await snapshot();
    expect(await (await retract(id)).json()).toMatchObject({ status: 'already_retracted' });
    expect(await snapshot()).toEqual(before);
    await rebuildHomepage(bindings.SITE_BUCKET, origin);
    await evictDurableObject(bindings.PUBLISHER.getByName('site'));
    expect(await (await request('/api/posts')).json()).toMatchObject({ posts: [] });
    expect((await append(id)).status).toBe(404);
    expect((await post(input('retract-me', 'batch'))).status).toBe(409);
    expect((await submit('retract-me', 'correction')).duplicate).toBe(false);
    expect((await submit('update')).duplicate).toBe(false);
  });

  it('enforces recorded ownership and ignores submitted ownership/receipt/retraction fields', async () => {
    const other = 'rotated-secret-at-least-thirty-two-characters-long';
    const first = await (await post({ ...input(), publisher_fingerprint: fingerprint(other), retracted_at: at.toISOString(), received_at: at.toISOString() })).json<PublishResult>();
    expect((await history()).batches[0].publisher_fingerprint).toBe(owner);
    const path = `/api/posts/${first.post!.id}/retract`;
    expect((await request(path, { method: 'POST', headers: {} })).status).toBe(401);
    const rotated = await request(path, { method: 'POST', headers: { Authorization: `Bearer ${other}` } }, { API_SECRET: other });
    expect(rotated.status).toBe(403);
    expect(await rotated.json()).toMatchObject({ code: 'retract_forbidden' });
    expect((await lookup('absent')).status).toBe(404);
    expect((await retract('missing')).status).toBe(404);
    expect((await request(path, { method: 'GET' })).status).toBe(405);
    const legacy = await publishDigest(bindings.SITE_BUCKET, input('legacy'), origin);
    expect((await retract(legacy.post!.id)).status).toBe(403);
    expect((await retract(first.post!.id)).status).toBe(200);
  });

  it('uses an exact 24-hour receipt deadline, unaffected by appends, and permits later retries', async () => {
    const first = await publishDigest(bindings.SITE_BUCKET, input('window', 'window', at.toISOString()), origin, at, true, undefined, { publisherFingerprint: owner });
    await appendUpdate(bindings.SITE_BUCKET, first.post!.id, 0, update(), origin, new Date(at.getTime() + 23 * 3600000), true);
    const deadline = new Date(at.getTime() + 86400000);
    await expect(retractPost(bindings.SITE_BUCKET, first.post!.id, owner, origin, deadline, true)).rejects.toMatchObject({ cause: { code: 'retract_window_expired' } });
    const done = await retractPost(bindings.SITE_BUCKET, first.post!.id, owner, origin, new Date(deadline.getTime() - 1), true);
    const before = await snapshot();
    expect(await retractPost(bindings.SITE_BUCKET, first.post!.id, owner, origin, new Date(deadline.getTime() + 86400000), true)).toEqual({ ...done, status: 'already_retracted' });
    expect(await snapshot()).toEqual(before);
  });

  it('can retract a damaged owned batch without restoring its body', async () => {
    const first = await submit('damaged', 'damaged');
    const publication = await currentPublication(bindings.SITE_BUCKET);
    await bindings.SITE_BUCKET.put(publication.posts[0].key, 'invalid JSON');
    await submit('other');
    expect((await retract(first.post!.id)).status).toBe(200);
    expect(await (await lookup('damaged')).json()).toMatchObject({ status: 'retracted' });
  });

  it('serializes retraction with appends and repeated requests without reviving content', async () => {
    const first = await submit('race', 'race');
    const responses = await Promise.all([append(first.post!.id), retract(first.post!.id), retract(first.post!.id)]);
    expect([200, 404]).toContain(responses[0].status);
    const results = await Promise.all(responses.slice(1).map(response => response.json<any>()));
    expect(results.map(result => result.status).sort()).toEqual(['already_retracted', 'retracted']);
    expect((await history()).posts.every(post => post.items.length === 0)).toBe(true);
    expect((await submit('race', 'corrected')).duplicate).toBe(false);
  });

  it.each(['source_write', 'archive_catalog_write', 'history_index_write', 'manifest_write', 'rss_write', 'index_write'])('preserves the previous public batch after failed retraction at %s', async stage => {
    const first = await submit('atomic', 'atomic');
    const before = await currentPublication(bindings.SITE_BUCKET);
    const beforePage = await bindings.SITE_BUCKET.head('pages/index.html');
    const broken = wrap({ put: async (key, value, options) => {
      if (stage === 'source_write' && key.startsWith('post-revisions/') || stage === 'archive_catalog_write' && key.startsWith('archive-catalogs/')
        || stage === 'history_index_write' && key.startsWith('history-index/') || stage === 'manifest_write' && key.startsWith('publications/') && key.endsWith('.json')
        || stage === 'rss_write' && key.endsWith('.rss.xml') || stage === 'index_write' && key === 'pages/index.html') throw new Error('injected retraction failure');
      return bindings.SITE_BUCKET.put(key, value, options);
    } });
    await expect(retractPost(broken, first.post!.id, owner, origin, new Date(), true)).rejects.toMatchObject({ stage, publication_status: stage === 'index_write' ? 'unknown' : 'not_committed' });
    expect(await currentPublication(bindings.SITE_BUCKET)).toEqual(before);
    expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.etag).toBe(beforePage!.etag);
    expect(await (await lookup('atomic')).json()).toMatchObject({ status: 'published' });
    expect(await (await retract(first.post!.id)).json()).toMatchObject({ status: 'retracted' });
  });
});

describe('compact snapshots and atomic recovery', () => {
  it('reads fixed pre-refactor history bytes without changing their hash, URL acceptance, or serialization', async () => {
    // History-index bytes in the pre-refactor 0ef1b33 format. Keep these bytes and
    // the independently calculated SHA-256 literal; do not regenerate in the test.
    const body = '{"batches":[{"client_ref":"Historical: café / A","date":"2026-10-19","id":"historical-v3","received_at":"2026-10-19T18:00:00.000Z"}],"posts":[{"client_ref":"Historical: café / A","date":"2026-10-19","items":[{"item_index":0,"last_received_at":"2026-10-20T18:00:00.000Z","latest_activity_at":"2026-10-20T10:00:00-07:00","post_url":"https://example.com/story?x=1&y=2","posted_at":"2026-10-19T10:30:00-07:00","updates":[{"post_url":"http://example.com/update#one","posted_at":"2026-10-20T10:00:00-07:00","received_at":"2026-10-20T18:00:00.000Z","update_index":0}]}],"post_id":"historical-v3","received_at":"2026-10-19T18:00:00.000Z"}],"version":1}';
    const key = 'history-index/9cef83c97d8ea13224ad2d900a434bd8a34897753776802480f4bba7348c1e9c.json';
    await bindings.SITE_BUCKET.put(key, body);
    const publication: Publication = { version: 3, history_index: key, posts: [{ id: 'historical-v3', date: '2026-10-19',
      key: 'posts/2026-10-19/historical-v3.json', received_at: '2026-10-19T18:00:00.000Z' }], snapshot_date: '2026-10-20', published_at: at.toISOString() };
    const index = await loadHistoryIndex(bindings.SITE_BUCKET, publication);
    expect(stableJson(index)).toBe(body);
    expect(index.posts[0].items[0]).toMatchObject({ item_index: 0, post_url: 'https://example.com/story?x=1&y=2',
      updates: [{ update_index: 0, post_url: 'http://example.com/update#one', posted_at: '2026-10-20T10:00:00-07:00' }] });
    expect(findBatch(index, 'Historical: café / A', at)).toMatchObject({ status: 'published', post: { id: 'historical-v3', received_at: '2026-10-19T18:00:00.000Z' } });
  });

  it('reads v3 compact indexes and references without fetching source bodies or exposing ownership', async () => {
    const first = await submit('story', 'compact'); await append(first.post!.id);
    const noSources = wrap({ get: async key => {
      if (/^(?:posts|post-revisions|digests)\//.test(key)) throw new Error('Unexpected source read');
      return bindings.SITE_BUCKET.get(key);
    } });
    const compact = await readPosts(noSources, new URLSearchParams('days=30&fields=index'), 'cursor-secret');
    expect(compact.posts).toMatchObject([{ post_id: first.post!.id, client_ref: 'compact', items: [{ item_index: 0, post_url: input().items[0].post_url,
      updates: [{ update_index: 0, post_url: update().post_url }] }] }]);
    const serialized = JSON.stringify(compact);
    for (const text of ['publisher_fingerprint', owner, 'body', 'headline', 'group', 'category', 'title', 'source']) expect(serialized).not.toContain(`"${text}"`);
    expect(findBatch(await loadHistoryIndex(noSources, await currentPublication(noSources)), 'compact', new Date()).post).toEqual(first.post);
  });

  it('pins compact pagination to its representation and snapshot, with legacy projection support', async () => {
    const date = localDate(new Date()); const received_at = new Date().toISOString();
    const posts: StoredPost[] = Array.from({ length: 25 }, (_, i) => ({ ...input(`seed-${i}`), id: `seed-${i}`, date, received_at }));
    for (const value of posts) await bindings.SITE_BUCKET.put(postKey(value), JSON.stringify(value));
    await bindings.SITE_BUCKET.put('publications/seed.json', JSON.stringify({ version: 2, posts: posts.map(value => ({ id: value.id, date, received_at, key: postKey(value) })), snapshot_date: date, published_at: received_at }));
    await bindings.SITE_BUCKET.put('pages/index.html', 'seed', { customMetadata: { manifest: 'publications/seed.json' } });
    expect((await readPosts(bindings.SITE_BUCKET, new URLSearchParams('fields=index'), 'secret')).posts).toHaveLength(20);
    await rebuildHomepage(bindings.SITE_BUCKET, origin);
    const first = await (await request('/api/posts?days=30&fields=index')).json<any>();
    expect(first.posts).toHaveLength(20);
    await append('seed-24');
    const second = await (await request(`/api/posts?cursor=${first.next_cursor}`)).json<any>();
    expect(second.fields).toBe('index'); expect(second.posts).toHaveLength(5);
    expect(second.posts[4].items[0].updates).toEqual([]);
    expect(second.published_at).toBe(first.published_at);
    for (const query of [`cursor=${first.next_cursor}&fields=full`, `cursor=${first.next_cursor}&days=7`, 'fields=unknown', 'fields=index&fields=full']) {
      expect((await request(`/api/posts?${query}`)).status).toBe(400);
    }
    const legacyFull = await (await request('/api/posts?days=30')).json<any>();
    expect((await request(`/api/posts?cursor=${legacyFull.next_cursor}&fields=index`)).status).toBe(400);
  });

  it.each(['source_write', 'history_index_write', 'manifest_write', 'rss_write', 'index_write'])('keeps failed publications private and leaves references retryable after %s', async stage => {
    const broken = wrap({ put: async (key, value, options) => {
      if (stage === 'source_write' && key.startsWith('posts/') || stage === 'history_index_write' && key.startsWith('history-index/')
        || stage === 'manifest_write' && key.startsWith('publications/') && key.endsWith('.json')
        || stage === 'rss_write' && key.endsWith('.rss.xml') || stage === 'index_write' && key === 'pages/index.html') throw new Error('injected');
      return bindings.SITE_BUCKET.put(key, value, options);
    } });
    await expect(publishDigest(broken, input('failure', 'retry'), origin, new Date(), true)).rejects.toMatchObject({ stage, publication_status: stage === 'index_write' ? 'unknown' : 'not_committed' });
    expect((await lookup('retry')).status).toBe(404);
    expect((await currentPublication(bindings.SITE_BUCKET)).posts).toEqual([]);
    expect(await bindings.SITE_BUCKET.head('pages/index.html')).toBeNull();
    expect((await submit('failure', 'retry')).post).not.toBeNull();
  });

  it('resolves lost commit acknowledgements using the reference and idempotent retraction retry', async () => {
    const lostAck = wrap({ put: async (key, value, options) => {
      const result = await bindings.SITE_BUCKET.put(key, value, options);
      if (key === 'pages/index.html') throw new Error('lost acknowledgement');
      return result;
    } });
    await expect(publishDigest(lostAck, input('landed', 'landed'), origin, new Date(), true, undefined, { publisherFingerprint: owner })).rejects.toMatchObject({ publication_status: 'unknown' });
    const committed = await (await lookup('landed')).json<any>();
    expect(committed.status).toBe('published');
    await expect(retractPost(lostAck, committed.post.id, owner, origin, new Date(), true)).rejects.toMatchObject({ publication_status: 'unknown' });
    expect(await (await lookup('landed')).json()).toMatchObject({ status: 'retracted' });
    expect(await (await retract(committed.post.id)).json()).toMatchObject({ status: 'already_retracted' });
  });

  it('rejects a damaged committed compact index instead of treating it as empty history', async () => {
    await submit('story', 'integrity');
    const publication = await currentPublication(bindings.SITE_BUCKET);
    const index = await history();
    for (const body of ['not JSON', JSON.stringify({ ...index, posts: [] }), JSON.stringify({ ...index, batches: [{ ...index.batches[0], publisher_fingerprint: 'bad' }] })]) {
      await bindings.SITE_BUCKET.put(publication.history_index!, body);
      expect((await request('/api/posts?fields=index')).status).toBe(500);
      expect((await lookup('integrity')).status).toBe(500);
      expect((await post(input('new', 'integrity'))).status).toBe(500);
    }
  });
});
