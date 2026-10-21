import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { currentPublication, initialMigration, migrateBatch, postKey, publishDigest, rebuildHomepage } from '../src/publishing';
import { escapeHtml, recentDates, renderPage } from '../src/render';
import { readLimited, validateDigest } from '../src/validation';
import { IMAGE_LIMIT, withImageUploadSlot } from '../src/images';
import type { ContentBucket, Digest, DigestItem, Env, RebuildJob, StoredPost } from '../src/types';

const bindings = env as unknown as Env;
const secret = 'test-secret-at-least-thirty-two-characters-long';
const base = 'https://lakearrowhead.town';
const auth = { Authorization: `Bearer ${secret}` };
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), char => char.charCodeAt(0));
const publisher = () => bindings.PUBLISHER.getByName('site');
function digest(headline = 'Wind update', posted_at = new Date().toISOString()): Digest {
  return { title: 'Morning Facebook digest — Thu Oct 15', source: 'facebook-groups', items: [{
    group: 'Lake Arrowhead 360 Group', group_url: 'https://facebook.com/groups/2241141482782874/',
    headline, body: '**Strong winds** are expected.\n\n- Secure outdoor furniture.\n- Check for updates.',
    post_url: `https://facebook.com/groups/2241141482782874/permalink/${encodeURIComponent(headline)}/`, category: 'alert', posted_at,
  }] };
}
function fetch(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}, origin = base) {
  return worker.fetch(new Request(origin + path, init), { ...bindings, ...overrides });
}
function post(input: unknown, authorization = auth.Authorization) {
  return fetch('/api/digests', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify(input) });
}
function upload(bytes: Uint8Array = png, type = 'image/png', overrides: Partial<Env> = {}, origin = base) {
  const form = new FormData();
  form.append('file', new File([bytes], 'photo', { type }));
  return fetch('/api/images', { method: 'POST', headers: auth, body: form }, overrides, origin);
}
function bucketWith(overrides: Partial<ContentBucket>): ContentBucket {
  return { get: key => bindings.SITE_BUCKET.get(key), head: key => bindings.SITE_BUCKET.head(key), put: (key, value, options) => bindings.SITE_BUCKET.put(key, value, options), list: options => bindings.SITE_BUCKET.list(options), ...overrides };
}
async function queueRebuild() {
  const response = await fetch('/api/rebuild', { method: 'POST', headers: auth });
  expect(response.status).toBe(202);
  return (await response.json<{ job: RebuildJob }>()).job;
}
async function jobStatus(id: string) {
  const response = await fetch(`/api/rebuild/${id}`, { headers: auth });
  expect(response.status).toBe(200);
  return (await response.json<{ job: RebuildJob }>()).job;
}
async function legacy(date = '2024-01-01', title = 'Legacy digest') {
  return bindings.SITE_BUCKET.put(`digests/${date}.json`, JSON.stringify({ date, ...digest(title) }));
}

beforeEach(async () => { vi.restoreAllMocks(); vi.spyOn(console, 'info').mockImplementation(() => {}); await reset(); });

describe('append-only publication', () => {
  it('serves a canonical empty homepage and revalidates its cached ETag', async () => {
    const response = await fetch('/');
    const tag = response.headers.get('etag')!;
    const html = await response.text();
    expect(html).toContain('No posts from the past week.');
    expect(html).toContain('<link rel="canonical" href="https://lakearrowhead.town/">');
    expect((await fetch('/', { headers: { 'If-None-Match': tag } })).status).toBe(304);
    expect((await fetch('/', { method: 'HEAD' })).status).toBe(200);
  });
  it.each(['', 'Bearer wrong', `Basic ${secret}`, `Bearer ${secret} extra`])('rejects invalid auth without writes: %s', async authorization => {
    expect((await post(digest(), authorization)).status).toBe(401);
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });
  it.each([`bearer ${secret}`, `BEARER   ${secret}`])('accepts standard Bearer variations', async authorization => {
    expect((await post(digest(), authorization)).status).toBe(200);
  });
  it('fails closed for missing secrets and malformed origins before writes', async () => {
    for (const API_SECRET of [undefined, 'short']) expect((await fetch('/api/images', { method: 'POST' }, { API_SECRET })).status).toBe(503);
    for (const SITE_ORIGIN of ['not a URL', 'ftp://host', 'https://host/path', 'https://a:b@host', 'https://host/?q=x', 'https://host/#x']) {
      expect((await upload(png, 'image/png', { SITE_ORIGIN })).status).toBe(503);
    }
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });
  it('suppresses duplicate requests and appends distinct follow-up stories', async () => {
    const duplicate = digest();
    for (const [index, input] of [duplicate, duplicate, digest('Correction')].entries()) {
      const response = await post(input);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, url: '/', duplicate: index === 1 });
    }
    expect((await post({ ...digest('Empty batch'), items: [] })).status).toBe(400);
    const html = await (await fetch('/')).text();
    expect(html.match(/<section class="digest"/g)).toHaveLength(1);
    expect(html.match(/<article class="digest-item"/g)).toHaveLength(2);
    expect(html.match(/>Wind update<\/a><\/h3>/g)).toHaveLength(1);
    expect(html).not.toContain(duplicate.title);
    expect(html).toContain('Correction');
    expect(html).not.toContain('Empty batch');
    expect(html).toContain('Last published');
    expect((await bindings.SITE_BUCKET.list({ prefix: 'posts/' })).objects).toHaveLength(2);
  });
  it('ignores all client identity/date fields and preserves source timestamps', async () => {
    const input = digest();
    await post({ ...input, date: 'not a date', id: 'spoof', received_at: '1900-01-01' });
    const publication = await currentPublication(bindings.SITE_BUCKET);
    const source = await bindings.SITE_BUCKET.get(publication.posts[0].key);
    const stored = await source!.json<StoredPost>();
    expect(stored.id).not.toBe('spoof');
    expect(stored.date).toBe(recentDates(new Date())[0]);
    expect(Math.abs(Date.now() - Date.parse(stored.received_at))).toBeLessThan(10000);
    expect(stored.title).toBe(input.title);
    expect(stored.items[0].posted_at).toBe(input.items[0].posted_at);
  });
  it.each([
    { title: '' }, { source: 3 }, { items: {} }, { items: [null] },
    { items: [{ ...digest().items[0], posted_at: '2026-10-16T07:12:00' }] },
    { items: [{ ...digest().items[0], posted_at: '2026-02-30T07:12:00Z' }] },
    { items: [{ ...digest().items[0], posted_at: '2026-10-16T25:12:00Z' }] },
    { items: [{ ...digest().items[0], group_url: 'javascript:alert(1)' }] },
    { items: [{ ...digest().items[0], post_url: 'relative/path' }] },
  ])('rejects invalid payloads without writes: %j', async patch => {
    expect((await post({ ...digest(), ...patch })).status).toBe(400);
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });
  it('rejects bad JSON, unsupported content types and oversized JSON', async () => {
    const headers = { ...auth, 'Content-Type': 'application/json' };
    expect((await fetch('/api/digests', { method: 'POST', headers, body: '{' })).status).toBe(400);
    expect((await fetch('/api/digests', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await post({ ...digest(), title: 'x'.repeat(1024 * 1024) })).status).toBe(413);
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });
  it('bounds streamed bodies without trusting Content-Length', async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); controller.close(); } });
    await expect(readLimited(new Request(base, { method: 'POST', body: stream }), 10)).rejects.toMatchObject({ status: 413 });
  });
  it('keeps arbitrary categories and submitted item order for equal timestamps', async () => {
    const input = digest(); input.items[0].category = 'road & weather';
    input.items.push({ ...input.items[0], headline: 'Second item', category: '', post_url: 'https://example.com/second' });
    await post(input);
    const html = await (await fetch('/')).text();
    expect(html).toContain('road &amp; weather');
    expect(html.indexOf('Wind update')).toBeLessThan(html.indexOf('Second item'));
  });
  it('serializes simultaneous appends and preserves every post', async () => {
    const responses = await Promise.all(['One', 'Two', 'Three'].map(title => post(digest(title))));
    expect(responses.map(value => value.status)).toEqual([200, 200, 200]);
    const html = await (await fetch('/')).text();
    for (const title of ['One', 'Two', 'Three']) expect(html).toContain(title);
    expect(html.match(/<article class="digest-item"/g)).toHaveLength(3);
  });
  it('keeps the previous index/manifest on failed publication and does not include orphan sources on rebuild', async () => {
    await publishDigest(bindings.SITE_BUCKET, digest('Good post'), base);
    const before = await currentPublication(bindings.SITE_BUCKET);
    const original = await (await fetch('/')).text();
    const broken = bucketWith({ put: async (key, value, options) => { if (key === 'pages/index.html') throw new Error('injected failure'); return bindings.SITE_BUCKET.put(key, value, options); } });
    await expect(publishDigest(broken, digest('Uncommitted'), base)).rejects.toMatchObject({ publication_status: 'unknown', stage: 'index_write' });
    expect(await currentPublication(bindings.SITE_BUCKET)).toEqual(before);
    expect(await (await fetch('/')).text()).toBe(original);
    await rebuildHomepage(bindings.SITE_BUCKET, base);
    expect(await (await fetch('/')).text()).not.toContain('Uncommitted');
  });
  it('returns an honest failure message without promising safe retries', async () => {
    const PUBLISHER = { getByName: () => ({ publishV2: () => { throw new Error('private storage detail'); } }) } as unknown as Env['PUBLISHER'];
    const response = await fetch('/api/digests', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(digest()) }, { PUBLISHER });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/retry safely|private storage detail/);
  });
});

describe('damaged source omission and recovery', () => {
  it.each(['missing', 'invalid_json', 'invalid_digest'] as const)('omits %s sources, freezes rebuilds, and recovers on new publication', async reason => {
    const now = new Date('2026-10-16T20:00:00Z');
    const damaged = await publishDigest(bindings.SITE_BUCKET, digest('Damaged historical post', now.toISOString()), base, now, true);
    await publishDigest(bindings.SITE_BUCKET, digest('Healthy historical post', now.toISOString()), base, now, true);
    const key = postKey(damaged.post!);
    const original = await (await bindings.SITE_BUCKET.get(key))!.text();
    const ref = (await currentPublication(bindings.SITE_BUCKET)).posts.find(post => post.id === damaged.post!.id)!;
    if (reason === 'missing') await bindings.SITE_BUCKET.delete(key);
    else await bindings.SITE_BUCKET.put(key, reason === 'invalid_json' ? 'broken private payload' : JSON.stringify({ title: 'private invalid digest' }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await publishDigest(bindings.SITE_BUCKET, digest('New post', now.toISOString()), base, now, true);
    const snapshot = await currentPublication(bindings.SITE_BUCKET);
    expect(snapshot.omitted_posts).toEqual([ref]);
    expect(snapshot.posts).toHaveLength(2);
    const html = await (await fetch('/')).text();
    expect(html).toContain('Healthy historical post'); expect(html).toContain('New post'); expect(html).not.toContain('Damaged historical post');
    expect(warning).toHaveBeenCalledExactlyOnceWith('Omitted damaged post', { id: damaged.post!.id, key, reason });
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(/broken private payload|private invalid digest/);
    const noOmittedReads = bucketWith({ get: async sourceKey => {
      if (sourceKey === key) throw new Error('A rebuild must not read an omitted source');
      return bindings.SITE_BUCKET.get(sourceKey);
    } });
    await rebuildHomepage(noOmittedReads, base);
    expect(await currentPublication(bindings.SITE_BUCKET)).toEqual(snapshot);
    expect(await (await fetch('/')).text()).toBe(html);
    await bindings.SITE_BUCKET.put(key, original);
    await rebuildHomepage(bindings.SITE_BUCKET, base);
    expect(await currentPublication(bindings.SITE_BUCKET)).toEqual(snapshot);
    expect(await (await fetch('/')).text()).toBe(html);
    await publishDigest(bindings.SITE_BUCKET, digest('Publication after repair', now.toISOString()), base, now, true);
    const recovered = await currentPublication(bindings.SITE_BUCKET);
    expect(recovered.posts).toHaveLength(4); expect(recovered.omitted_posts).toBeUndefined();
    expect(await (await fetch('/')).text()).toContain('Damaged historical post');
  });
  it('expires omitted references by their original receipt date even after source repair', async () => {
    const damaged = await publishDigest(bindings.SITE_BUCKET, digest('Expired omitted post', '2026-10-09T20:00:00Z'), base, new Date('2026-10-09T20:00:00Z'), true);
    const key = postKey(damaged.post!);
    const original = await (await bindings.SITE_BUCKET.get(key))!.text();
    await bindings.SITE_BUCKET.delete(key);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await publishDigest(bindings.SITE_BUCKET, digest('Day 10', '2026-10-10T20:00:00Z'), base, new Date('2026-10-10T20:00:00Z'), true);
    expect((await currentPublication(bindings.SITE_BUCKET)).omitted_posts).toHaveLength(1);
    await bindings.SITE_BUCKET.put(key, original);
    await publishDigest(bindings.SITE_BUCKET, digest('Day 39', '2026-11-08T20:00:00Z'), base, new Date('2026-11-08T20:00:00Z'), true);
    const snapshot = await currentPublication(bindings.SITE_BUCKET);
    expect(snapshot.omitted_posts).toBeUndefined(); expect(snapshot.posts).toHaveLength(2);
    expect(await (await fetch('/')).text()).not.toContain('Expired omitted post');
  });
  it.each(['get', 'body'] as const)('fails publication and preserves the committed index on %s transport failures', async stage => {
    const damaged = await publishDigest(bindings.SITE_BUCKET, digest('Existing post'), base);
    const snapshot = await currentPublication(bindings.SITE_BUCKET);
    expect(snapshot.omitted_posts).toBeUndefined(); // Older manifests need no migration.
    const html = await (await fetch('/')).text();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = bucketWith({ get: async key => {
      if (key !== postKey(damaged.post!)) return bindings.SITE_BUCKET.get(key);
      if (stage === 'get') throw new Error('R2 unavailable');
      return { text: async () => { throw new SyntaxError('Body transport failed'); } } as unknown as R2ObjectBody;
    } });
    await expect(publishDigest(broken, digest('Uncommitted'), base, new Date(), true)).rejects.toMatchObject({ publication_status: 'not_committed', stage: 'source_loading' });
    expect(await currentPublication(bindings.SITE_BUCKET)).toEqual(snapshot);
    expect(await (await fetch('/')).text()).toBe(html); expect(warning).not.toHaveBeenCalled();
  });
  it('prefers the committed imported reference over a duplicate damaged legacy backup', async () => {
    await legacy('2024-01-01', 'Imported historical post');
    await migrateBatch(bindings.SITE_BUCKET, initialMigration());
    await rebuildHomepage(bindings.SITE_BUCKET, base);
    const ref = (await currentPublication(bindings.SITE_BUCKET)).posts[0];
    expect(ref.key).toBe(postKey(ref));
    await bindings.SITE_BUCKET.put('digests/2024-01-01.json', 'broken backup');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await publishDigest(bindings.SITE_BUCKET, digest('During migration'), base);
    const snapshot = await currentPublication(bindings.SITE_BUCKET);
    expect(snapshot.posts.filter(post => post.id === ref.id)).toEqual([ref]);
    expect(snapshot.omitted_posts).toBeUndefined(); expect(warning).not.toHaveBeenCalled();
    expect(await (await fetch('/')).text()).toContain('Imported historical post');
  });
  it('lets a paused rebuild resume against a later publication that omitted its damaged source', async () => {
    await post(digest('Damaged before rebuild'));
    const original = await currentPublication(bindings.SITE_BUCKET);
    await bindings.SITE_BUCKET.delete(original.posts[0].key);
    const job = await queueRebuild(); await runDurableObjectAlarm(publisher());
    expect((await jobStatus(job.id)).status).toBe('failed');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await post(digest('New publication while rebuild paused'));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, url: '/' });
    const snapshot = await currentPublication(bindings.SITE_BUCKET);
    expect(snapshot.omitted_posts).toEqual(original.posts);
    const html = await (await fetch('/')).text();
    expect((await fetch(`/api/rebuild/${job.id}/resume`, { method: 'POST', headers: auth })).status).toBe(202);
    await runDurableObjectAlarm(publisher());
    expect((await jobStatus(job.id)).status).toBe('completed');
    expect(await currentPublication(bindings.SITE_BUCKET)).toEqual(snapshot);
    expect(await (await fetch('/')).text()).toBe(html);
  });
});

describe('request failure context', () => {
  it('reserves the publication uncertainty warning for an attempted publisher call', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = () => { throw new Error('private storage detail'); };
    const PUBLISHER = { getByName: () => ({ publishV2: failed, enqueueRebuild: failed, jobStatus: failed, resumeRebuild: failed }) } as unknown as Env['PUBLISHER'];
    const SITE_BUCKET = { get: failed, head: failed, put: failed } as unknown as R2Bucket;
    const id = '00000000-0000-0000-0000-000000000000';
    const responses = [
      await fetch('/', {}, { SITE_BUCKET }), await fetch('/', { method: 'HEAD' }, { SITE_BUCKET }),
      await fetch(`/images/${'a'.repeat(64)}.png`, {}, { SITE_BUCKET }), await upload(png, 'image/png', { SITE_BUCKET }),
      await fetch('/api/rebuild', { method: 'POST', headers: auth }, { PUBLISHER }),
      await fetch(`/api/rebuild/${id}`, { headers: auth }, { PUBLISHER }),
      await fetch(`/api/rebuild/${id}/resume`, { method: 'POST', headers: auth }, { PUBLISHER }),
      await fetch('/api/digests', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(digest()) }, { PUBLISHER: { getByName: failed } as unknown as Env['PUBLISHER'] }),
    ];
    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(index < 4 ? 500 : 503);
      expect(await response.text()).not.toMatch(/may have completed|homepage before posting|private storage detail/);
    }
    const response = await fetch('/api/digests', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(digest()) }, { PUBLISHER });
    expect(response.status).toBe(503); expect(await response.text()).toContain('may have completed');
  });
});

describe('conditional header parsing', () => {
  it.each(['fallback', 'stored', 'image'] as const)('handles valid and malformed conditions consistently for %s GET/HEAD', async kind => {
    let path = '/';
    if (kind === 'stored') await post(digest());
    if (kind === 'image') path = new URL((await (await upload()).json<{ url: string }>()).url).pathname;
    const initial = await fetch(path); const etag = initial.headers.get('etag')!; await initial.arrayBuffer();
    const strong = etag.replace(/^W\//, '');
    const get = vi.fn((key: string, options?: R2GetOptions) => bindings.SITE_BUCKET.get(key, options));
    const head = vi.fn((key: string) => bindings.SITE_BUCKET.head(key));
    const SITE_BUCKET = { get, head } as unknown as R2Bucket;
    for (const condition of [strong, `W/${strong}`, `"old,tag", ${etag}`, `W/${strong} , "old"`, `, , ${etag}, ,`, '*']) {
      const response = await fetch(path, { headers: { 'If-None-Match': condition } }, { SITE_BUCKET });
      expect(response.status, condition).toBe(304); expect(await response.text()).toBe('');
      const object = await get.mock.results.at(-1)!.value;
      expect(object && 'body' in object).toBe(kind === 'fallback' ? null : false);
      const reads = get.mock.calls.length;
      const responseHead = await fetch(path, { method: 'HEAD', headers: { 'If-None-Match': condition } }, { SITE_BUCKET });
      expect(responseHead.status).toBe(304); expect(await responseHead.text()).toBe(''); expect(get.mock.calls.length).toBe(reads);
    }
    for (const condition of ['unquoted', '"unterminated', `"x", garbage, ${etag}`, `*, ${etag}`, `w/${strong}`, `${etag} ${etag}`, '"bad\u007f"']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(path, { method, headers: { 'If-None-Match': condition } }, { SITE_BUCKET });
        expect(response.status, condition).toBe(200);
        if (method === 'GET') expect(get.mock.calls.at(-1)![1]).toBeUndefined();
        expect((await response.arrayBuffer()).byteLength > 0).toBe(method === 'GET');
      }
    }
    for (const condition of ['"unrelated"', '""', '"old,tag"']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(path, { method, headers: { 'If-None-Match': condition } }, { SITE_BUCKET });
        expect(response.status).toBe(200); await response.arrayBuffer();
      }
    }
  });
});

describe('server dates, snapshots and rendering', () => {
  const source = (id: string, items: DigestItem[]): StoredPost => ({ ...digest(), id, date: '2026-10-16', received_at: '2026-10-16T20:00:00Z', items });
  const snapshotPage = (posts: StoredPost[], date = '2026-10-16') => renderPage(posts, { origin: base, publication: {
    version: 1, posts: [], snapshot_date: date, published_at: `${date}T21:57:00Z`,
  } });
  it.each([
    ['2026-10-16T06:59:59Z', '2026-10-15', '2026-10-09'], ['2026-10-16T07:00:00Z', '2026-10-16', '2026-10-10'],
    ['2026-03-09T07:00:00Z', '2026-03-09', '2026-03-03'], ['2026-11-02T08:00:00Z', '2026-11-02', '2026-10-27'],
    ['2024-03-01T08:00:00Z', '2024-03-01', '2024-02-24'], ['2027-01-01T08:00:00Z', '2027-01-01', '2026-12-26'],
  ])('assigns the server day at %s', async (now, first, last) => {
    expect(recentDates(new Date(now))).toHaveLength(7);
    expect(recentDates(new Date(now))).toEqual(expect.arrayContaining([first, last]));
    const post = await publishDigest(bindings.SITE_BUCKET, digest(), base, new Date(now));
    expect(post.post!.date).toBe(first);
  });
  it('keeps seven calendar dates, expires old posts only on publish, and rebuilds the exact snapshot', async () => {
    for (const day of ['09', '10', '16']) await publishDigest(bindings.SITE_BUCKET, digest(`Day ${day}`, `2026-10-${day}T20:00:00Z`), base, new Date(`2026-10-${day}T20:00:00Z`));
    const snapshot = await currentPublication(bindings.SITE_BUCKET);
    const html = await (await fetch('/')).text();
    expect(html).not.toContain('Day 09'); expect(html).toContain('Day 10'); expect(html).toContain('Day 16');
    await rebuildHomepage(bindings.SITE_BUCKET, base);
    expect(await currentPublication(bindings.SITE_BUCKET)).toEqual(snapshot);
    expect(await (await fetch('/')).text()).toBe(html);
    await publishDigest(bindings.SITE_BUCKET, digest('Next week', '2026-10-24T20:00:00Z'), base, new Date('2026-10-24T20:00:00Z'));
    expect(await (await fetch('/')).text()).not.toContain('Day 16');
  });
  it('orders by original post time across receipt order and uses one heading per day', async () => {
    await publishDigest(bindings.SITE_BUCKET, digest('Newer original post', '2026-10-16T18:30:00Z'), base, new Date('2026-10-16T19:00:00Z'));
    await publishDigest(bindings.SITE_BUCKET, digest('Older original post', '2026-10-16T17:00:00Z'), base, new Date('2026-10-16T20:00:00Z'));
    const html = await (await fetch('/')).text();
    expect(html.indexOf('Newer original post')).toBeLessThan(html.indexOf('Older original post'));
    expect(html.match(/id="day-2026-10-16"/g)).toHaveLength(1);
    expect(html.match(/<article class="digest-item"/g)).toHaveLength(2);
    expect(new Set((await currentPublication(bindings.SITE_BUCKET)).posts.map(post => post.id)).size).toBe(2);
    expect(html).not.toContain('href="/digests/');
  });
  it('merges mixed-day batches into newest-first daily sections without mutating sources', () => {
    const first = source('one', [
      digest('Yesterday morning', '2026-10-15T09:00:00-07:00').items[0],
      digest('Today morning', '2026-10-16T09:00:00-07:00').items[0],
    ]);
    const second = source('two', [
      digest('Today afternoon', '2026-10-16T13:00:00-07:00').items[0],
      digest('Yesterday evening', '2026-10-15T19:00:00-07:00').items[0],
    ]);
    const before = JSON.stringify([first, second]);
    const html = snapshotPage([first, second]);
    expect([...html.matchAll(/<h3><a\b[^>]*>([^<]*)<\/a><\/h3>/g)].map(match => match[1])).toEqual([
      'Today afternoon', 'Today morning', 'Yesterday evening', 'Yesterday morning',
    ]);
    expect([...html.matchAll(/<h2 id="([^"]+)"/g)].map(match => match[1])).toEqual(['day-2026-10-16', 'day-2026-10-15']);
    expect(html).toContain('<time datetime="2026-10-16">Friday, October 16, 2026</time>');
    expect(html).not.toContain(first.title);
    expect(html).not.toContain('received-at');
    expect(JSON.stringify([first, second])).toBe(before);
  });
  it('sorts equivalent timezone offsets stably, retaining every duplicate', () => {
    const equal = digest('First equal post', '2026-10-16T10:00:00-07:00').items[0];
    const html = snapshotPage([
      source('one', [equal, { ...equal, headline: 'Second equal post', posted_at: '2026-10-16T17:00:00Z' }]),
      source('two', [{ ...equal, headline: 'Third equal post', posted_at: '2026-10-16T19:00:00+02:00' }, equal]),
    ]);
    expect([...html.matchAll(/<h3><a\b[^>]*>([^<]*)<\/a><\/h3>/g)].map(match => match[1])).toEqual([
      'First equal post', 'Second equal post', 'Third equal post', 'First equal post',
    ]);
  });
  it('filters the inclusive seven-day post window even inside a recently received batch', () => {
    const html = snapshotPage([source('one', [
      digest('Expired item', '2026-10-10T06:59:59Z').items[0],
      digest('First eligible item', '2026-10-10T07:00:00Z').items[0],
      digest('Last eligible item', '2026-10-17T06:59:59Z').items[0],
      digest('Future item', '2026-10-17T07:00:00Z').items[0],
    ])]);
    expect(html).not.toMatch(/Expired item|Future item/);
    expect(html).toContain('First eligible item');
    expect(html).toContain('Last eligible item');
    expect(html.match(/<section class="digest"/g)).toHaveLength(2);
  });
  it.each([
    ['2026-10-16T06:59:59Z', '2026-10-15'], ['2026-10-16T07:00:00Z', '2026-10-16'],
    ['2026-03-08T07:59:59Z', '2026-03-07'], ['2026-03-08T08:00:00Z', '2026-03-08'],
    ['2026-11-01T06:59:59Z', '2026-10-31'], ['2026-11-01T07:00:00Z', '2026-11-01'],
  ])('groups %s under the Los Angeles day %s', (timestamp, day) => {
    const html = snapshotPage([source('one', digest('Boundary post', timestamp).items)], day);
    expect(html).toContain(`<h2 id="day-${day}">`);
    expect(html.match(/<section class="digest"/g)).toHaveLength(1);
  });
  it.each([
    ['2026-03-08T09:59:59Z', '2026-03-08T10:00:00Z', '2026-03-08', 'PST', 'PDT'],
    ['2026-11-01T08:30:00Z', '2026-11-01T09:30:00Z', '2026-11-01', 'PDT', 'PST'],
  ])('orders across the DST change from %s to %s within one day', (earlier, later, day, firstZone, lastZone) => {
    const html = snapshotPage([source('one', [digest('Earlier instant', earlier).items[0], digest('Later instant', later).items[0]])], day);
    expect(html.indexOf('Later instant')).toBeLessThan(html.indexOf('Earlier instant'));
    expect(html.match(/<section class="digest"/g)).toHaveLength(1);
    expect(html).toContain(firstZone); expect(html).toContain(lastZone);
  });
  it('shows one empty state for empty batches and batches with no qualifying items', () => {
    const html = snapshotPage([source('empty', []), source('expired', digest('Old news', '2026-10-09T12:00:00-07:00').items)]);
    expect(html.match(/<p class="empty-state">/g)).toHaveLength(1);
    expect(html).not.toContain('<section class="digest"');
    expect(html).not.toContain('Old news');
    expect(html).toContain('Last published');
  });
  it('keeps the site name and footer dates while styling the masthead and including the theme picker', () => {
    const html = snapshotPage([]);
    expect(html).toContain('<title>Lake Arrowhead News, Alerts &amp; Events | Lake Arrowhead . Town</title>');
    expect(html).toContain('<meta property="og:title" content="Lake Arrowhead . Town — Community news &amp; local updates">');
    expect(html).toContain('<a class="site-title" href="/" aria-label="Lake Arrowhead . Town">Lake Arrowhead <span class="site-title-tail"><span class="site-dot" aria-hidden="true">.</span> Town</span></a>');
    const header = html.match(/<header>([\s\S]*?)<\/header>/)![1];
    expect(header).toContain('class="theme-picker"');
    expect(header).toContain('value="night-sky"');
    const footer = html.match(/<footer>([\s\S]*?)<\/footer>/)![1];
    expect(footer).toContain('Posts from Saturday, October 10, 2026 through Friday, October 16, 2026.');
    expect(footer).toContain('<time datetime="2026-10-16T21:57:00Z">Oct 16, 2:57 PM PDT</time>');
    expect(footer.indexOf('Posts from')).toBeGreaterThan(footer.indexOf('Community news from around the mountain.'));
    expect(html.match(/<main>([\s\S]*?)<\/main>/)![1]).not.toContain('snapshot-meta');
    expect(html).not.toContain('Received ');
  });
  it('keeps original post instants and absolute Los Angeles timestamps for no-JavaScript and accessible reading', () => {
    const timestamp = '2026-10-16T17:12:34.123Z';
    const html = snapshotPage([source('one', digest('Original post', timestamp).items)]);
    expect(html).toContain('class="item-group" href="https://facebook.com/groups/2241141482782874/"');
    expect(html).toContain(`<time class="post-time" datetime="${timestamp}" title="Friday, October 16, 2026 at 10:12:34 AM PDT">Oct 16, 10:12 AM PDT</time>`);
    expect(html).toContain('<time datetime="2026-10-16">Friday, October 16, 2026</time>');
  });
  it('escapes HTML and unsafe links while preserving Markdown images', () => {
    const input: StoredPost = { ...digest('<img src=x onerror=alert(1)> $&'), id: 'sample', date: '2026-10-16', received_at: '2026-10-16T20:00:00Z' };
    input.items[0].headline = '<script>alert(1)</script> $&';
    input.items[0].category = '\"><script>bad()</script>';
    input.items[0].body = '<script>evil()</script>\n\n[bad](javascript:alert(1))\n\n![photo](https://lakearrowhead.town/images/photo.png)';
    const html = renderPage([input], { origin: base });
    expect(html).not.toMatch(/<script>evil|<script>alert|href="javascript:|<img src=x/);
    expect(html).toContain('&lt;script&gt;'); expect(html).toContain('$&amp;');
    expect(html).toContain('<img src="https://lakearrowhead.town/images/photo.png" alt="photo" loading="eager" decoding="async">');
  });
  it('validates real source dates and offset timestamps', () => {
    const input = digest(); input.items[0].posted_at = '2024-03-01T00:00:00.123+14:00';
    expect(validateDigest(input)).toEqual(input);
    input.items[0].posted_at = '2023-02-29T00:00:00Z';
    expect(() => validateDigest(input)).toThrow();
  });
});

describe('linked article thumbnails', () => {
  const photo = 'https://lakearrowhead.town/images/photo.png';
  const other = 'https://example.com/another.png';
  const sourceUrl = 'https://facebook.com/posts/example?one=1&two=2';
  function article(body: string, headline = 'Mountain news') {
    const input: StoredPost = { ...digest(headline), id: 'images', date: '2026-10-16', received_at: '2026-10-16T20:00:00Z' };
    input.items[0].body = body;
    input.items[0].post_url = sourceUrl;
    const html = renderPage([input], { origin: base });
    return html.match(/<article class="digest-item">([\s\S]*?)<\/article>/)![1];
  }
  const bodyHtml = (html: string) => html.match(/<div class="markdown">([\s\S]*?)<\/div>/)![1];
  function expectSeparateLinks(html: string) {
    let depth = 0;
    for (const [tag] of html.matchAll(/<\/?a\b[^>]*>/g)) {
      depth += tag.startsWith('</') ? -1 : 1;
      expect(depth).toBeGreaterThanOrEqual(0);
      expect(depth).toBeLessThanOrEqual(1);
    }
    expect(depth).toBe(0);
  }
  it.each([
    `![Pine trees](${photo})\n\nBody **text** with a [weather link](https://example.com/weather).`,
    `Body **text** with a [weather link](https://example.com/weather).\n\n![Pine trees](${photo})`,
  ])('promotes the first image before the body regardless of source order: %s', body => {
    const html = article(body);
    const content = bodyHtml(html);
    expect(content).toMatch(/^<a class="article-image article-thumbnail"/);
    expect(content.indexOf('<img')).toBeLessThan(content.indexOf('Body'));
    expect(content.match(/<img\b/g)).toHaveLength(1);
    expect(content).toContain('alt="Pine trees"');
    expect(content).toContain('<strong>text</strong>');
    expect(content).toContain('<a href="https://example.com/weather">weather link</a>');
    expect(content).not.toMatch(/<p>\s*<\/p>|<a\b[^>]*>\s*<\/a>/);
    expectSeparateLinks(html);
  });
  it('preserves text, captions, image titles, and formatting around inline images', () => {
    const html = article(`Before **![A *pine* tree](${photo} "Mountain view")** after.\n\n*Caption text.*`);
    expect(html).toContain('alt="A pine tree"');
    expect(html).toContain('title="Mountain view"');
    expect(html).toContain('<p>Before  after.</p>');
    expect(html).toContain('<p><em>Caption text.</em></p>');
    expect(html).not.toContain('<strong></strong>');
  });
  it('links headlines and images to the original post and removes the standalone link', () => {
    const html = article(`Body.\n\n![Photo](${photo})`, 'Wind & weather');
    expect(html).toContain(`<h3><a class="headline-link" href="${escapeHtml(sourceUrl)}" rel="noopener noreferrer">Wind &amp; weather</a></h3>`);
    expect(html).toContain(`class="article-image article-thumbnail" href="${escapeHtml(sourceUrl)}"`);
    expect(html).not.toContain('aria-label="View original post:');
    expect(html).not.toContain('class="post-link"');
    expect(html).not.toContain('target=');
  });
  it('keeps image-free body links and formatting without adding a thumbnail', () => {
    const html = article('Read [the bulletin](https://example.com/bulletin).\n\n- First item\n- Second item');
    expect(html).toContain('class="headline-link"');
    expect(html).toContain('<a href="https://example.com/bulletin">the bulletin</a>');
    expect(html).toContain('<li>First item</li>');
    expect(html).not.toContain('article-thumbnail');
    expect(html).not.toContain('post-link');
  });
  it.each([
    `![Photo](${photo})`,
    `[![Photo](${photo})](https://example.com/image-page)`,
    `> **![Photo](${photo})**`,
    `- [![Photo](${photo})](https://example.com/image-page)`,
  ])('renders image-only bodies without empty containers: %s', body => {
    const content = bodyHtml(article(body));
    expect(content.match(/<img\b/g)).toHaveLength(1);
    expect(content).toMatch(/^<a class="article-image article-thumbnail"[^>]*><img[^>]*><\/a>$/);
    expectSeparateLinks(content);
  });
  it('preserves text links around a promoted image', () => {
    const html = article(`[Before **![Photo](${photo})** after](https://example.com/context).`);
    expect(html).toContain('<a href="https://example.com/context">Before  after</a>');
    expectSeparateLinks(html);
  });
  it('keeps additional images in place and splits their enclosing links without losing text', () => {
    const html = article(`![First](${photo})\n\nStart. [Before **![Second](${other})** after](https://example.com/context). End.`);
    const content = bodyHtml(html);
    expect(content.match(/<img\b/g)).toHaveLength(2);
    expect(content.match(/class="article-image article-thumbnail"/g)).toHaveLength(1);
    expect(content.indexOf('Start.')).toBeLessThan(content.indexOf(`src="${other}"`));
    expect(content.indexOf(`src="${other}"`)).toBeLessThan(content.indexOf('End.'));
    expect(content).toContain('<a href="https://example.com/context">Before </a>');
    expect(content).toContain('<a href="https://example.com/context"> after</a>');
    expect(content.match(new RegExp(`href="${escapeHtml(sourceUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g'))).toHaveLength(2);
    expect(content).not.toMatch(/<(?:strong|a|p)\b[^>]*>\s*<\/(?:strong|a|p)>/);
    expectSeparateLinks(html);
  });
  it('resolves reference images and leaves code samples untouched', () => {
    const html = article(`![Photo][picture]\n\n\`![Example](https://example.com/code.png)\`\n\n[picture]: ${photo} "Reference title"`);
    expect(html).toContain(`src="${photo}"`);
    expect(html).toContain('title="Reference title"');
    expect(html).toContain('<code>![Example](https://example.com/code.png)</code>');
    expect(html.match(/<img\b/g)).toHaveLength(1);
  });
  it('retains HTML escaping and blocks unsafe Markdown images and links', () => {
    const html = article(`<script>bad()</script>\n\n![Unsafe](javascript:alert(1))\n\n[unsafe](javascript:alert(1))\n\n![A & B](${photo} "A & B")`, 'News " & <script>bad()</script>');
    expect(html).not.toMatch(/<script>|(?:href|src)="javascript:|onerror=/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('alt="A &amp; B"');
    expect(html).toContain('title="A &amp; B"');
    expect(html).not.toContain('aria-label="View original post:');
    expectSeparateLinks(html);
  });
  it('preserves adjacent text and intentional caption breaks when extracting an image', () => {
    for (const body of [`word![Photo](${photo})word`, `[word![Photo](${photo})word](https://example.com/context)`, `**word![Photo](${photo})word**`]) {
      const html = article(body);
      expect(bodyHtml(html).replace(/<[^>]+>/g, '')).toContain('wordword');
      expectSeparateLinks(html);
    }
    const content = bodyHtml(article(`![Photo](${photo})  \nCaption line one.  \nCaption line two.`));
    expect(content).toContain('<p>Caption line one.<br>\nCaption line two.</p>');
    expect(content).not.toContain('<p><br>');
    expect(bodyHtml(article(`word![Photo](${photo}).`))).toContain('<p>word.</p>');
  });
  it('preserves authored empty list items and markers after moving list images', () => {
    const unrelated = bodyHtml(article(`![Photo](${photo})\n\n1. one\n2.\n3. three`));
    expect(unrelated.match(/<li>/g)).toHaveLength(3);
    expect(unrelated).toContain('<li></li>');
    const numbered = bodyHtml(article(`3. ![Photo](${photo})\n4. second\n5. third`));
    expect(numbered).toContain('<ol start="3">');
    expect(numbered.match(/<li>/g)).toHaveLength(3);
    expect(numbered).toMatch(/<li><\/li>\s*<li>second<\/li>\s*<li>third<\/li>/);
    const emptySibling = bodyHtml(article(`- ![Photo](${photo})\n-`));
    expect(emptySibling.match(/<li>/g)).toHaveLength(2);
    expect(bodyHtml(article(`- ![Photo](${photo})\n- second`))).toMatch(/<li><\/li>\s*<li>second<\/li>/);
  });
  it('preserves table columns and headers when their image is promoted', () => {
    const cell = bodyHtml(article(`| A | B |\n| --- | --- |\n| ![Photo](${photo}) | b |`));
    expect(cell).toContain('<th>A</th>\n<th>B</th>');
    expect(cell).toContain('<td></td>\n<td>b</td>');
    const heading = bodyHtml(article(`| ![Photo](${photo}) | B |\n| --- | --- |\n| a | b |`));
    expect(heading).toContain('<th></th>\n<th>B</th>');
    expect(heading).toContain('<td>a</td>\n<td>b</td>');
  });
  it('removes image-only links and formatting without inventing or changing spaces', () => {
    for (const image of [`[![Photo](${photo})](https://example.com/context)`, `[**![Photo](${photo})**](https://example.com/context)`, `[*![Photo](${photo})*](https://example.com/context)`]) {
      const content = bodyHtml(article(`word${image}word`));
      expect(content).toContain('<p>wordword</p>');
      expect(content).not.toContain('href="https://example.com/context"');
      expectSeparateLinks(content);
    }
    expect(bodyHtml(article(`word[ ![Photo](${photo}) ](https://example.com/context)word`))).toContain('<p>word  word</p>');
    expect(bodyHtml(article(`word  **![Photo](${photo})**  word`))).toContain('<p>word    word</p>');
  });
  it('preserves literal adjacency across scripts and composed or decomposed accents', () => {
    for (const [before, after] of [
      ['日本', '語'], ['中', '文'], ['ひら', 'がな'], ['カタ', 'カナ'], ['カー', 'word'],
      ['ภาษา', 'ไทย'], ['ພາສາ', 'ລາວ'], ['ភាសា', 'ខ្មែរ'], ['မ', 'မ'],
      ['日本', 'word'], ['word', '語'], ['café', 'noir'], ['cafe\u0301', 'noir'], ['part1', 'part2'],
    ]) {
      for (const image of [`![Photo](${photo})`, `[**![Photo](${photo})**](https://example.com/context)`]) {
        expect(bodyHtml(article(`${before}${image}${after}`))).toContain(`<p>${before}${after}</p>`);
      }
    }
  });
  it('leaves middle and trailing hard breaks unchanged after extraction', () => {
    expect(bodyHtml(article(`Before  \n![Photo](${photo})  \nAfter`))).toContain('<p>Before<br>\n<br>\nAfter</p>');
    expect(bodyHtml(article(`Before  \n![Photo](${photo})`))).toContain('<p>Before<br>\n</p>');
    expect(bodyHtml(article(`Hello [![Photo](${photo})  \n](https://example.com/context)world`))).toContain('<p>Hello <br>\nworld</p>');
  });
  it('uses image descriptions as link names and supplies a safe fallback for empty descriptions', () => {
    const described = article(`![A *pine* tree](${photo})\n\n![Another tree](${other})`);
    expect(described).toContain('alt="A pine tree"');
    expect(described).toContain('alt="Another tree"');
    expect(described).not.toContain('aria-label="View original post:');
    const unnamed = article(`![](${photo})`, 'News " & <script>bad()</script>');
    expect(unnamed).toContain('aria-label="View original post: News &quot; &amp; &lt;script&gt;bad()&lt;/script&gt;"');
    expectSeparateLinks(unnamed);
  });
  it('rebuilds image layouts without changing source Markdown or the publication snapshot', async () => {
    const input = digest(); input.items[0].body = `Body.\n\n![Photo](${photo})`;
    await post(input);
    const snapshot = await currentPublication(bindings.SITE_BUCKET);
    const stored = await (await bindings.SITE_BUCKET.get(snapshot.posts[0].key))!.text();
    const html = await (await fetch('/')).text();
    await rebuildHomepage(bindings.SITE_BUCKET, base);
    expect(await currentPublication(bindings.SITE_BUCKET)).toEqual(snapshot);
    expect(await (await bindings.SITE_BUCKET.get(snapshot.posts[0].key))!.text()).toBe(stored);
    expect(await (await fetch('/')).text()).toBe(html);
  });
});

describe('migration and durable rebuild jobs', () => {
  it('authenticates maintenance operations before accessing jobs', async () => {
    for (const path of ['/api/rebuild', '/api/rebuild/00000000-0000-0000-0000-000000000000', '/api/rebuild/00000000-0000-0000-0000-000000000000/resume']) {
      expect((await fetch(path, { method: path.includes('/resume') || path === '/api/rebuild' ? 'POST' : 'GET' })).status).toBe(401);
    }
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });
  it('queues durably, survives eviction and completes through an alarm', async () => {
    await post(digest());
    const snapshot = await currentPublication(bindings.SITE_BUCKET);
    const job = await queueRebuild();
    expect(job.status).toBe('queued');
    await evictDurableObject(publisher());
    expect(await runDurableObjectAlarm(publisher())).toBe(true);
    expect((await jobStatus(job.id)).status).toBe('completed');
    expect(await currentPublication(bindings.SITE_BUCKET)).toEqual(snapshot);
  });
  it('migrates in batches of 25, without duplicate imports or altering backup objects', async () => {
    for (let i = 1; i <= 26; i++) await legacy(`2024-01-${String(i).padStart(2, '0')}`, `Old ${i}`);
    const job = await queueRebuild();
    await runDurableObjectAlarm(publisher());
    expect((await jobStatus(job.id)).processed).toBe(25);
    expect((await jobStatus(job.id)).status).toBe('running');
    // A normal publication while migration is incomplete merges legacy/new references.
    await post(digest('During migration'));
    expect((await currentPublication(bindings.SITE_BUCKET)).posts).toHaveLength(27);
    await evictDurableObject(publisher());
    await runDurableObjectAlarm(publisher());
    expect((await jobStatus(job.id)).status).toBe('completed');
    expect((await bindings.SITE_BUCKET.list({ prefix: 'posts/' })).objects).toHaveLength(27);
    expect((await bindings.SITE_BUCKET.list({ prefix: 'digests/' })).objects).toHaveLength(26);
    const snapshot = await currentPublication(bindings.SITE_BUCKET);
    expect(snapshot.posts).toHaveLength(27);
    expect(snapshot.posts.every(ref => ref.key.startsWith('posts/'))).toBe(true);
    const before = await bindings.SITE_BUCKET.head(postKey(snapshot.posts.find(ref => ref.id.startsWith('legacy-'))!));
    await migrateBatch(bindings.SITE_BUCKET, initialMigration());
    const after = await bindings.SITE_BUCKET.head(before!.key);
    expect(after!.version).toBe(before!.version);
  });
  it('uses R2 receipt times, ignoring legacy client dates, and the original index time as snapshot anchor', async () => {
    const source = await legacy('2099-01-01');
    const index = await bindings.SITE_BUCKET.put('pages/index.html', 'original HTML');
    const job = await queueRebuild(); await runDurableObjectAlarm(publisher());
    expect((await jobStatus(job.id)).status).toBe('completed');
    const snapshot = await currentPublication(bindings.SITE_BUCKET);
    expect(snapshot.published_at).toBe(index!.uploaded.toISOString());
    expect(snapshot.posts[0].received_at).toBe(source!.uploaded.toISOString());
    expect(snapshot.posts[0].date).toBe(recentDates(source!.uploaded)[0]);
  });
  it('falls back to the latest legacy receipt time when no index exists', async () => {
    const source = await legacy();
    const job = await queueRebuild(); await runDurableObjectAlarm(publisher());
    expect((await currentPublication(bindings.SITE_BUCKET)).published_at).toBe(source!.uploaded.toISOString());
    expect((await jobStatus(job.id)).status).toBe('completed');
  });
  it('pauses on the first failure, retains old HTML, blocks later jobs, then resumes manually', async () => {
    await post(digest('Existing good page'));
    const before = await (await fetch('/')).text();
    await bindings.SITE_BUCKET.put('digests/2024-01-01.json', 'broken private payload');
    const job = await queueRebuild(); await runDurableObjectAlarm(publisher());
    const failed = await jobStatus(job.id);
    expect(failed.status).toBe('failed'); expect(failed.error).not.toContain('private payload');
    expect(await runDurableObjectAlarm(publisher())).toBe(false);
    expect(await (await fetch('/')).text()).toBe(before);
    const second = await queueRebuild(); expect((await jobStatus(second.id)).blocked_by).toBe(job.id);
    await legacy();
    expect((await fetch(`/api/rebuild/${job.id}/resume`, { method: 'POST', headers: auth })).status).toBe(202);
    await evictDurableObject(publisher()); await runDurableObjectAlarm(publisher());
    expect((await jobStatus(job.id)).status).toBe('completed');
    await runDurableObjectAlarm(publisher()); expect((await jobStatus(second.id)).status).toBe('completed');
    expect((await fetch(`/api/rebuild/${job.id}/resume`, { method: 'POST', headers: auth })).status).toBe(409);
  });
  it('retries a partially copied migration batch without duplicate imports', async () => {
    await legacy('2024-01-01'); await legacy('2024-01-02');
    let copied = 0;
    const broken = bucketWith({ put: async (key, value, options) => { if (++copied === 2) throw new Error('interrupted'); return bindings.SITE_BUCKET.put(key, value, options); } });
    await expect(migrateBatch(broken, initialMigration())).rejects.toMatchObject({ kind: 'storage', cause: { message: 'interrupted' } });
    expect((await bindings.SITE_BUCKET.list({ prefix: 'posts/' })).objects).toHaveLength(1);
    expect((await migrateBatch(bindings.SITE_BUCKET, initialMigration())).complete).toBe(true);
    expect((await bindings.SITE_BUCKET.list({ prefix: 'posts/' })).objects).toHaveLength(2);
  });
  it('pauses a rendering failure without replacing the index and resumes after repair', async () => {
    await post(digest('Published source'));
    const snapshot = await currentPublication(bindings.SITE_BUCKET);
    const key = snapshot.posts[0].key;
    const source = await (await bindings.SITE_BUCKET.get(key))!.text();
    const html = await (await fetch('/')).text();
    await bindings.SITE_BUCKET.delete(key);
    const job = await queueRebuild(); await runDurableObjectAlarm(publisher());
    expect((await jobStatus(job.id)).status).toBe('failed');
    expect((await jobStatus(job.id)).phase).toBe('render');
    expect(await runDurableObjectAlarm(publisher())).toBe(false);
    expect(await (await fetch('/')).text()).toBe(html);
    await bindings.SITE_BUCKET.put(key, source);
    await fetch(`/api/rebuild/${job.id}/resume`, { method: 'POST', headers: auth });
    await runDurableObjectAlarm(publisher());
    expect((await jobStatus(job.id)).status).toBe('completed');
    expect(await currentPublication(bindings.SITE_BUCKET)).toEqual(snapshot);
  });
  it('does not mark completed jobs as blocked by a later failure', async () => {
    const completed = await queueRebuild(); await runDurableObjectAlarm(publisher());
    await post(digest());
    const snapshot = await currentPublication(bindings.SITE_BUCKET);
    await bindings.SITE_BUCKET.delete(snapshot.posts[0].key);
    const failed = await queueRebuild(); await runDurableObjectAlarm(publisher());
    expect((await jobStatus(failed.id)).status).toBe('failed');
    expect((await jobStatus(completed.id)).blocked_by).toBeUndefined();
  });
  it('serializes rebuilds and new publication without losing content', async () => {
    await post(digest('First'));
    const job = await queueRebuild();
    await Promise.all([runDurableObjectAlarm(publisher()), post(digest('Second'))]);
    expect((await jobStatus(job.id)).status).toBe('completed');
    expect((await currentPublication(bindings.SITE_BUCKET)).posts).toHaveLength(2);
  });
  it('reports unknown jobs and enforces maintenance methods', async () => {
    expect((await fetch('/api/rebuild/00000000-0000-0000-0000-000000000000', { headers: auth })).status).toBe(404);
    expect((await fetch('/api/rebuild', { headers: auth })).status).toBe(405);
  });
});

describe('images and public serving', () => {
  it('uploads identical bytes to one immutable public URL and renders Markdown images', async () => {
    const first = await upload(); expect(first.status).toBe(200);
    const result = await first.json<{ url: string }>();
    expect(result.url).toMatch(/^https:\/\/lakearrowhead\.town\/images\/[a-f0-9]{64}\.png$/);
    expect(await (await upload()).json()).toMatchObject({ ok: true, url: result.url });
    expect((await bindings.SITE_BUCKET.list({ prefix: 'images/' })).objects).toHaveLength(1);
    const image = await fetch(new URL(result.url).pathname);
    expect(image.headers.get('Cache-Control')).toContain('immutable');
    expect(image.headers.get('Cloudflare-CDN-Cache-Control')).toContain('immutable');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
    const input = digest(); input.items[0].body = `![Photo](${result.url})`; await post(input);
    expect(await (await fetch('/')).text()).toContain(`<img src="${result.url}"`);
  });
  it.each([
    ['image/jpeg', [255, 216, 255, 224, 0, 2, 255, 192, 0, 17, 8, 0, 2, 0, 3, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0]],
    ['image/gif', [...new TextEncoder().encode('GIF89a'), 1, 0, 1, 0, 0, 0, 0]],
    ['image/webp', [...new TextEncoder().encode('RIFF'), 22, 0, 0, 0, ...new TextEncoder().encode('WEBPVP8X'), 10, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 1, 0, 0]],
  ])('accepts the supported %s header with readable dimensions', async (type, values) => { expect((await upload(new Uint8Array(values), type)).status).toBe(200); });
  it.each(['image/jpg', 'image/pjpeg', 'application/octet-stream', '', 'image/jpeg'])('retains strict matching for %s', async type => {
    expect((await upload(png, type)).status).toBe(415);
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });
  it('accepts a maximum-size file and rejects oversized files without writes', async () => {
    const max = new Uint8Array(IMAGE_LIMIT); max.set(png);
    expect((await upload(max)).status).toBe(200);
    const over = new Uint8Array(IMAGE_LIMIT + 1); over.set(png);
    expect((await upload(over)).status).toBe(413);
    expect((await bindings.SITE_BUCKET.list({ prefix: 'images/' })).objects).toHaveLength(1);
  });
  it('preserves 413 from a streamed oversized multipart envelope', async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(IMAGE_LIMIT)); controller.enqueue(new Uint8Array(65537)); controller.close(); } });
    const response = await fetch('/api/images', { method: 'POST', headers: { ...auth, 'Content-Type': 'multipart/form-data; boundary=bad' }, body });
    expect(response.status).toBe(413);
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });
  it('rejects malformed images and forms and authenticates before parsing', async () => {
    expect((await upload(new TextEncoder().encode('<svg/>'), 'image/svg+xml')).status).toBe(415);
    expect((await upload(new Uint8Array(0))).status).toBe(415);
    const form = new FormData(); form.append('file', 'not a file');
    expect((await fetch('/api/images', { method: 'POST', headers: auth, body: form })).status).toBe(400);
    form.set('file', new File([png], 'one.png', { type: 'image/png' })); form.append('file', new File([png], 'two.png', { type: 'image/png' }));
    expect((await fetch('/api/images', { method: 'POST', headers: auth, body: form })).status).toBe(400);
    expect((await fetch('/api/images', { method: 'POST', headers: { ...auth, 'Content-Type': 'multipart/form-data; boundary=bad' }, body: 'broken' })).status).toBe(400);
    expect((await fetch('/api/images', { method: 'POST' })).status).toBe(401);
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });
  it('holds two upload admissions through R2 storage and rejects excess before reading the body', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let count = 0; let admitted!: () => void;
    const ready = new Promise<void>(resolve => { admitted = resolve; });
    const SITE_BUCKET = { put: async () => { if (++count === 2) admitted(); await blocked; } } as unknown as R2Bucket;
    const pending = [upload(png, 'image/png', { SITE_BUCKET }), upload(png, 'image/png', { SITE_BUCKET })];
    await ready;
    const body = new ReadableStream({ pull() { throw new Error('Should not be read'); } }, { highWaterMark: 0 });
    const response = await fetch('/api/images', { method: 'POST', headers: auth, body });
    expect(response.status).toBe(503); expect(response.headers.get('Retry-After')).toBe('1');
    expect((await fetch('/')).status).toBe(200);
    release(); expect((await Promise.all(pending)).map(response => response.status)).toEqual([200, 200]);
    expect((await upload()).status).toBe(200);
  });
  it('releases admission when processing fails', async () => {
    await expect(withImageUploadSlot(async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    expect((await upload()).status).toBe(200);
  });
  it('uses a genuinely distinct request origin for isolated previews', async () => {
    const response = await upload(png, 'image/png', { SITE_ORIGIN: '' }, 'https://preview.example.test');
    expect((await response.json<{ url: string }>()).url).toMatch(/^https:\/\/preview\.example\.test\//);
  });
  it('uses head/conditional get without body reads for HEAD and 304 and overrides old metadata', async () => {
    await post(digest());
    const original = await fetch('/'); const etag = original.headers.get('etag')!; await original.text();
    const get = vi.fn((key: string, options?: R2GetOptions) => bindings.SITE_BUCKET.get(key, options));
    const head = vi.fn((key: string) => bindings.SITE_BUCKET.head(key));
    const SITE_BUCKET = { get, head } as unknown as R2Bucket;
    const response = await fetch('/', { method: 'HEAD' }, { SITE_BUCKET });
    expect(response.status).toBe(200); expect(await response.text()).toBe(''); expect(get).not.toHaveBeenCalled(); expect(head).toHaveBeenCalledOnce();
    for (const value of [etag, etag.replace(/^W\//, ''), `"old", ${etag}`, '*']) {
      expect((await fetch('/', { headers: { 'If-None-Match': value } }, { SITE_BUCKET })).status).toBe(304);
      const object = await get.mock.results.at(-1)!.value; expect(object && 'body' in object).toBe(false);
    }
    await bindings.SITE_BUCKET.put('pages/index.html', 'old', { httpMetadata: { cacheControl: 'public, max-age=86400, no-transform' } });
    const updated = await fetch('/');
    expect(updated.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(updated.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate, no-transform');
    expect(updated.headers.get('Vary')).toBe('Accept-Encoding');
    expect(updated.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
    await updated.text();
  });
  it('makes new publications visible immediately to revalidating clients', async () => {
    await post(digest('First')); const first = await fetch('/'); const etag = first.headers.get('etag')!; await first.text();
    await post(digest('Follow up'));
    const response = await fetch('/', { headers: { 'If-None-Match': etag } });
    expect(response.status).toBe(200); expect(await response.text()).toContain('Follow up');
  });
  it('never exposes legacy daily HTML, sources, manifests or configuration', async () => {
    await post(digest());
    await bindings.SITE_BUCKET.put('pages/digests/2026-10-16.html', 'old permalink');
    for (const path of ['/digests/2026-10-16', '/nope', '/api/digests/list', '/digests/2026-10-16.json', '/posts/', '/publications/', '/pages/index.html', '/wrangler.jsonc', '/.dev.vars']) expect((await fetch(path)).status, path).toBe(404);
    expect((await fetch('/api/digests')).status).toBe(401);
    expect((await fetch('/', { method: 'DELETE' })).status).toBe(405);
    expect((await fetch('/favicon.svg')).headers.get('Content-Type')).toBe('image/svg+xml');
  });
});
