import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { publishDigest } from '../src/publishing';
import { recentDates, renderPage } from '../src/render';
import { readLimited, validateDigest } from '../src/validation';
import { IMAGE_LIMIT } from '../src/images';
import type { ContentBucket, Digest, Env } from '../src/types';

const bindings = env as unknown as Env;
const today = () => recentDates(new Date())[0];
const secret = 'test-secret-at-least-thirty-two-characters-long';
const base = 'https://lakearrowhead.town';
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), char => char.charCodeAt(0));

function digest(date = today(), title = 'Morning mountain digest'): Digest {
  return { date, title, source: 'facebook-groups', items: [{
    group: 'Lake Arrowhead 360 Group',
    group_url: 'https://facebook.com/groups/2241141482782874/',
    headline: 'Wind update',
    body: '**Strong winds** are expected.\n\n- Secure outdoor furniture.\n- Check for updates.',
    post_url: 'https://facebook.com/groups/2241141482782874/permalink/4816273571936306/',
    category: 'alert',
    posted_at: '2026-10-16T07:12:00-07:00',
  }] };
}

async function fetch(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) {
  return worker.fetch(new Request(base + path, init), { ...bindings, ...overrides });
}

function post(input: unknown, authorization = `Bearer ${secret}`) {
  return fetch('/api/digests', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify(input) });
}

function upload(bytes: Uint8Array = png, type = 'image/png', overrides: Partial<Env> = {}) {
  const form = new FormData();
  form.append('file', new File([bytes], 'photo', { type }));
  return fetch('/api/images', { method: 'POST', headers: { Authorization: `Bearer ${secret}` }, body: form }, overrides);
}

beforeEach(async () => {
  let cursor: string | undefined;
  do {
    const list = await bindings.SITE_BUCKET.list({ cursor });
    if (list.objects.length) await bindings.SITE_BUCKET.delete(list.objects.map(item => item.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
});

describe('authenticated digest publishing', () => {
  it('serves the bundled empty homepage before publishing', async () => {
    const response = await fetch('/');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('No digests published');
  });

  it.each(['', 'Bearer wrong', `Basic ${secret}`])('rejects invalid authorization %s without writes', async authorization => {
    expect((await post(digest(), authorization)).status).toBe(401);
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });

  it('fails closed when the secret is missing or too short', async () => {
    for (const API_SECRET of [undefined, 'short']) {
      const response = await fetch('/api/images', { method: 'POST' }, { API_SECRET });
      expect(response.status).toBe(503);
    }
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });

  it('creates a digest and fully replaces it by date', async () => {
    const input = digest();
    const response = await post(input);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, url: `/digests/${input.date}` });
    const initial = await fetch('/');
    const oldTag = initial.headers.get('etag')!;
    expect(await initial.text()).toContain('<strong>Strong winds</strong>');
    input.title = 'Corrected digest';
    input.items = [];
    expect((await post(input)).status).toBe(200);
    const current = await fetch('/index.html', { headers: { 'If-None-Match': oldTag } });
    expect(current.status).toBe(200);
    expect(current.headers.get('etag')).not.toBe(oldTag);
    const html = await current.text();
    expect(html).toContain('Corrected digest');
    expect(html).not.toContain('Wind update');
    expect(html.match(/<section class="digest"/g)).toHaveLength(1);
    const daily = await fetch(`/digests/${input.date}`);
    expect(await daily.text()).toContain('No updates in this digest.');
    const source = await bindings.SITE_BUCKET.get(`digests/${input.date}.json`);
    expect(await source!.json()).toEqual(input);
  });

  it.each([
    { date: '2026-02-30' }, { date: '0000-01-01' }, { date: '2026-1-01' },
    { title: '' }, { source: 3 }, { items: {} }, { items: [null] },
    { items: [{ ...digest().items[0], posted_at: '2026-10-16T07:12:00' }] },
    { items: [{ ...digest().items[0], posted_at: '2026-02-30T07:12:00Z' }] },
    { items: [{ ...digest().items[0], posted_at: '2026-10-16T25:12:00Z' }] },
    { items: [{ ...digest().items[0], group_url: 'javascript:alert(1)' }] },
    { items: [{ ...digest().items[0], post_url: 'relative/path' }] },
  ])('rejects bad payloads without writes: %j', async patch => {
    expect((await post({ ...digest(), ...patch })).status).toBe(400);
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });

  it('rejects bad JSON, wrong content types, and oversized JSON', async () => {
    const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
    expect((await fetch('/api/digests', { method: 'POST', headers, body: '{' })).status).toBe(400);
    expect((await fetch('/api/digests', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await post({ ...digest(), title: 'x'.repeat(1024 * 1024) })).status).toBe(413);
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });

  it('bounds streamed request bodies without trusting Content-Length', async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); controller.close(); } });
    await expect(readLimited(new Request(base, { method: 'POST', body: stream }), 10)).rejects.toMatchObject({ status: 413 });
  });

  it('keeps arbitrary categories and submitted item order', async () => {
    const input = digest();
    input.items[0].category = 'road conditions & weather';
    input.items.push({ ...input.items[0], headline: 'Second item', posted_at: '2026-10-16T23:00:00Z', category: '' });
    await post(input);
    const html = await (await fetch('/')).text();
    expect(html).toContain('road conditions &amp; weather');
    expect(html.indexOf('Wind update')).toBeLessThan(html.indexOf('Second item'));
  });

  it('serializes simultaneous writes and retains both days on the homepage', async () => {
    const dates = recentDates(new Date());
    const responses = await Promise.all([post(digest(dates[0], 'Today digest')), post(digest(dates[1], 'Yesterday digest'))]);
    expect(responses.map(value => value.status)).toEqual([200, 200]);
    const html = await (await fetch('/')).text();
    expect(html).toContain('Today digest');
    expect(html).toContain('Yesterday digest');
    expect(html.indexOf('Today digest')).toBeLessThan(html.indexOf('Yesterday digest'));
    await Promise.all([post(digest(dates[0], 'Correction A')), post(digest(dates[0], 'Correction B'))]);
    const source = await (await bindings.SITE_BUCKET.get(`digests/${dates[0]}.json`))!.json<Digest>();
    const home = await (await fetch('/')).text();
    expect(home).toContain(source.title);
    expect(home.match(/<section class="digest"/g)).toHaveLength(2);
  });

  it('returns 500 on publishing errors', async () => {
    const failedPublisher = { getByName() { return { publish() { throw new Error('storage unavailable'); } }; } } as unknown as Env['PUBLISHER'];
    const response = await fetch('/api/digests', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(digest()) }, { PUBLISHER: failedPublisher });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false });
  });

  it('repairs a partial publish when the same date is retried', async () => {
    const input = digest();
    const put = vi.fn(async (key: string, value: string, options?: R2PutOptions) => {
      if (key === 'pages/index.html') throw new Error('injected write failure');
      return bindings.SITE_BUCKET.put(key, value, options);
    });
    const broken: ContentBucket = { get: key => bindings.SITE_BUCKET.get(key), put };
    await expect(publishDigest(broken, input, base)).rejects.toThrow('injected write failure');
    expect(await bindings.SITE_BUCKET.get(`digests/${input.date}.json`)).not.toBeNull();
    expect((await post(input)).status).toBe(200);
    expect(await (await fetch('/')).text()).toContain(input.title);
  });
});

describe('calendar selection and Markdown rendering', () => {
  it.each([
    ['2026-10-16T06:59:59Z', '2026-10-15', '2026-10-09'],
    ['2026-10-16T07:00:00Z', '2026-10-16', '2026-10-10'],
    ['2026-03-09T07:00:00Z', '2026-03-09', '2026-03-03'],
    ['2026-11-02T08:00:00Z', '2026-11-02', '2026-10-27'],
    ['2024-03-01T08:00:00Z', '2024-03-01', '2024-02-24'],
    ['2027-01-01T08:00:00Z', '2027-01-01', '2026-12-26'],
  ])('selects calendar days at %s', (now, first, last) => {
    const dates = recentDates(new Date(now));
    expect(dates).toHaveLength(7);
    expect(dates[0]).toBe(first);
    expect(dates[6]).toBe(last);
  });

  it('omits old and future dates while retaining their permalinks', async () => {
    const now = new Date('2026-10-16T20:00:00Z');
    for (const date of ['2026-10-09', '2026-10-10', '2026-10-16', '2026-10-17']) await publishDigest(bindings.SITE_BUCKET, digest(date, `Digest ${date}`), base, now);
    const html = await (await fetch('/')).text();
    expect(html).toContain('Digest 2026-10-10');
    expect(html).toContain('Digest 2026-10-16');
    expect(html).not.toContain('Digest 2026-10-09');
    expect(html).not.toContain('Digest 2026-10-17');
    expect((await fetch('/digests/2026-10-09')).status).toBe(200);
    expect((await fetch('/digests/2026-10-17')).status).toBe(200);
  });

  it('escapes supplied text and raw HTML and prevents unsafe Markdown links', () => {
    const input = digest();
    input.title = '<img src=x onerror=alert(1)> $&';
    input.items[0].headline = '<script>alert(1)</script>';
    input.items[0].category = '\"><script>bad()</script>';
    input.items[0].body = '<script>evil()</script>\n\n[bad](javascript:alert(1))\n\n![photo](https://lakearrowhead.town/images/photo.png)';
    const html = renderPage([input], { origin: base, daily: true });
    expect(html).not.toContain('<script>evil()');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<img src="https://lakearrowhead.town/images/photo.png" alt="photo">');
    expect(html).toContain('$&amp;');
  });

  it('accepts leap days and offset timestamps without changing the supplied day', () => {
    const input = digest('2024-02-29');
    input.items[0].posted_at = '2024-03-01T00:00:00.123+14:00';
    expect(validateDigest(input)).toEqual(input);
  });
});

describe('public routes and images', () => {
  it('uploads deduplicated images and serves them without authorization', async () => {
    const first = await upload();
    expect(first.status).toBe(200);
    const result = await first.json<{ ok: boolean; url: string }>();
    expect(result.url).toMatch(/^https:\/\/lakearrowhead\.town\/images\/[a-f0-9]{64}\.png$/);
    expect(await (await upload()).json()).toEqual(result);
    expect((await bindings.SITE_BUCKET.list({ prefix: 'images/' })).objects).toHaveLength(1);
    const response = await fetch(new URL(result.url).pathname);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Cache-Control')).toContain('immutable');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    const input = digest();
    input.items[0].body = `![Uploaded image](${result.url})`;
    await post(input);
    expect(await (await fetch('/')).text()).toContain(`<img src="${result.url}"`);
  });

  it.each([
    ['image/jpeg', [255, 216, 255, 224]],
    ['image/gif', [...new TextEncoder().encode('GIF89a'), 1, 0, 1, 0, 0, 0, 0]],
    ['image/webp', [...new TextEncoder().encode('RIFF'), 20, 0, 0, 0, ...new TextEncoder().encode('WEBPVP8 ')]],
  ])('accepts the supported %s signature', async (type, values) => {
    expect((await upload(new Uint8Array(values), type)).status).toBe(200);
  });

  it('validates actual size and MIME signatures without writes', async () => {
    expect((await upload(png, 'image/jpeg')).status).toBe(415);
    expect((await upload(new TextEncoder().encode('<svg/>'), 'image/svg+xml')).status).toBe(415);
    expect((await upload(new Uint8Array(0))).status).toBe(415);
    expect((await upload(new Uint8Array(IMAGE_LIMIT + 1))).status).toBe(413);
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });

  it('rejects absent/extra file fields, malformed forms, and unauthenticated uploads', async () => {
    const headers = { Authorization: `Bearer ${secret}` };
    const form = new FormData();
    form.append('file', 'not a file');
    expect((await fetch('/api/images', { method: 'POST', headers, body: form })).status).toBe(400);
    form.set('file', new File([png], 'one.png', { type: 'image/png' }));
    form.append('file', new File([png], 'two.png', { type: 'image/png' }));
    expect((await fetch('/api/images', { method: 'POST', headers, body: form })).status).toBe(400);
    expect((await fetch('/api/images', { method: 'POST', headers: { ...headers, 'Content-Type': 'multipart/form-data; boundary=bad' }, body: 'broken' })).status).toBe(400);
    expect((await fetch('/api/images', { method: 'POST' })).status).toBe(401);
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });

  it('uses the request origin for isolated previews', async () => {
    const response = await upload(png, 'image/png', { SITE_ORIGIN: '' });
    expect((await response.json<{ url: string }>()).url).toMatch(/^https:\/\/lakearrowhead\.town\//);
  });

  it('revalidates HTML with ETags and handles HEAD', async () => {
    await post(digest());
    const response = await fetch('/');
    const etag = response.headers.get('etag')!;
    await response.text();
    expect(response.headers.get('cache-control')).toContain('must-revalidate');
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
    expect(etag).toMatch(/^W\//);
    expect((await fetch('/', { headers: { 'If-None-Match': etag.replace(/^W\//, '') } })).status).toBe(304);
    expect((await fetch('/', { headers: { 'If-None-Match': `"old", ${etag}` } })).status).toBe(304);
    const head = await fetch('/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('exposes only the specified public routes and rejects unsupported methods', async () => {
    await post(digest());
    for (const path of ['/nope', '/api/digests/list', `/digests/${today()}.json`, `/pages/digests/${today()}.html`, '/pages/index.html', '/wrangler.jsonc', '/.dev.vars', '/digests/2026-02-30']) {
      expect((await fetch(path)).status, path).toBe(404);
    }
    expect((await fetch('/api/digests')).status).toBe(405);
    expect((await fetch('/', { method: 'DELETE' })).status).toBe(405);
    expect((await fetch('/favicon.svg')).headers.get('content-type')).toBe('image/svg+xml');
  });
});
