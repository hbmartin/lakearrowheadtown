import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { currentPublication, initialMigration, migrateBatch, postKey, publishDigest, rebuildHomepage } from '../src/publishing';
import { recentDates, renderPage } from '../src/render';
import { readLimited, validateDigest } from '../src/validation';
import { IMAGE_LIMIT, withImageUploadSlot } from '../src/images';
import type { ContentBucket, Digest, Env, RebuildJob, StoredPost } from '../src/types';

const bindings = env as unknown as Env;
const secret = 'test-secret-at-least-thirty-two-characters-long';
const base = 'https://lakearrowhead.town';
const auth = { Authorization: `Bearer ${secret}` };
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), char => char.charCodeAt(0));
const publisher = () => bindings.PUBLISHER.getByName('site');
function digest(title = 'Morning mountain digest'): Digest {
  return { title, source: 'facebook-groups', items: [{
    group: 'Lake Arrowhead 360 Group', group_url: 'https://facebook.com/groups/2241141482782874/',
    headline: 'Wind update', body: '**Strong winds** are expected.\n\n- Secure outdoor furniture.\n- Check for updates.',
    post_url: 'https://facebook.com/groups/2241141482782874/permalink/4816273571936306/', category: 'alert', posted_at: '2026-10-16T07:12:00-07:00',
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

beforeEach(async () => { vi.restoreAllMocks(); await reset(); });

describe('append-only publication', () => {
  it('serves a canonical empty homepage and revalidates its cached ETag', async () => {
    const response = await fetch('/');
    const tag = response.headers.get('etag')!;
    const html = await response.text();
    expect(html).toContain('No digests published');
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
  it('appends duplicate requests and follow-up corrections instead of replacing', async () => {
    for (const input of [digest(), digest(), { ...digest('Correction'), items: [] }]) {
      const response = await post(input);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, url: '/' });
    }
    const html = await (await fetch('/')).text();
    expect(html.match(/<section class="digest"/g)).toHaveLength(3);
    expect(html).toContain('Morning mountain digest');
    expect(html).toContain('Correction');
    expect(html).toContain('No updates in this digest.');
    expect(html).toContain('Last published');
    expect((await bindings.SITE_BUCKET.list({ prefix: 'posts/' })).objects).toHaveLength(3);
  });
  it('ignores all client identity/date fields and preserves source timestamps', async () => {
    await post({ ...digest(), date: 'not a date', id: 'spoof', received_at: '1900-01-01' });
    const publication = await currentPublication(bindings.SITE_BUCKET);
    const source = await bindings.SITE_BUCKET.get(publication.posts[0].key);
    const stored = await source!.json<StoredPost>();
    expect(stored.id).not.toBe('spoof');
    expect(stored.date).toBe(recentDates(new Date())[0]);
    expect(Math.abs(Date.now() - Date.parse(stored.received_at))).toBeLessThan(10000);
    expect(stored.items[0].posted_at).toBe(digest().items[0].posted_at);
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
  it('keeps arbitrary categories and submitted item order', async () => {
    const input = digest(); input.items[0].category = 'road & weather';
    input.items.push({ ...input.items[0], headline: 'Second item', category: '' });
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
    expect(html.match(/<section class="digest"/g)).toHaveLength(3);
  });
  it('keeps the previous index/manifest on failed publication and does not include orphan sources on rebuild', async () => {
    await publishDigest(bindings.SITE_BUCKET, digest('Good post'), base);
    const before = await currentPublication(bindings.SITE_BUCKET);
    const original = await (await fetch('/')).text();
    const broken = bucketWith({ put: async (key, value, options) => { if (key === 'pages/index.html') throw new Error('injected failure'); return bindings.SITE_BUCKET.put(key, value, options); } });
    await expect(publishDigest(broken, digest('Uncommitted'), base)).rejects.toThrow('injected');
    expect(await currentPublication(bindings.SITE_BUCKET)).toEqual(before);
    expect(await (await fetch('/')).text()).toBe(original);
    await rebuildHomepage(bindings.SITE_BUCKET, base);
    expect(await (await fetch('/')).text()).not.toContain('Uncommitted');
  });
  it('returns an honest failure message without promising safe retries', async () => {
    const PUBLISHER = { getByName: () => ({ publish: () => { throw new Error('private storage detail'); } }) } as unknown as Env['PUBLISHER'];
    const response = await fetch('/api/digests', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(digest()) }, { PUBLISHER });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/retry safely|private storage detail/);
  });
});

describe('server dates, snapshots and rendering', () => {
  it.each([
    ['2026-10-16T06:59:59Z', '2026-10-15', '2026-10-09'], ['2026-10-16T07:00:00Z', '2026-10-16', '2026-10-10'],
    ['2026-03-09T07:00:00Z', '2026-03-09', '2026-03-03'], ['2026-11-02T08:00:00Z', '2026-11-02', '2026-10-27'],
    ['2024-03-01T08:00:00Z', '2024-03-01', '2024-02-24'], ['2027-01-01T08:00:00Z', '2027-01-01', '2026-12-26'],
  ])('assigns the server day at %s', async (now, first, last) => {
    expect(recentDates(new Date(now))).toHaveLength(7);
    expect(recentDates(new Date(now))).toEqual(expect.arrayContaining([first, last]));
    const post = await publishDigest(bindings.SITE_BUCKET, digest(), base, new Date(now));
    expect(post.date).toBe(first);
  });
  it('keeps seven calendar dates, expires old posts only on publish, and rebuilds the exact snapshot', async () => {
    for (const day of ['09', '10', '16']) await publishDigest(bindings.SITE_BUCKET, digest(`Day ${day}`), base, new Date(`2026-10-${day}T20:00:00Z`));
    const snapshot = await currentPublication(bindings.SITE_BUCKET);
    const html = await (await fetch('/')).text();
    expect(html).not.toContain('Day 09'); expect(html).toContain('Day 10'); expect(html).toContain('Day 16');
    await rebuildHomepage(bindings.SITE_BUCKET, base);
    expect(await currentPublication(bindings.SITE_BUCKET)).toEqual(snapshot);
    expect(await (await fetch('/')).text()).toBe(html);
    await publishDigest(bindings.SITE_BUCKET, digest('Next week'), base, new Date('2026-10-24T20:00:00Z'));
    expect(await (await fetch('/')).text()).not.toContain('Day 16');
  });
  it('orders by receipt time and uses unique IDs for posts on the same date', async () => {
    await publishDigest(bindings.SITE_BUCKET, digest('Earlier'), base, new Date('2026-10-16T19:00:00Z'));
    await publishDigest(bindings.SITE_BUCKET, digest('Later'), base, new Date('2026-10-16T20:00:00Z'));
    const html = await (await fetch('/')).text();
    expect(html.indexOf('Later')).toBeLessThan(html.indexOf('Earlier'));
    const ids = [...html.matchAll(/id="post-([^"]+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(2);
    expect(html).not.toContain('href="/digests/');
  });
  it('escapes HTML and unsafe links while preserving Markdown images', () => {
    const input: StoredPost = { ...digest('<img src=x onerror=alert(1)> $&'), id: 'sample', date: '2026-10-16', received_at: '2026-10-16T20:00:00Z' };
    input.items[0].headline = '<script>alert(1)</script>';
    input.items[0].category = '\"><script>bad()</script>';
    input.items[0].body = '<script>evil()</script>\n\n[bad](javascript:alert(1))\n\n![photo](https://lakearrowhead.town/images/photo.png)';
    const html = renderPage([input], { origin: base });
    expect(html).not.toMatch(/<script>evil|<script>alert|href="javascript:|<img src=x/);
    expect(html).toContain('&lt;script&gt;'); expect(html).toContain('$&amp;');
    expect(html).toContain('<img src="https://lakearrowhead.town/images/photo.png" alt="photo">');
  });
  it('validates real source dates and offset timestamps', () => {
    const input = digest(); input.items[0].posted_at = '2024-03-01T00:00:00.123+14:00';
    expect(validateDigest(input)).toEqual(input);
    input.items[0].posted_at = '2023-02-29T00:00:00Z';
    expect(() => validateDigest(input)).toThrow();
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
    await expect(migrateBatch(broken, initialMigration())).rejects.toThrow('interrupted');
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
    expect(await (await upload()).json()).toEqual(result);
    expect((await bindings.SITE_BUCKET.list({ prefix: 'images/' })).objects).toHaveLength(1);
    const image = await fetch(new URL(result.url).pathname);
    expect(image.headers.get('Cache-Control')).toContain('immutable');
    expect(image.headers.get('Cloudflare-CDN-Cache-Control')).toContain('immutable');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
    const input = digest(); input.items[0].body = `![Photo](${result.url})`; await post(input);
    expect(await (await fetch('/')).text()).toContain(`<img src="${result.url}"`);
  });
  it.each([
    ['image/jpeg', [255, 216, 255, 224]],
    ['image/gif', [...new TextEncoder().encode('GIF89a'), 1, 0, 1, 0, 0, 0, 0]],
    ['image/webp', [...new TextEncoder().encode('RIFF'), 20, 0, 0, 0, ...new TextEncoder().encode('WEBPVP8 ')]],
  ])('accepts the supported %s signature', async (type, values) => { expect((await upload(new Uint8Array(values), type)).status).toBe(200); });
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
    expect(updated.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
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
    expect((await fetch('/api/digests')).status).toBe(405);
    expect((await fetch('/', { method: 'DELETE' })).status).toBe(405);
    expect((await fetch('/favicon.svg')).headers.get('Content-Type')).toBe('image/svg+xml');
  });
});
