import { env } from 'cloudflare:workers';
import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import { evictDurableObject, reset, runDurableObjectAlarm } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { appendUpdate, currentPublication, loadPost, postKey, publishDigest, rebuildHomepage } from '../src/publishing';
import { readPosts } from '../src/posts';
import { localDate, recentDates, selectFeedItems } from '../src/feed';
import { renderPage } from '../src/render';
import { renderRss } from '../src/rss';
import type { AppendResult, ContentBucket, Digest, Env, Publication, PublishResult, StoredPost, StoryUpdate } from '../src/types';

const bindings = env as unknown as Env;
const origin = 'https://lakearrowhead.town';
const secret = 'test-secret-at-least-thirty-two-characters-long';
const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
const now = () => new Date().toISOString();
function digest(name = 'Original', posted_at = now()): Digest {
  return { title: 'Batch', source: 'groups', items: [{ group: 'Community', group_url: 'https://example.com/group',
    headline: name, body: 'Original **story**', post_url: `https://example.com/${name}`, category: 'news', posted_at }] };
}
const update = (name = 'followup', posted_at = now()): StoryUpdate => ({ group: 'Other group', post_url: `https://example.com/${name}`, body: 'Road **reopened**.', posted_at });
const request = (path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) => worker.fetch(new Request(origin + path, { headers, ...init }), { ...bindings, ...overrides });
const submit = async (input = digest()) => (await request('/api/digests', { method: 'POST', body: JSON.stringify(input) })).json<PublishResult>();
const append = (id: string, input: unknown = update(), index = '0', overrides: Partial<Env> = {}) => request(`/api/posts/${id}/items/${index}/updates`, { method: 'POST', body: JSON.stringify(input) }, overrides);
const bucketWith = (overrides: Partial<ContentBucket>): ContentBucket => ({ get: key => bindings.SITE_BUCKET.get(key), head: key => bindings.SITE_BUCKET.head(key), put: (key, value, options) => bindings.SITE_BUCKET.put(key, value, options), list: options => bindings.SITE_BUCKET.list(options), ...overrides });
async function snapshot() {
  const index = await bindings.SITE_BUCKET.get('pages/index.html');
  return { publication: await currentPublication(bindings.SITE_BUCKET), html: await index?.text(), etag: index?.etag,
    rss: index?.customMetadata?.rss ? await (await bindings.SITE_BUCKET.get(index.customMetadata.rss))!.text() : undefined };
}
async function seed(posts: StoredPost[], version: 1 | 2 = 2) {
  const publication: Publication = { version, posts: posts.map(post => ({ id: post.id, key: postKey(post), date: post.date, received_at: post.received_at,
    last_received_at: post.items.flatMap(item => (item.updates ?? []).map(update => update.received_at)).sort().at(-1) ?? post.received_at })), snapshot_date: localDate(new Date()), published_at: now() };
  for (const post of posts) await bindings.SITE_BUCKET.put(postKey(post), JSON.stringify(post));
  await bindings.SITE_BUCKET.put('publications/seed.json', JSON.stringify(publication));
  await bindings.SITE_BUCKET.put('pages/index.html', renderPage(posts, { origin, publication }), { customMetadata: { manifest: 'publications/seed.json' } });
}
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await reset();
});

describe('authenticated story reads and updates', () => {
  it('reads an empty feed with correlation headers and protects both routes', async () => {
    for (const path of ['/api/posts', '/api/posts/unknown/items/0/updates']) {
      const response = await request(path, { method: path.endsWith('updates') ? 'POST' : 'GET', headers: {} });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ message: 'Unauthorized', suggestion: { action: 'authenticate' } });
    }
    const response = await request('/api/posts');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-api-version')).toBe('2');
    expect(await response.json()).toMatchObject({ ok: true, request_id: response.headers.get('x-request-id'), days: 7, posts: [], published_at: null, next_cursor: null });
    expect((await request('/api/posts', { method: 'POST' })).status).toBe(405);
    const head = await request('/api/posts', { method: 'HEAD' });
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
  });
  it('appends optional notes and group links without changing the original source', async () => {
    const first = await submit();
    const id = first.post!.id;
    const original = await (await bindings.SITE_BUCKET.get(postKey(first.post!)))!.text();
    const response = await append(id);
    expect(await response.json()).toMatchObject({ ok: true, status: 'appended', post_id: id, item_index: 0, update_index: 0, message: expect.any(String) });
    expect((await append(id, { group: 'Community', group_url: 'https://example.com/group2', post_url: 'https://example.com/link-only', posted_at: now() })).status).toBe(200);
    expect(await (await bindings.SITE_BUCKET.get(postKey(first.post!)))!.text()).toBe(original);
    const publication = await currentPublication(bindings.SITE_BUCKET);
    expect(publication.version).toBe(2);
    expect(publication.posts[0].key).toMatch(/^post-revisions\//);
    const result = await (await request('/api/posts')).json<any>();
    expect(result.posts[0]).toMatchObject({ post_id: id, items: [{ item_index: 0, headline: 'Original', body: 'Original **story**',
      latest_activity_at: expect.any(String), last_received_at: expect.any(String), updates: [
        { update_index: 0, body: 'Road **reopened**.', received_at: expect.any(String) }, { update_index: 1, body: '', group_url: 'https://example.com/group2' },
      ] }] });
    const current = await snapshot();
    expect(current.html).toContain('Road <strong>reopened</strong>');
    expect(current.html).toContain('Additional source');
    expect(current.html).toContain('Updated <time');
    expect(current.html!.match(/<article class="digest-item"/g)).toHaveLength(1);
    expect(current.rss).toContain('reopened'); expect(current.rss).toContain('link-only');
    await rebuildHomepage(bindings.SITE_BUCKET, origin);
    expect(await snapshot()).toMatchObject({ publication: current.publication, html: current.html, rss: current.rss });
  });
  it('deduplicates sources globally through either API without writes or changed content', async () => {
    const a = await submit(digest('A'));
    const b = await submit(digest('B'));
    await append(a.post!.id);
    const before = await snapshot();
    const keys = (await bindings.SITE_BUCKET.list()).objects.map(object => object.key);
    for (const target of [a.post!.id, b.post!.id]) {
      const result = await (await append(target, { ...update(), body: 'Changed wording' })).json<AppendResult>();
      expect(result).toMatchObject({ status: 'duplicate', post_id: a.post!.id, item_index: 0, update_index: 0, suggestion: { action: 'review_existing_story', path: '/api/posts?days=30' } });
    }
    const baseDuplicate = await (await append(b.post!.id, { ...update(), post_url: digest('A').items[0].post_url })).json<AppendResult>();
    expect(baseDuplicate).toMatchObject({ status: 'duplicate', post_id: a.post!.id });
    expect(baseDuplicate.update_index).toBeUndefined();
    const submitted = digest('Followup'); submitted.items[0].post_url = update().post_url;
    expect(await submit(submitted)).toMatchObject({ duplicate: true, items: [{ post_id: a.post!.id, update_index: 0, message: expect.any(String), suggestion: { action: 'review_existing_story' } }] });
    expect(await snapshot()).toEqual(before);
    expect((await bindings.SITE_BUCKET.list()).objects.map(object => object.key)).toEqual(keys);
  });
  it('serializes simultaneous appends and digest/append URL races', async () => {
    const first = await submit(); const id = first.post!.id;
    const responses = await Promise.all(Array.from({ length: 5 }, () => append(id)));
    const results = await Promise.all(responses.map(response => response.json<AppendResult>()));
    expect(results.filter(result => result.status === 'appended')).toHaveLength(1);
    await Promise.all(Array.from({ length: 4 }, (_, i) => append(id, update(`distinct-${i}`))));
    await evictDurableObject(bindings.PUBLISHER.getByName('site'));
    expect((await readPosts(bindings.SITE_BUCKET, new URLSearchParams(), secret)).posts[0].items[0].updates).toHaveLength(5);
    const input = digest('race'); const source = { ...update('race'), post_url: input.items[0].post_url };
    const [published, added] = await Promise.all([submit(input), append(id, source).then(response => response.json<AppendResult>())]);
    expect(Number(!published.duplicate) + Number(added.status === 'appended')).toBe(1);
  });
  it.each([null, [], {}, { ...update(), posted_at: '2026-02-30T12:00:00Z' }, { ...update(), group_url: null }, { ...update(), post_url: 'javascript:alert(1)' }, { ...update(), body: 1 }])('rejects invalid updates before writes: %j', async value => {
    const first = await submit(); const before = await snapshot();
    const response = await append(first.post!.id, value);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'validation_failed', publication_status: 'not_attempted', suggestion: { action: 'correct_request' }, diagnostics: { body_complete: true, body_sha256: expect.any(String) } });
    expect(await snapshot()).toEqual(before);
  });
  it('handles unavailable targets, invalid indexes, MIME, body limits and missing RPCs', async () => {
    const first = await submit(); const path = `/api/posts/${first.post!.id}/items/0/updates`;
    const absent = await append('unknown');
    expect(absent.status).toBe(404);
    expect(await absent.json()).toMatchObject({ code: 'story_not_found', suggestion: { action: 'find_story_or_publish' }, publication_status: 'not_committed' });
    expect((await append(first.post!.id, update(), '-1')).status).toBe(400);
    expect((await append(first.post!.id, update(), '999')).status).toBe(404);
    expect((await request(path, { method: 'GET' })).status).toBe(405);
    expect((await request(path, { method: 'POST', headers: { Authorization: headers.Authorization }, body: '{}' })).status).toBe(415);
    expect((await request(path, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413);
    expect((await request(path, { method: 'POST', body: '{' })).status).toBe(400);
    const unavailable = await append(first.post!.id, update(), '0', { PUBLISHER: { getByName: () => ({}) } as unknown as Env['PUBLISHER'] });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: 'service_unavailable', publication_status: 'unknown', retryable: true });
  });
});

describe('snapshot reads and publication failure recovery', () => {
  it('pins pagination to the committed source revisions while new updates publish', async () => {
    const received_at = now();
    const posts: StoredPost[] = Array.from({ length: 25 }, (_, i) => ({ ...digest(`Story-${i}`), id: `id-${i}`, date: localDate(new Date()), received_at }));
    await seed(posts);
    const first = await (await request('/api/posts?days=30')).json<any>();
    expect(first.posts).toHaveLength(20); expect(first.next_cursor).toBeTruthy();
    await evictDurableObject(bindings.PUBLISHER.getByName('site'));
    await append('id-24');
    const second = await (await request(`/api/posts?cursor=${first.next_cursor}`)).json<any>();
    expect(second.posts).toHaveLength(5); expect(second.next_cursor).toBeNull();
    expect(second.posts[4]).toMatchObject({ post_id: 'id-24', items: [{ updates: [] }] });
    expect(second.published_at).toBe(first.published_at); expect(second.as_of).toBe(first.as_of);
    expect((await readPosts(bindings.SITE_BUCKET, new URLSearchParams('days=30'), secret)).posts.find(post => post.post_id === 'id-24')!.items[0].updates).toHaveLength(1);
    for (const query of [`days=7&cursor=${first.next_cursor}`, `cursor=${first.next_cursor.slice(0, -4)}abcd`, 'cursor=', 'days=0', 'days=31', 'days=7.0', 'days=1&days=2']) {
      expect((await request(`/api/posts?${query}`)).status).toBe(400);
    }
  });
  it('rejects a cursor forged with the caller credential and never reads an orphan manifest', async () => {
    await submit();
    await bindings.SITE_BUCKET.put('publications/orphan.json', JSON.stringify({ version: 2, posts: [], snapshot_date: null, published_at: null }));
    const payload = Buffer.from(JSON.stringify({ snapshot: 'orphan', as_of: now(), days: 7, offset: 0 })).toString('base64url');
    const signature = createHmac('sha256', secret).update(`posts-v1:${payload}`).digest('base64url');
    const response = await request(`/api/posts?cursor=${payload}.${signature}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_cursor', suggestion: { action: 'restart_read' } });
  });
  it('filters by individual receipt activity without renumbering items', async () => {
    const old = new Date(Date.now() - 35 * 86400000).toISOString();
    const post: StoredPost = { ...digest(), id: 'mixed', date: localDate(new Date(old)), received_at: old };
    post.items.push({ ...digest('Kept').items[0], updates: [{ ...update(), received_at: now() }] });
    await seed([post]);
    const result = await readPosts(bindings.SITE_BUCKET, new URLSearchParams('days=30'), secret);
    expect(result.posts[0].items.map(item => item.item_index)).toEqual([1]);
    expect(selectFeedItems([post], await currentPublication(bindings.SITE_BUCKET)).map(item => item.itemIndex)).toEqual([1]);
    expect((await append(post.id)).status).toBe(404);
    const duplicate = await submit(); expect(duplicate.duplicate).toBe(false);
  });
  it.each(['source_write', 'manifest_write', 'rss_write', 'index_write'])('keeps uncommitted updates private after %s failure and allows retry', async stage => {
    const first = await submit(); const id = first.post!.id; const before = await snapshot();
    const broken = bucketWith({ put: async (key, value, options) => {
      if ((stage === 'source_write' && key.startsWith('post-revisions/')) || (stage === 'manifest_write' && key.startsWith('publications/') && key.endsWith('.json'))
        || (stage === 'rss_write' && key.endsWith('.rss.xml')) || (stage === 'index_write' && key === 'pages/index.html')) throw new Error('injected failure');
      return bindings.SITE_BUCKET.put(key, value, options);
    } });
    await expect(appendUpdate(broken, id, 0, update(), origin, new Date(), true)).rejects.toMatchObject({ stage, publication_status: stage === 'index_write' ? 'unknown' : 'not_committed' });
    expect(await snapshot()).toEqual(before);
    expect((await readPosts(bindings.SITE_BUCKET, new URLSearchParams(), secret)).posts[0].items[0].updates).toEqual([]);
    expect(await appendUpdate(bindings.SITE_BUCKET, id, 0, update(), origin, new Date(), true)).toMatchObject({ status: 'appended', update_index: 0 });
  });
  it('recognizes commits after lost index and RPC acknowledgements', async () => {
    const first = await submit(); const id = first.post!.id;
    const broken = bucketWith({ put: async (key, value, options) => {
      const result = await bindings.SITE_BUCKET.put(key, value, options);
      if (key === 'pages/index.html') throw new Error('lost acknowledgement');
      return result;
    } });
    await expect(appendUpdate(broken, id, 0, update(), origin, new Date(), true)).rejects.toMatchObject({ publication_status: 'unknown' });
    expect(await appendUpdate(bindings.SITE_BUCKET, id, 0, update(), origin, new Date(), true)).toMatchObject({ status: 'duplicate', update_index: 0 });
    const stub = bindings.PUBLISHER.getByName('site');
    const response = await append(id, update('rpc'), '0', { PUBLISHER: { getByName: () => ({ appendUpdateV1: async (...args: Parameters<typeof stub.appendUpdateV1>) => { await stub.appendUpdateV1(...args); throw new Error('lost RPC'); } }) } as unknown as Env['PUBLISHER'] });
    expect(await response.json()).toMatchObject({ publication_status: 'unknown', retryable: true, suggestion: { action: 'retry_unchanged' } });
    expect(await (await append(id, update('rpc'))).json()).toMatchObject({ status: 'duplicate', update_index: 1 });
  });
  it('preserves updates during durable rebuilds and rejects damaged source data', async () => {
    const first = await submit(); await append(first.post!.id);
    const current = await snapshot();
    const publisher = bindings.PUBLISHER.getByName('site'); await publisher.enqueueRebuild(origin);
    await runDurableObjectAlarm(publisher);
    expect(await snapshot()).toMatchObject({ publication: current.publication, html: current.html, rss: current.rss });
    const ref = (await currentPublication(bindings.SITE_BUCKET)).posts[0];
    const post = await loadPost(bindings.SITE_BUCKET, ref);
    post.items[0].updates![0].received_at = 'invalid';
    await bindings.SITE_BUCKET.put(ref.key, JSON.stringify(post));
    expect((await request('/api/posts')).status).toBe(500);
    expect(await (await append(first.post!.id, update('second'))).json()).toMatchObject({ code: 'source_damaged', retryable: false });
  });
  it('reads v1 manifests, upgrades on append, and excludes raw sources after migration completes', async () => {
    const post: StoredPost = { ...digest(), id: 'legacy-2026-10-15', date: localDate(new Date()), received_at: now() };
    await seed([post], 1);
    expect((await request('/api/posts')).status).toBe(200);
    await append(post.id);
    const publisher = bindings.PUBLISHER.getByName('site');
    await publisher.enqueueRebuild(origin);
    await runDurableObjectAlarm(publisher);
    await bindings.SITE_BUCKET.put('digests/2026-01-01.json', JSON.stringify(digest('uncommitted')));
    await submit(digest('new'));
    await rebuildHomepage(bindings.SITE_BUCKET, origin);
    const result = await readPosts(bindings.SITE_BUCKET, new URLSearchParams('days=30'), secret);
    expect(result.posts).toHaveLength(2);
    expect(result.posts.find(value => value.post_id === post.id)!.items[0].updates).toHaveLength(1);
  });
  it('ignores spoofed embedded updates and escapes appended Markdown and attribution', async () => {
    const input = { ...digest(), items: [{ ...digest().items[0], updates: [{ ...update('spoof'), received_at: now() }] }] };
    const first = await submit(input);
    expect((await readPosts(bindings.SITE_BUCKET, new URLSearchParams(), secret)).posts[0].items[0].updates).toEqual([]);
    await append(first.post!.id, { ...update(), group: '<script>group</script>', body: '<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))\n\n![Photo](https://example.com/photo.jpg)', received_at: '1900-01-01T00:00:00Z' });
    const { html, rss } = await snapshot();
    expect(html).not.toContain('<script>group</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('&lt;script&gt;group&lt;/script&gt;');
    expect(html).toContain('href="https://example.com/followup"');
    expect(rss).not.toContain('<script>alert(1)</script>');
    const item = (await readPosts(bindings.SITE_BUCKET, new URLSearchParams(), secret)).posts[0].items[0];
    expect(item.updates[0].received_at).not.toContain('1900');
  });
});

describe('retention and source activity', () => {
  it('extends history only for real additions and expires targets after 30 LA dates', async () => {
    const start = new Date('2026-10-01T20:00:00Z');
    const first = await publishDigest(bindings.SITE_BUCKET, digest('Old', start.toISOString()), origin, start, true);
    const at = new Date('2026-10-30T20:00:00Z');
    await appendUpdate(bindings.SITE_BUCKET, first.post!.id, 0, update('fresh', at.toISOString()), origin, at, true);
    const before = await snapshot();
    const last = new Date('2026-11-28T20:00:00Z');
    expect(await appendUpdate(bindings.SITE_BUCKET, first.post!.id, 0, update('fresh', at.toISOString()), origin, last, true)).toMatchObject({ status: 'duplicate' });
    expect((await publishDigest(bindings.SITE_BUCKET, digest('Old'), origin, last, true)).duplicate).toBe(true);
    expect(await snapshot()).toEqual(before);
    const expired = new Date('2026-11-29T20:00:00Z');
    await expect(appendUpdate(bindings.SITE_BUCKET, first.post!.id, 0, update('newer'), origin, expired, true)).rejects.toMatchObject({ cause: { code: 'story_not_found' } });
    expect((await publishDigest(bindings.SITE_BUCKET, digest('Old'), origin, expired, true)).duplicate).toBe(false);
  });
  it('revives old cards, orders by eligible activity, and retains RSS identities and dates', async () => {
    const at = new Date('2026-10-20T20:00:00Z');
    const first = await publishDigest(bindings.SITE_BUCKET, digest('Old', '2026-10-01T20:00:00Z'), origin, new Date('2026-10-01T20:00:00Z'), true);
    await publishDigest(bindings.SITE_BUCKET, digest('New', '2026-10-19T20:00:00Z'), origin, new Date('2026-10-19T20:00:00Z'), true);
    await appendUpdate(bindings.SITE_BUCKET, first.post!.id, 0, update('activity', at.toISOString()), origin, at, true);
    await appendUpdate(bindings.SITE_BUCKET, first.post!.id, 0, update('future', '2026-10-25T20:00:00Z'), origin, at, true);
    const publication = await currentPublication(bindings.SITE_BUCKET);
    const posts = await Promise.all(publication.posts.map(ref => loadPost(bindings.SITE_BUCKET, ref)));
    const items = selectFeedItems(posts, publication);
    expect(items.map(value => value.item.headline)).toEqual(['Old', 'New']);
    expect(items[0].date).toBe('2026-10-20');
    const rss = renderRss(posts, { origin, publication });
    expect(rss).toContain('<pubDate>Thu, 01 Oct 2026 20:00:00 GMT</pubDate>');
    const original = posts.find(post => post.id === first.post!.id)!;
    expect(rss.match(/<guid[^>]*>[^<]+/g)![0]).toBe(renderRss([original], { origin }).match(/<guid[^>]*>[^<]+/g)![0]);
    const html = renderPage(posts, { origin, publication });
    expect(html.indexOf('>Old</a>')).toBeLessThan(html.indexOf('>New</a>'));
    expect(html).toContain('datetime="2026-10-01T20:00:00Z"');
    expect(html).toContain('story-updated">Updated <time class="post-time" datetime="2026-10-25T20:00:00Z"');
    expect(recentDates(new Date('2026-11-02T08:00:00Z'), 30)).toHaveLength(30);
  });
});
