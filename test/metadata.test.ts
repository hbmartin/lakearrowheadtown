import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { escapeHtml, renderPage } from '../src/render';
import { currentPublication, publishDigest, rebuildHomepage } from '../src/publishing';
import { ASSETS, SITE } from '../src/site';
import type { Digest, Env, Publication, StoredPost } from '../src/types';

const bindings = env as unknown as Env;
const now = new Date('2026-10-17T18:00:00.000Z');
const input = (headline = 'Community update', posted_at = now.toISOString()): Digest => ({
  title: 'Private batch title', source: 'private-source-label', items: [{
    headline, posted_at, body: 'A community summary.', category: 'announcement',
    group: 'Community source', group_url: 'https://example.com/group', post_url: 'https://example.com/post',
  }],
});
const fetch = (path: string, init: RequestInit = {}, origin: string = SITE.origin, SITE_ORIGIN: string = SITE.origin, overrides: Partial<Env> = {}) =>
  worker.fetch(new Request(origin + path, init), { ...bindings, SITE_ORIGIN, ...overrides });
const graphOf = (html: string) => JSON.parse(html.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)![1])['@graph'] as Array<Record<string, any>>;
const pageOf = (html: string) => graphOf(html).find(node => node['@type'] === 'CollectionPage')!;
const listOf = (html: string) => graphOf(html).find(node => node['@type'] === 'ItemList')!;
const htmlOf = async () => (await fetch('/')).text();
const published = () => publishDigest(bindings.SITE_BUCKET, input(), SITE.origin, now, true);

beforeEach(async () => { vi.restoreAllMocks(); vi.spyOn(console, 'info').mockImplementation(() => {}); await reset(); });

describe('homepage metadata', () => {
  it('provides one consistent set of complete tags for empty, published and rebuilt pages', async () => {
    const pages = [await htmlOf()];
    await published();
    pages.push(await htmlOf());
    await rebuildHomepage(bindings.SITE_BUCKET, SITE.origin);
    pages.push(await htmlOf());
    for (const html of pages) {
      const head = html.split('</head>')[0];
      expect(head.match(/<title>/g)).toHaveLength(1);
      expect(head).toContain(`<title>${escapeHtml(SITE.title)}</title>`);
      const names = [...head.matchAll(/<meta name="([^"]+)"/g)].map(match => match[1]);
      const properties = [...head.matchAll(/<meta property="([^"]+)"/g)].map(match => match[1]);
      expect(new Set(names).size).toBe(names.length);
      expect(new Set(properties).size).toBe(properties.length);
      expect(head.match(/rel="canonical"/g)).toHaveLength(1);
      expect(head.match(/type="application\/ld\+json"/g)).toHaveLength(1);
      for (const name of ['description', 'twitter:description']) expect(head).toContain(`<meta name="${name}" content="${SITE.description}">`);
      expect(head).toContain(`<meta property="og:description" content="${SITE.description}">`);
      expect(head).toContain('<meta name="twitter:card" content="summary_large_image">');
      expect(head).toContain(`<meta name="application-name" content="${SITE.name}">`);
      expect(head).toContain('<meta name="robots" content="index, follow, max-image-preview:large">');
      expect(head).toContain(`<meta name="theme-color" content="${SITE.background}">`);
      expect(properties).toEqual(expect.arrayContaining(['og:type', 'og:site_name', 'og:title', 'og:url', 'og:locale', 'og:image', 'og:image:secure_url', 'og:image:type', 'og:image:width', 'og:image:height', 'og:image:alt']));
      expect(head).toContain(`<meta property="og:image" content="${SITE.origin}${ASSETS.social}">`);
      expect(head).toContain(`<meta name="twitter:image" content="${SITE.origin}${ASSETS.social}">`);
      expect(head).toContain(`<meta property="og:image:alt" content="${escapeHtml(SITE.imageAlt)}">`);
      expect(head).toContain('<meta property="og:image:width" content="1200">');
      expect(head).toContain('<meta property="og:image:height" content="630">');
      expect(head).toContain('<meta property="og:image:type" content="image/png">');
      expect(head).toContain('rel="apple-touch-icon"');
      expect(head).toContain('rel="manifest" href="/site.webmanifest"');
      expect(head).not.toMatch(/Private batch title|private-source-label|received_at|publications\//);
    }
    expect(pageOf(pages[0]).dateModified).toBeUndefined();
    expect(listOf(pages[0]).numberOfItems).toBe(0);
    expect(listOf(pages[0]).itemListElement).toEqual([]);
    expect(pageOf(pages[1]).dateModified).toBe(now.toISOString());
    expect(pages[2]).toBe(pages[1]);
    const graph = graphOf(pages[1]);
    expect(graph[0]).toMatchObject({ '@type': 'WebSite', name: SITE.name, url: SITE.origin + '/', inLanguage: 'en-US' });
    expect(graph[1].isPartOf['@id']).toBe(graph[0]['@id']);
    expect(graph[1].mainEntity['@id']).toBe(graph[2]['@id']);
  });

  it('uses the same seven-day filtering, timestamp ordering, and duplicates as the visible feed', () => {
    const items = [
      input('Too old', '2026-10-11T06:59:59Z').items[0],
      input('Earlier today', '2026-10-17T09:00:00Z').items[0],
      input('First tie').items[0], input('Second tie').items[0], input('Second tie').items[0],
      input('Future day', '2026-10-18T07:00:00Z').items[0],
      input('Oldest allowed', '2026-10-11T07:00:00Z').items[0],
    ];
    const post: StoredPost = { ...input(), items, id: 'private-id', date: '2026-10-17', received_at: now.toISOString() };
    const publication: Publication = { version: 1, posts: [], snapshot_date: '2026-10-17', published_at: now.toISOString() };
    const html = renderPage([post], { origin: SITE.origin, publication });
    const list = listOf(html);
    const headlines = [...html.matchAll(/<a class="headline-link"[^>]*>([^<]*)<\/a>/g)].map(match => match[1]);
    expect(list.itemListElement.map((item: any) => item.name)).toEqual(headlines);
    expect(headlines).toEqual(['First tie', 'Second tie', 'Second tie', 'Earlier today', 'Oldest allowed']);
    expect(list.numberOfItems).toBe(5);
    expect(list.itemListElement.map((item: any) => item.position)).toEqual([1, 2, 3, 4, 5]);
    expect(list.itemListElement.every((item: any) => item.url === 'https://example.com/post')).toBe(true);
    expect(html).not.toMatch(/Too old|Future day|private-id/);
  });

  it('excludes damaged historical sources and their private references from structured data', async () => {
    const post = await publishDigest(bindings.SITE_BUCKET, input('Damaged headline'), SITE.origin, now, true);
    const snapshot = await currentPublication(bindings.SITE_BUCKET);
    await bindings.SITE_BUCKET.delete(snapshot.posts.find(ref => ref.id === post.post!.id)!.key);
    await publishDigest(bindings.SITE_BUCKET, input('Healthy headline'), SITE.origin, now, true);
    const html = await htmlOf();
    expect(listOf(html).itemListElement.map((item: any) => item.name)).toEqual(['Healthy headline']);
    expect(html).not.toMatch(/Damaged headline|omitted_posts/);
    expect(html).not.toContain(post.post!.id);
  });

  it('round-trips hostile text in JSON-LD without creating HTML or script elements', async () => {
    const headline = '</script><script>alert("bad")</script><!-- <tag> & " \' \u2028\u2029';
    const digest = input(headline);
    digest.items[0].post_url = 'https://example.com/post?a="x"&b=<tag>';
    await publishDigest(bindings.SITE_BUCKET, digest, SITE.origin, now, true);
    const html = await htmlOf();
    const encoded = html.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)![1];
    expect(encoded).not.toMatch(/[<\u2028\u2029]/);
    expect(listOf(html).itemListElement[0]).toMatchObject({ name: headline, url: digest.items[0].post_url });
    expect(html).not.toContain('<script>alert(');
    expect(html).toContain(`href="${escapeHtml(digest.items[0].post_url)}"`);
    expect(html).toContain(escapeHtml(headline));
  });
});

describe('indexing and canonical origins', () => {
  it.each(['not an origin', 'https://lakearrowhead.town/path', 'https://user:pass@lakearrowhead.town'])('keeps stored public resources available and unindexed with invalid SITE_ORIGIN: %s', async configured => {
    await published();
    const image = `/images/${'a'.repeat(64)}.png`;
    await bindings.SITE_BUCKET.put(image.slice(1), new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: 'image/png' } });
    for (const path of ['/', '/index.html', image, '/favicon.svg', '/favicon.ico', '/site.webmanifest', '/robots.txt', ...Object.values(ASSETS)]) {
      const response = await fetch(path, {}, SITE.origin, configured);
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
      const etag = response.headers.get('etag')!;
      const bytes = await response.arrayBuffer();
      const good = await fetch(path);
      const goodBytes = await good.arrayBuffer();
      if (path !== '/robots.txt') expect(bytes).toEqual(goodBytes);
      else expect(new TextDecoder().decode(bytes)).not.toContain('Sitemap:');
      for (const method of ['GET', 'HEAD']) {
        const unchanged = await fetch(path, { method, headers: { 'If-None-Match': etag } }, SITE.origin, configured);
        expect(unchanged.status).toBe(304);
        expect(unchanged.headers.get('X-Robots-Tag')).toBe('noindex');
        expect(await unchanged.text()).toBe('');
      }
      const head = await fetch(path, { method: 'HEAD' }, SITE.origin, configured);
      expect(head.status).toBe(200);
      expect(head.headers.get('etag')).toBe(etag);
      expect(head.headers.get('X-Robots-Tag')).toBe('noindex');
      expect(await head.text()).toBe('');
    }
    for (const method of ['GET', 'HEAD']) {
      const sitemap = await fetch('/sitemap.xml', { method }, SITE.origin, configured);
      expect(sitemap.status).toBe(404);
      expect(sitemap.headers.get('X-Robots-Tag')).toBe('noindex');
    }
  });

  it('retains strict invalid-origin errors for empty-page rendering and authenticated publication', async () => {
    const configured = 'https://lakearrowhead.town/path';
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch('/', { method }, SITE.origin, configured);
      expect(response.status).toBe(503);
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    }
    for (const path of ['/api/digests', '/api/images', '/api/rebuild']) {
      const response = await fetch(path, { method: 'POST', headers: { Authorization: 'Bearer test-secret-at-least-thirty-two-characters-long' } }, SITE.origin, configured);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false, error: 'Site origin is not configured correctly', code: 'configuration_error' });
    }
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });

  it.each([
    ['preview', 'https://preview.example.test', ''],
    ['localhost', 'http://localhost:8787', ''],
    ['alternate production host', 'https://lakearrowheadtown.example.workers.dev', SITE.origin],
  ])('keeps %s unindexed for empty and stored HTML, HEAD and 304 responses', async (_name, origin, configured) => {
    const canonical = configured || origin;
    for (const stored of [false, true]) {
      if (stored) await publishDigest(bindings.SITE_BUCKET, input(), canonical, now, true);
      for (const path of ['/', '/index.html']) {
        const response = await fetch(path, {}, origin, configured);
        const html = await response.text();
        expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
        expect(html).toContain(`<link rel="canonical" href="${canonical}/">`);
        expect(html).toContain(`<meta property="og:url" content="${canonical}/">`);
        expect(pageOf(html).url).toBe(canonical + '/');
        if (!configured) expect(html).toContain('<meta name="robots" content="noindex">');
        if (origin.startsWith('http:')) expect(html).not.toContain('og:image:secure_url');
        const etag = response.headers.get('etag')!;
        for (const method of ['GET', 'HEAD']) {
          const unchanged = await fetch(path, { method, headers: { 'If-None-Match': etag } }, origin, configured);
          expect(unchanged.status).toBe(304);
          expect(unchanged.headers.get('X-Robots-Tag')).toBe('noindex');
          expect(await unchanged.text()).toBe('');
        }
        const head = await fetch(path, { method: 'HEAD' }, origin, configured);
        expect(head.status).toBe(200);
        expect(head.headers.get('X-Robots-Tag')).toBe('noindex');
        expect(await head.text()).toBe('');
      }
    }
    const robots = await (await fetch('/robots.txt', {}, origin, configured)).text();
    expect(robots).toContain('Allow: /');
    expect(robots).not.toContain('Disallow: /\n');
    expect(robots).not.toContain('Sitemap:');
    const sitemap = await fetch('/sitemap.xml', { method: 'HEAD' }, origin, configured);
    expect(sitemap.status).toBe(404);
    expect(sitemap.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(await sitemap.text()).toBe('');
    const asset = await fetch(ASSETS.social, {}, origin, configured);
    const assetTag = asset.headers.get('etag')!;
    await asset.arrayBuffer();
    expect((await fetch(ASSETS.social, { headers: { 'If-None-Match': assetTag } }, origin, configured)).headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('indexes only the production origin and advertises its one sitemap', async () => {
    for (const path of ['/', '/index.html']) expect((await fetch(path)).headers.get('X-Robots-Tag')).toBeNull();
    expect(await (await fetch('/robots.txt')).text()).toBe(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE.origin}/sitemap.xml\n`);
    expect((await fetch('/', {}, SITE.origin, 'https://preview.example.test')).headers.get('X-Robots-Tag')).toBe('noindex');
    expect((await fetch('/sitemap.xml', {}, SITE.origin, 'https://preview.example.test')).status).toBe(404);
  });
});

describe('crawler resources and artwork', () => {
  it('uses only the committed publication for sitemap dates and keeps rebuild dates stable', async () => {
    const empty = await fetch('/sitemap.xml');
    const emptyTag = empty.headers.get('etag')!;
    const xml = await empty.text();
    expect(xml).toContain(`<loc>${SITE.origin}/</loc>`);
    expect(xml).not.toContain('lastmod');
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
    await published();
    await bindings.SITE_BUCKET.put('publications/orphan.json', JSON.stringify({ published_at: '2099-01-01T00:00:00.000Z' }));
    const response = await fetch('/sitemap.xml', { headers: { 'If-None-Match': emptyTag } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
    const sitemap = await response.text();
    expect(sitemap).toContain(`<lastmod>${now.toISOString()}</lastmod>`);
    expect(sitemap.match(/<loc>/g)).toHaveLength(6);
    expect(sitemap).toContain('<loc>https://lakearrowhead.town/2026/10/17/</loc>');
    expect(sitemap).not.toMatch(/2099|orphan|publications|posts|index\.html/);
    await rebuildHomepage(bindings.SITE_BUCKET, SITE.origin);
    expect(await (await fetch('/sitemap.xml')).text()).toBe(sitemap);
  });

  it.each([null, 'not JSON', '{}', '{"published_at":null}', '{"published_at":"2026-02-30T00:00:00.000Z"}', '{"published_at":"</lastmod>"}'])('omits unavailable or invalid sitemap dates: %s', async value => {
    await bindings.SITE_BUCKET.put('pages/index.html', 'legacy HTML', { customMetadata: { manifest: 'publications/missing.json' } });
    if (value !== null) await bindings.SITE_BUCKET.put('publications/missing.json', value);
    const response = await fetch('/sitemap.xml');
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('lastmod');
  });

  it('does not hide a sitemap storage outage as an empty successful response', async () => {
    const SITE_BUCKET = { head: async () => { throw new Error('storage unavailable'); } } as unknown as R2Bucket;
    expect((await fetch('/sitemap.xml', {}, SITE.origin, SITE.origin, { SITE_BUCKET })).status).toBe(500);
  });

  it('serves a browser-mode manifest with usable icons and relative URLs on preview', async () => {
    const response = await fetch('/site.webmanifest', {}, 'https://preview.example.test', '');
    const manifest = await response.json<any>();
    expect(manifest).toMatchObject({ name: SITE.name, description: SITE.description, lang: 'en-US', id: '/', start_url: '/', scope: '/', display: 'browser', theme_color: SITE.background, background_color: SITE.background });
    expect(manifest.icons.map((icon: any) => icon.sizes)).toEqual(['192x192', '512x512']);
    expect(JSON.stringify(manifest)).not.toContain(SITE.origin);
    for (const icon of manifest.icons) expect((await fetch(icon.src)).status).toBe(200);
  });

  const pngAssets = [
    [ASSETS.social, 1200, 630], [ASSETS.favicon48, 48, 48], [ASSETS.appleTouch, 180, 180],
    [ASSETS.icon192, 192, 192], [ASSETS.icon512, 512, 512],
  ] as const;
  it.each(pngAssets)('serves %s with actual %i × %i PNG dimensions', async (path, width, height) => {
    const response = await fetch(path);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Cache-Control')).toContain('immutable');
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toContain('immutable');
    const bytes = await response.arrayBuffer();
    expect(Array.from(new Uint8Array(bytes, 0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(new DataView(bytes).getUint32(16)).toBe(width);
    expect(new DataView(bytes).getUint32(20)).toBe(height);
  });

  it('includes real 16, 32 and 48px frames in the ICO and keeps the SVG available', async () => {
    const response = await fetch(ASSETS.favicon);
    expect(response.headers.get('Content-Type')).toBe('image/x-icon');
    const bytes = await response.arrayBuffer();
    const view = new DataView(bytes);
    expect(view.getUint16(0, true)).toBe(0);
    expect(view.getUint16(2, true)).toBe(1);
    expect(view.getUint16(4, true)).toBe(3);
    for (const [i, size] of [16, 32, 48].entries()) {
      const entry = 6 + i * 16;
      expect(view.getUint8(entry)).toBe(size);
      expect(view.getUint8(entry + 1)).toBe(size);
      const offset = view.getUint32(entry + 12, true);
      expect(view.getUint32(offset + 16)).toBe(size);
      expect(view.getUint32(offset + 20)).toBe(size);
      expect(offset + view.getUint32(entry + 8, true)).toBeLessThanOrEqual(bytes.byteLength);
    }
    expect(await (await fetch('/favicon.ico')).arrayBuffer()).toEqual(bytes);
    expect((await fetch('/favicon.svg')).headers.get('Content-Type')).toBe('image/svg+xml');
  });

  it.each([
    ['/robots.txt', 'text/plain'], ['/sitemap.xml', 'application/xml'], ['/site.webmanifest', 'application/manifest+json'],
    ...Object.values(ASSETS).map(path => [path, path.endsWith('.ico') ? 'image/x-icon' : 'image/png']),
  ])('supports MIME types, HEAD, revalidation, and read-only methods for %s', async (path, type) => {
    const response = await fetch(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain(type);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const etag = response.headers.get('etag')!;
    await response.arrayBuffer();
    const head = await fetch(path, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toBe(etag);
    expect(await head.text()).toBe('');
    for (const value of [etag, `"old", ${etag}`, '*']) {
      const unchanged = await fetch(path, { headers: { 'If-None-Match': value } });
      expect(unchanged.status).toBe(304);
      expect(await unchanged.text()).toBe('');
    }
    const invalid = await fetch(path, { method: 'POST' });
    expect(invalid.status).toBe(405);
    expect(invalid.headers.get('Allow')).toBe('GET, HEAD');
    expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });

  it('does not expose artwork sources, fonts, or arbitrary asset paths', async () => {
    for (const path of ['/assets/source/icon.svg', '/assets/source/fonts/DMSans.ttf', '/assets/nope.png', '/assets/', '/publications/orphan.json']) {
      expect((await fetch(path)).status).toBe(404);
    }
  });
});
