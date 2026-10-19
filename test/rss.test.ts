import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { SaxesParser } from 'saxes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { currentPublication, postKey, publishDigest, rebuildHomepage, HTML_CACHE } from '../src/publishing';
import { renderPage } from '../src/render';
import { renderRss, RSS_TYPE } from '../src/rss';
import { SITE } from '../src/site';
import type { ContentBucket, Digest, Env, Publication, StoredPost } from '../src/types';

const bindings = env as unknown as Env;
const now = new Date('2026-10-17T18:00:00.000Z');
const publication: Publication = { version: 1, posts: [], snapshot_date: '2026-10-17', published_at: now.toISOString() };
const digest = (headline = 'Mountain update', posted_at = now.toISOString()): Digest => ({
  title: 'Private batch title', source: 'private-source-label', items: [{
    headline, posted_at, body: '**News** from the mountain.', category: 'announcement',
    group: 'Community group', group_url: 'https://example.com/group', post_url: `https://example.com/${encodeURIComponent(headline)}`,
  }],
});
const stored = (input = digest(), id = 'private-post-id'): StoredPost => ({ ...input, id, date: '2026-10-17', received_at: now.toISOString() });
const fetch = (init: RequestInit = {}, overrides: Partial<Env> = {}, origin: string = SITE.origin, path = '/rss.xml') =>
  worker.fetch(new Request(origin + path, init), { ...bindings, ...overrides });
const publish = (input = digest()) => publishDigest(bindings.SITE_BUCKET, input, SITE.origin, now, true);
const bucketWith = (overrides: Partial<ContentBucket>): ContentBucket => ({
  get: key => bindings.SITE_BUCKET.get(key), head: key => bindings.SITE_BUCKET.head(key),
  put: (key, value, options) => bindings.SITE_BUCKET.put(key, value, options), list: options => bindings.SITE_BUCKET.list(options), ...overrides,
});

interface XmlNode { name: string; uri: string; attrs: Record<string, string>; text: string; children: XmlNode[] }
function parse(xml: string): XmlNode {
  const parser = new SaxesParser({ xmlns: true });
  const nodes: XmlNode[] = [];
  let root: XmlNode;
  parser.on('opentag', tag => {
    const node: XmlNode = { name: tag.name, uri: tag.uri, attrs: Object.fromEntries(Object.entries(tag.attributes).map(([key, attr]) => [key, attr.value])), text: '', children: [] };
    if (nodes.length) nodes.at(-1)!.children.push(node);
    else root = node;
    nodes.push(node);
  });
  parser.on('text', text => { if (nodes.length) nodes.at(-1)!.text += text; });
  parser.on('closetag', () => { nodes.pop(); });
  parser.write(xml).close(); // The parser throws on malformed XML, entities, or characters.
  return root!;
}
const child = (node: XmlNode, name: string) => node.children.find(node => node.name === name)!;
const channel = (xml: string) => child(parse(xml), 'channel');
const items = (xml: string) => channel(xml).children.filter(node => node.name === 'item');
const headlines = (xml: string) => items(xml).map(node => child(node, 'title').text);

beforeEach(async () => {
  vi.restoreAllMocks();
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
  await reset();
});

describe('RSS rendering', () => {
  it('renders a valid empty RSS channel with site metadata and a namespaced self-link', () => {
    const xml = renderRss([], { origin: SITE.origin });
    const root = parse(xml);
    expect(root.attrs.version).toBe('2.0');
    expect(root.uri).toBe('');
    const feed = child(root, 'channel');
    expect(child(feed, 'title').text).toBe(SITE.title);
    expect(child(feed, 'link').text).toBe(SITE.origin + '/');
    expect(child(feed, 'description').text).toBe(SITE.description);
    expect(child(feed, 'language').text).toBe(SITE.language);
    expect(child(feed, 'atom:link')).toMatchObject({ uri: 'http://www.w3.org/2005/Atom', attrs: { href: SITE.origin + '/rss.xml', rel: 'self', type: 'application/rss+xml' } });
    expect(items(xml)).toEqual([]);
    expect(child(feed, 'lastBuildDate')).toBeUndefined();
  });

  it('matches homepage selection and tie ordering while preserving duplicate story identities', () => {
    const input = digest();
    input.items = [
      digest('Too old', '2026-10-11T06:59:59Z').items[0],
      digest('Earlier today', '2026-10-17T09:00:00Z').items[0],
      digest('First tie').items[0], digest('Second tie').items[0], digest('Second tie').items[0],
      digest('Future day', '2026-10-18T07:00:00Z').items[0],
      digest('Oldest allowed', '2026-10-11T07:00:00Z').items[0],
    ];
    const posts = [stored(input)];
    const xml = renderRss(posts, { origin: SITE.origin, publication });
    const html = renderPage(posts, { origin: SITE.origin, publication });
    expect(headlines(xml)).toEqual([...html.matchAll(/<a class="headline-link"[^>]*>([^<]*)<\/a>/g)].map(match => match[1]));
    expect(headlines(xml)).toEqual(['First tie', 'Second tie', 'Second tie', 'Earlier today', 'Oldest allowed']);
    const guids = items(xml).map(node => child(node, 'guid'));
    expect(new Set(guids.map(node => node.text)).size).toBe(5);
    expect(guids.every(node => node.attrs.isPermaLink === 'false' && /^urn:sha256:[a-f0-9]{64}$/.test(node.text))).toBe(true);
    expect(child(channel(xml), 'lastBuildDate').text).toBe(now.toUTCString());
    expect(child(items(xml)[0], 'pubDate').text).toBe(now.toUTCString());
    expect(xml).not.toMatch(/Private batch title|private-source-label|private-post-id|received_at|publications\//);
  });

  it.each([
    ['2026-03-09', '2026-03-03T07:59:59Z', '2026-03-03T08:00:00Z', '2026-03-10T07:00:00Z'],
    ['2026-11-02', '2026-10-27T06:59:59Z', '2026-10-27T07:00:00Z', '2026-11-03T08:00:00Z'],
  ])('uses Los Angeles calendar dates across DST for the %s snapshot', (snapshot_date, old, first, future) => {
    const input = digest();
    input.items = [digest('Old', old).items[0], digest('Included', first).items[0], digest('Future', future).items[0]];
    expect(headlines(renderRss([stored(input)], { origin: SITE.origin, publication: { ...publication, snapshot_date } }))).toEqual(['Included']);
  });

  it('includes full safe HTML, images, source attribution, category, and absolute content URLs', () => {
    const input = digest();
    input.items[0].body = '**Wind** and *weather*.\n\n![Pine tree](/images/pine.png "Pine caption")\n\nCaption text.\n\n- First\n- Second\n\n[Details](updates/road?a=1&b=2) [Anchor](#news) [Email](mailto:news@example.com)\n\n<script>bad()</script> [Unsafe](javascript:alert(1))';
    const item = items(renderRss([stored(input)], { origin: SITE.origin, publication }))[0];
    const body = child(item, 'description').text;
    expect(body).toContain('<strong>Wind</strong> and <em>weather</em>');
    expect(body).toContain(`src="${SITE.origin}/images/pine.png"`);
    expect(body).toContain('alt="Pine tree" title="Pine caption"');
    expect(body).toContain('Caption text.');
    expect(body).toContain('<li>Second</li>');
    expect(body).toContain(`href="${SITE.origin}/updates/road?a=1&amp;b=2"`);
    expect(body).toContain(`href="${SITE.origin}/#news"`);
    expect(body).toContain('href="mailto:news@example.com"');
    expect(body).toContain('<a href="https://example.com/group">Community group</a>');
    expect(body).toContain(`href="${input.items[0].post_url}">View original post</a>`);
    expect(body).not.toMatch(/<script|href="javascript:/);
    expect(child(item, 'link').text).toBe(input.items[0].post_url);
    expect(child(item, 'category').text).toBe('announcement');
    expect(child(item, 'source')).toBeUndefined();
  });

  it('round-trips hostile text and Unicode while replacing XML-invalid characters', () => {
    const input = digest();
    input.items[0].headline = 'A & <tag> " \' ]]> 🌲\u0000\u0001\ud800\ufffe';
    input.items[0].group = 'Group & <group> " \' 🌲\u0002';
    input.items[0].post_url = 'https://example.com/story?a="x"&b=<tag>';
    input.items[0].body = '<script>bad()</script> & **safe** ]]> 🌲\u0003\udfff';
    input.items[0].category = '';
    const xml = renderRss([stored(input)], { origin: SITE.origin, publication });
    const item = items(xml)[0];
    expect(child(item, 'title').text).toBe('A & <tag> " \' ]]> 🌲\ufffd\ufffd\ufffd\ufffd');
    expect(child(item, 'link').text).toBe(input.items[0].post_url);
    expect(child(item, 'description').text).toContain('🌲\ufffd\ufffd');
    expect(child(item, 'description').text).not.toContain('<script>');
    expect(child(item, 'category')).toBeUndefined();
    expect(xml).not.toContain('<![CDATA[');
  });

  it('does not reject a publication because Markdown contains a malformed but safe URL', () => {
    const input = digest(); input.items[0].body = '[Malformed](http://[)';
    expect(() => parse(renderRss([stored(input)], { origin: SITE.origin, publication }))).not.toThrow();
  });
});

describe('RSS publication and serving', () => {
  it.each([false, true])('supports read-only methods, MIME, ETags, HEAD and conditional GET/HEAD (stored: %s)', async published => {
    if (published) await publish();
    const response = await fetch();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe(RSS_TYPE);
    expect(response.headers.get('Cache-Control')).toBe(HTML_CACHE);
    expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
    const etag = response.headers.get('etag')!;
    expect(etag).toMatch(/^W\/".+"$/);
    parse(await response.text());
    for (const method of ['GET', 'HEAD']) {
      for (const condition of [etag, etag.replace(/^W\//, ''), `"old", ${etag}`, '*']) {
        const unchanged = await fetch({ method, headers: { 'If-None-Match': condition } });
        expect(unchanged.status).toBe(304);
        expect(unchanged.headers.get('Content-Type')).toBe(RSS_TYPE);
        expect(unchanged.headers.get('Cache-Control')).toBe(HTML_CACHE);
        expect(unchanged.headers.get('etag')).toBe(etag);
        expect(await unchanged.text()).toBe('');
      }
      for (const condition of ['"unmatched"', 'bad', 'W/"bad" trailing', '*, "bad"', '']) {
        const changed = await fetch({ method, headers: { 'If-None-Match': condition } });
        expect(changed.status).toBe(200);
        if (method === 'HEAD') expect(await changed.text()).toBe('');
        else parse(await changed.text());
      }
    }
    const head = await fetch({ method: 'HEAD' });
    expect(head.status).toBe(200); expect(head.headers.get('etag')).toBe(etag); expect(await head.text()).toBe('');
    const rejected = await fetch({ method: 'POST' });
    expect(rejected.status).toBe(405); expect(rejected.headers.get('Allow')).toBe('GET, HEAD');
    if (!published) expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
  });

  it('publishes the same stories as HTML, preserves duplicate-only bytes, and retains dates and GUIDs on rebuild', async () => {
    await publish();
    const first = await fetch(); const etag = first.headers.get('etag')!; const xml = await first.text();
    const metadata = (await bindings.SITE_BUCKET.head('pages/index.html'))!.customMetadata!;
    expect(metadata.rss).toMatch(/^publications\/[a-f0-9-]{36}\.rss\.xml$/);
    const duplicate = await publish();
    expect(duplicate.duplicate).toBe(true);
    expect((await fetch({ headers: { 'If-None-Match': etag } })).status).toBe(304);
    expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.customMetadata).toEqual(metadata);
    expect(await (await fetch()).text()).toBe(xml);
    await rebuildHomepage(bindings.SITE_BUCKET, SITE.origin);
    expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.customMetadata!.rss).not.toBe(metadata.rss);
    expect(await (await fetch()).text()).toBe(xml);
    expect((await fetch()).headers.get('etag')).toBe(etag);
    await publish(digest('Follow-up', '2026-10-17T19:00:00Z'));
    const next = await (await fetch()).text();
    expect(headlines(next)).toEqual(['Follow-up', 'Mountain update']);
    expect(child(items(next)[1], 'guid').text).toBe(child(items(xml)[0], 'guid').text);
    expect((await fetch()).headers.get('etag')).not.toBe(etag);
  });

  it.each(['rss_write', 'index_write'] as const)('keeps HTML and RSS on the previous publication after a failed %s, including rebuilds', async stage => {
    await publish();
    const html = await (await fetch({}, {}, SITE.origin, '/')).text();
    const xml = await (await fetch()).text();
    const before = await currentPublication(bindings.SITE_BUCKET);
    const broken = bucketWith({ put: async (key, value, options) => {
      if ((stage === 'rss_write' && key.endsWith('.rss.xml')) || (stage === 'index_write' && key === 'pages/index.html')) throw new Error('Injected failure');
      return bindings.SITE_BUCKET.put(key, value, options);
    } });
    await expect(publishDigest(broken, digest('Uncommitted'), SITE.origin, now, true)).rejects.toMatchObject({ stage, publication_status: stage === 'index_write' ? 'unknown' : 'not_committed' });
    await expect(rebuildHomepage(broken, SITE.origin)).rejects.toBeDefined();
    expect(await currentPublication(bindings.SITE_BUCKET)).toEqual(before);
    expect(await (await fetch({}, {}, SITE.origin, '/')).text()).toBe(html);
    expect(await (await fetch()).text()).toBe(xml);
    await rebuildHomepage(bindings.SITE_BUCKET, SITE.origin);
    expect(await (await fetch()).text()).toBe(xml);
    expect((await publish(digest('Uncommitted'))).counts.published).toBe(1);
  });

  it('commits both representations even when the index write acknowledgement is lost', async () => {
    const broken = bucketWith({ put: async (key, value, options) => {
      const result = await bindings.SITE_BUCKET.put(key, value, options);
      if (key === 'pages/index.html') throw new Error('Lost acknowledgement');
      return result;
    } });
    await expect(publishDigest(broken, digest(), SITE.origin, now, true)).rejects.toMatchObject({ publication_status: 'unknown' });
    expect(headlines(await (await fetch()).text())).toEqual(['Mountain update']);
    expect(await (await fetch({}, {}, SITE.origin, '/')).text()).toContain('Mountain update');
    expect((await publish()).duplicate).toBe(true);
  });

  it('keeps materialized RSS available after source damage and omits damaged stories only on a new publication', async () => {
    const first = await publish();
    const xml = await (await fetch()).text();
    await bindings.SITE_BUCKET.delete(postKey(first.post!));
    expect(await (await fetch()).text()).toBe(xml);
    await publish(digest('Healthy story'));
    expect(headlines(await (await fetch()).text())).toEqual(['Healthy story']);
  });

  it('returns 503 for old HTML or a missing committed RSS object until a rebuild completes', async () => {
    await bindings.SITE_BUCKET.put('pages/index.html', 'Old HTML');
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch({ method, headers: { 'If-None-Match': '*' } });
      expect(response.status).toBe(503); expect(response.headers.get('Retry-After')).toBe('60');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      if (method === 'HEAD') expect(await response.text()).toBe('');
    }
    await rebuildHomepage(bindings.SITE_BUCKET, SITE.origin);
    expect((await fetch()).status).toBe(200);
    const key = (await bindings.SITE_BUCKET.head('pages/index.html'))!.customMetadata!.rss;
    await bindings.SITE_BUCKET.delete(key);
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch({ method, headers: { 'If-None-Match': '*' } });
      expect(response.status).toBe(503); expect(response.headers.get('Retry-After')).toBe('60');
      if (method === 'HEAD') expect(await response.text()).toBe('');
    }
    await rebuildHomepage(bindings.SITE_BUCKET, SITE.origin);
    expect((await fetch()).status).toBe(200);
    expect(items(await (await fetch()).text())).toEqual([]);
  });

  it.each([
    ['https://preview.example.test', ''], ['http://localhost:8787', ''],
    ['https://alternate.example.workers.dev', SITE.origin],
  ])('uses the publication origin and applies noindex for %s to empty/stored responses and 304s', async (origin, SITE_ORIGIN) => {
    const configured = { SITE_ORIGIN };
    for (const published of [false, true]) {
      if (published) await publishDigest(bindings.SITE_BUCKET, digest(), SITE_ORIGIN || origin, now, true);
      const response = await fetch({}, configured, origin);
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
      const etag = response.headers.get('etag')!;
      expect(child(channel(await response.text()), 'link').text).toBe((SITE_ORIGIN || origin) + '/');
      for (const method of ['GET', 'HEAD']) {
        const unchanged = await fetch({ method, headers: { 'If-None-Match': etag } }, configured, origin);
        expect(unchanged.status).toBe(304); expect(unchanged.headers.get('X-Robots-Tag')).toBe('noindex');
        expect(await unchanged.text()).toBe('');
      }
    }
  });

  it('serves stored RSS with an invalid origin but requires a valid origin for the empty fallback', async () => {
    const configured = { SITE_ORIGIN: 'not an origin' };
    expect((await fetch({}, configured)).status).toBe(503);
    await publish();
    const xml = await (await fetch()).text();
    const response = await fetch({}, configured);
    expect(response.status).toBe(200); expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(await response.text()).toBe(xml);
    const unchanged = await fetch({ method: 'HEAD', headers: { 'If-None-Match': response.headers.get('etag')! } }, configured);
    expect(unchanged.status).toBe(304); expect(unchanged.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('propagates storage errors instead of serving a false empty feed and keeps storage paths private', async () => {
    await publish();
    const key = (await bindings.SITE_BUCKET.head('pages/index.html'))!.customMetadata!.rss;
    const SITE_BUCKET = bucketWith({ get: async () => { throw new Error('Private storage details'); } }) as R2Bucket;
    const failed = await fetch({}, { SITE_BUCKET });
    expect(failed.status).toBe(500); expect(await failed.text()).not.toContain('Private storage details');
    for (const path of ['/' + key, '/publications/', '/pages/rss.xml']) expect((await fetch({}, {}, SITE.origin, path)).status).toBe(404);
  });

  it('adds exactly one autodiscovery link and a visible footer subscription link to empty/published/rebuilt pages', async () => {
    for (const state of ['empty', 'published', 'rebuilt']) {
      if (state === 'published') await publish();
      if (state === 'rebuilt') await rebuildHomepage(bindings.SITE_BUCKET, SITE.origin);
      const html = await (await fetch({}, {}, SITE.origin, '/')).text();
      const head = html.split('</head>')[0];
      expect(head.match(/rel="alternate" type="application\/rss\+xml"/g)).toHaveLength(1);
      expect(head).toContain(`href="${SITE.origin}/rss.xml"`);
      expect(html.split('<footer>')[1].split('</footer>')[0]).toContain('<a href="/rss.xml">RSS feed</a>');
    }
  });
});
