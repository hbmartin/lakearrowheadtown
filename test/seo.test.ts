import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { appendUpdate, currentPublication, publishDigest, rebuildHomepage } from '../src/publishing';
import { archivePath, loadCatalog } from '../src/archives';
import { dimensions, metadataKey } from '../src/image-metadata';
import { hashBytes } from '../src/images';
import { escapeHtml } from '../src/html';
import { SITE } from '../src/site';
import type { ContentBucket, Digest, Env } from '../src/types';

const bindings = env as unknown as Env;
const origin = SITE.origin;
const now = new Date('2026-10-20T18:00:00.000Z');
const auth = { Authorization: 'Bearer test-secret-at-least-thirty-two-characters-long' };
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
const digest = (headline = 'Road update', posted_at = now.toISOString()): Digest => ({ title: 'Private digest', source: 'private-source', items: [{
  headline, posted_at, group: 'Mountain group', group_url: 'https://example.com/group', post_url: `https://example.com/${encodeURIComponent(headline)}`,
  body: 'Community news.', category: 'alert',
}] });
const fetch = (path: string, init: RequestInit = {}, SITE_ORIGIN: string = origin) => worker.fetch(new Request(origin + path, init), { ...bindings, SITE_ORIGIN });
const catalog = async () => loadCatalog(bindings.SITE_BUCKET, (await currentPublication(bindings.SITE_BUCKET)).archives);
const bucket = (put: ContentBucket['put']): ContentBucket => ({ put, get: key => bindings.SITE_BUCKET.get(key), head: key => bindings.SITE_BUCKET.head(key), list: options => bindings.SITE_BUCKET.list(options) });
beforeEach(async () => { vi.restoreAllMocks(); vi.spyOn(console, 'info').mockImplementation(() => {}); await reset(); });

describe('permanent daily archives', () => {
  it('seeds visible dates only, preserves older days beyond history, and supplies a dated PNG and sitemap entry', async () => {
    const input = digest();
    input.items.push(digest('Outside visible week', '2026-10-12T18:00:00Z').items[0]);
    await publishDigest(bindings.SITE_BUCKET, input, origin, now, true);
    expect(Object.keys((await catalog()).days)).toEqual(['2026-10-20']);
    const html = await (await fetch('/2026/10/20/')).text();
    expect(html).toContain('<title>Lake Arrowhead news — Tuesday, October 20, 2026</title>');
    expect(html).toContain('Road update');
    expect(html).not.toContain('Outside visible week');
    expect(html).toContain('<link rel="canonical" href="https://lakearrowhead.town/2026/10/20/">');
    const ref = (await catalog()).days['2026-10-20'];
    const card = await fetch(ref.image);
    expect(card.headers.get('Content-Type')).toBe('image/png');
    expect(dimensions(new Uint8Array(await card.arrayBuffer()))).toMatchObject({ width: 1200, height: 630 });
    await publishDigest(bindings.SITE_BUCKET, digest('November news', '2026-11-25T19:00:00Z'), origin, new Date('2026-11-25T19:00:00Z'), true);
    expect(await (await fetch('/')).text()).not.toContain('Road update');
    expect(await (await fetch('/2026/10/20/')).text()).toContain('Road update');
    expect(await (await fetch('/archive/')).text()).toContain('/2026/10/20/');
    const sitemap = await (await fetch('/sitemap.xml')).text();
    expect(sitemap).toContain('<loc>https://lakearrowhead.town/2026/10/20/</loc><lastmod>2026-10-20T18:00:00.000Z</lastmod>');
    expect(sitemap).toContain('/road-conditions/');
  });

  it('seeds a stale pre-archive snapshot before the first new publication without importing hidden or orphan history', async () => {
    const input = digest('Saved visible', '2026-09-01T18:00:00Z');
    input.items.push(digest('Hidden history', '2026-08-20T18:00:00Z').items[0]);
    await publishDigest(bindings.SITE_BUCKET, input, origin, new Date('2026-09-01T18:00:00Z'), true);
    const previous = await currentPublication(bindings.SITE_BUCKET);
    delete previous.archives;
    const index = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
    await bindings.SITE_BUCKET.put('publications/pre-archives.json', JSON.stringify(previous));
    await bindings.SITE_BUCKET.put('pages/index.html', await index.text(), { customMetadata: { ...index.customMetadata, manifest: 'publications/pre-archives.json' } });
    await bindings.SITE_BUCKET.put('posts/2026-08-31/orphan.json', JSON.stringify(digest('Orphan', '2026-08-31T18:00:00Z')));
    await publishDigest(bindings.SITE_BUCKET, digest('New month'), origin, now, true);
    expect(Object.keys((await catalog()).days).sort()).toEqual(['2026-09-01', '2026-10-20']);
    expect(await (await fetch('/2026/09/01/')).text()).toContain('Saved visible');
    expect(await (await fetch('/archive/')).text()).not.toMatch(/Hidden history|Orphan/);
  });

  it('serves archived copies after original source damage and a subsequent omission', async () => {
    await publishDigest(bindings.SITE_BUCKET, digest('Independent archive'), origin, now, true);
    const publication = await currentPublication(bindings.SITE_BUCKET);
    await bindings.SITE_BUCKET.delete(publication.posts[0].key);
    expect(await (await fetch('/2026/10/20/')).text()).toContain('Independent archive');
    await publishDigest(bindings.SITE_BUCKET, digest('Healthy next day', '2026-10-21T18:00:00Z'), origin, new Date('2026-10-21T18:00:00Z'), true);
    expect(await (await fetch('/2026/10/20/')).text()).toContain('Independent archive');
    await bindings.SITE_BUCKET.delete((await currentPublication(bindings.SITE_BUCKET)).archives!);
    expect((await fetch('/archive/')).status).toBe(503);
    expect((await fetch('/sitemap.xml')).status).toBe(503);
  });

  it('keeps original activity days and refreshes their story after a later update', async () => {
    const result = await publishDigest(bindings.SITE_BUCKET, digest('Original', '2026-10-19T18:00:00Z'), origin, now, true);
    await appendUpdate(bindings.SITE_BUCKET, result.post!.id, 0, { post_url: 'https://example.com/follow-up', group: 'Another group', body: 'Road reopened.', posted_at: '2026-10-21T18:00:00Z' }, origin, new Date('2026-10-21T18:00:00Z'), true);
    expect(Object.keys((await catalog()).days).sort()).toEqual(['2026-10-19', '2026-10-21']);
    for (const date of ['2026-10-19', '2026-10-21']) expect(await (await fetch(archivePath(date))).text()).toContain('Road reopened.');
    const before = await catalog();
    await rebuildHomepage(bindings.SITE_BUCKET, origin);
    expect(await catalog()).toEqual(before);
  });

  it.each(['2026-03-08T07:59:59Z', '2026-11-01T06:59:59Z'])('uses Los Angeles calendar dates around DST: %s', async posted_at => {
    const receipt = new Date(Date.parse(posted_at) + 60_000);
    await publishDigest(bindings.SITE_BUCKET, digest('DST story', posted_at), origin, receipt, true);
    const expected = posted_at.includes('03-') ? '2026-03-07' : '2026-10-31';
    expect((await catalog()).days[expected]).toBeDefined();
  });

  it.each(['archive-days/', 'assets/daily/', 'archive-catalogs/', 'pages/index.html'])('does not expose a failed publication at %s', async failureKey => {
    await publishDigest(bindings.SITE_BUCKET, digest('Committed'), origin, now, true);
    const before = await catalog();
    const broken = bucket((key, value, options) => {
      if (key.startsWith(failureKey)) throw new Error('Injected storage failure');
      return bindings.SITE_BUCKET.put(key, value, options);
    });
    await expect(publishDigest(broken, digest('Uncommitted', '2026-10-21T18:00:00Z'), origin, new Date('2026-10-21T18:00:00Z'), true)).rejects.toBeDefined();
    expect(await catalog()).toEqual(before);
    expect((await fetch('/2026/10/21/')).status).toBe(404);
    expect(await (await fetch('/sitemap.xml')).text()).not.toContain('/2026/10/21/');
    expect(await (await fetch('/')).text()).not.toContain('Uncommitted');
  });

  it('returns 404 for unavailable dates and 503 for missing committed data', async () => {
    for (const path of ['/2026/02/30/', '/2026/10/19/']) expect((await fetch(path)).status).toBe(404);
    await publishDigest(bindings.SITE_BUCKET, digest(), origin, now, true);
    const ref = (await catalog()).days['2026-10-20'];
    await bindings.SITE_BUCKET.delete(ref.key);
    expect((await fetch('/2026/10/20/')).status).toBe(503);
  });

  it('escapes hostile headlines in archive HTML, JSON-LD and PNG rendering', async () => {
    const title = '</script><script>bad()</script> & "quoted"';
    await publishDigest(bindings.SITE_BUCKET, digest(title), origin, now, true);
    const html = await (await fetch('/2026/10/20/')).text();
    expect(html).not.toContain('<script>bad()');
    expect(html).toContain(escapeHtml(title));
  });
});

describe('image and metadata improvements', () => {
  it('accounts for JPEG EXIF rotation and rejects truncated dimensions', async () => {
    const exif = [69,120,105,102,0,0, 73,73,42,0,8,0,0,0, 1,0, 18,1,3,0,1,0,0,0,6,0,0,0, 0,0,0,0];
    const jpeg = new Uint8Array([255,216,255,225,0,34,...exif,255,192,0,17,8,0,2,0,3,3,1,17,0,2,17,0,3,17,0]);
    expect(dimensions(jpeg)).toMatchObject({ width: 2, height: 3, type: 'image/jpeg' });
    for (const [bytes, type] of [[new Uint8Array([255,216,255,224]), 'image/jpeg'], [new TextEncoder().encode('RIFF0000WEBPVP8L'), 'image/webp']] as const) {
      const form = new FormData(); form.append('file', new File([bytes], 'broken', { type }));
      expect((await fetch('/api/images', { method: 'POST', headers: auth, body: form })).status).toBe(415);
    }
  });
  it('records upload dimensions, backfills old images and lazily loads all but the first image including updates', async () => {
    const form = new FormData(); form.append('file', new File([png], 'one.png', { type: 'image/png' }));
    const upload = await fetch('/api/images', { method: 'POST', headers: auth, body: form });
    expect(await upload.json()).toMatchObject({ width: 1, height: 1 });
    const hash = await hashBytes(png);
    await bindings.SITE_BUCKET.delete(metadataKey(hash));
    const input = digest('Images');
    input.items[0].body = `![First](/images/${hash}.png)\n\n![Second](/images/${hash}.png)\n\n![Remote](https://example.com/remote.jpg)`;
    const published = await publishDigest(bindings.SITE_BUCKET, input, origin, now, true);
    await appendUpdate(bindings.SITE_BUCKET, published.post!.id, 0, { post_url: 'https://example.com/update', group: 'group', body: `![Update](/images/${hash}.png)`, posted_at: now.toISOString() }, origin, now, true);
    const html = await (await fetch('/')).text();
    const tags = [...html.matchAll(/<img\b[^>]*>/g)].map(match => match[0]);
    expect(tags).toHaveLength(4);
    expect(tags.filter(tag => tag.includes('loading="eager"'))).toHaveLength(1);
    expect(tags.filter(tag => tag.includes('loading="lazy"'))).toHaveLength(3);
    expect(tags.every(tag => tag.includes('decoding="async"'))).toBe(true);
    expect(tags.filter(tag => tag.includes('width="1" height="1"'))).toHaveLength(3);
    expect(tags.find(tag => tag.includes('remote.jpg'))).not.toContain('width=');
    expect(await bindings.SITE_BUCKET.head(metadataKey(hash))).not.toBeNull();
    const rss = await (await fetch('/rss.xml')).text();
    expect(rss).toContain('<dc:creator>Mountain group</dc:creator>');
    expect(rss).toContain(`<media:content url="${origin}/images/${hash}.png" medium="image" type="image/png" width="1" height="1"/>`);
    expect(rss).toContain('<ttl>15</ttl>');
  });

  it('serves resource pages, fonts, metadata and conditional requests with the origin policy', async () => {
    for (const path of ['/road-conditions/', '/power-outages/', '/emergency-resources/', '/assets/fonts/dm-sans-v1.woff2', '/archive/']) {
      const response = await fetch(path);
      expect(response.status).toBe(200);
      const etag = response.headers.get('ETag')!;
      expect(etag).toBeTruthy();
      expect((await fetch(path, { headers: { 'If-None-Match': etag } })).status).toBe(304);
      const head = await fetch(path, { method: 'HEAD' });
      expect(head.status).toBe(200); expect(await head.text()).toBe('');
      expect((await fetch(path, {}, 'https://preview.example')).headers.get('X-Robots-Tag')).toBe('noindex');
    }
    const html = await (await fetch('/')).text();
    expect(html).toContain(escapeHtml(SITE.title));
    const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)![1])['@graph'];
    expect(graph.find((node: any) => node['@type'] === 'WebSite').alternateName).toEqual(['Lake Arrowhead Town', 'lakearrowhead.town']);
    expect(graph.find((node: any) => node['@type'] === 'Organization').logo.width).toBe(512);
    expect(graph.find((node: any) => node['@type'] === 'Place').geo.latitude).toBe(34.2530894);
    expect(html).not.toContain('SpecialAnnouncement');
  });
});
