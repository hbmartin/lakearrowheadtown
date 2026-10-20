import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { currentPublication, loadPublication, publishDigest, rebuildHomepage } from '../src/publishing';
import { loadCatalog, stableJson, type ArchiveCatalog, type ArchiveDay } from '../src/archives';
import { hashBytes } from '../src/images';
import { dimensions } from '../src/image-metadata';
import { pageResource } from '../src/pages';
import { metadataResource } from '../src/public-metadata';
import * as social from '../src/social';
import type { ContentBucket, Digest, Env } from '../src/types';

const bindings = env as unknown as Env;
const origin = 'https://lakearrowhead.town';
const now = new Date('2026-10-20T18:00:00.000Z');
const digest = (name = 'First', posted_at = now.toISOString()): Digest => ({ title: 'Batch', source: 'Groups', items: [{
  group: 'Community', group_url: 'https://example.com/group', headline: name, body: 'News', category: '',
  post_url: `https://example.com/${encodeURIComponent(name)}`, posted_at,
}] });
const store = (overrides: Partial<ContentBucket> = {}): ContentBucket => ({
  get: key => bindings.SITE_BUCKET.get(key), head: key => bindings.SITE_BUCKET.head(key),
  put: (key, body, options) => bindings.SITE_BUCKET.put(key, body, options), list: options => bindings.SITE_BUCKET.list(options), ...overrides,
});
const catalog = async () => loadCatalog(bindings.SITE_BUCKET, (await currentPublication(bindings.SITE_BUCKET)).archives);
async function saveJson(prefix: string, value: unknown) {
  const body = stableJson(value);
  const key = `${prefix}/${await hashBytes(new TextEncoder().encode(body))}.json`;
  await bindings.SITE_BUCKET.put(key, body);
  return key;
}
async function commitCatalog(value: ArchiveCatalog, directOnly = false) {
  const archives = await saveJson('archive-catalogs', value);
  const index = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
  const metadata: Record<string, string> = { ...index.customMetadata!, archives };
  if (!directOnly) {
    const publication = await loadPublication(bindings.SITE_BUCKET, metadata.manifest);
    metadata.manifest = `publications/${crypto.randomUUID()}.json`;
    await bindings.SITE_BUCKET.put(metadata.manifest, JSON.stringify({ ...publication, archives }));
  }
  await bindings.SITE_BUCKET.put('pages/index.html', await index.text(), { httpMetadata: index.httpMetadata, customMetadata: metadata });
  return archives;
}
beforeEach(async () => { vi.restoreAllMocks(); for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {}); await reset(); });

it('repairs a missing PNG without a version bump or a content modification', async () => {
  await publishDigest(bindings.SITE_BUCKET, digest(), origin, now, true);
  const before = (await catalog()).days['2026-10-20'];
  const png = (await bindings.SITE_BUCKET.get(before.image.slice(1)))!;
  expect(png.customMetadata?.cardInputHash).toBe(await hashBytes(new TextEncoder().encode(stableJson(['2026-10-20', 'First', social.DAILY_CARD_VERSION]))));
  await bindings.SITE_BUCKET.delete(before.image.slice(1));
  const render = vi.spyOn(social, 'dailyCard');
  const put = vi.fn(store().put); const head = vi.fn(store().head);
  await rebuildHomepage(store({ put, head }), origin);
  expect(render).toHaveBeenCalledTimes(1);
  expect((await catalog()).days['2026-10-20']).toEqual(before);
  const repaired = (await bindings.SITE_BUCKET.get(before.image.slice(1)))!;
  expect(dimensions(new Uint8Array(await repaired.arrayBuffer()))).toMatchObject({ width: 1200, height: 630, type: 'image/png' });
  expect(repaired.customMetadata?.cardInputHash).toBe(png.customMetadata?.cardInputHash);
  expect(put.mock.calls.filter(([key]) => key.startsWith('archive-days/'))).toHaveLength(0);
  expect(head.mock.calls.filter(([key]) => key === before.image.slice(1))).toHaveLength(1);
  put.mockClear(); render.mockClear();
  await rebuildHomepage(store({ put }), origin);
  expect(render).not.toHaveBeenCalled();
  expect(put.mock.calls.filter(([key]) => /^(archive-|assets\/daily\/)/.test(key))).toHaveLength(0);
});

it.each([undefined, 'wrong-input'])('refreshes a legacy or stale PNG fingerprint once: %s', async cardInputHash => {
  await publishDigest(bindings.SITE_BUCKET, digest(), origin, now, true);
  const before = (await catalog()).days['2026-10-20'];
  const png = (await bindings.SITE_BUCKET.get(before.image.slice(1)))!;
  await bindings.SITE_BUCKET.put(png.key, await png.arrayBuffer(), { httpMetadata: png.httpMetadata,
    ...(cardInputHash === undefined ? {} : { customMetadata: { cardInputHash } }) });
  const render = vi.spyOn(social, 'dailyCard');
  await rebuildHomepage(bindings.SITE_BUCKET, origin);
  expect(render).toHaveBeenCalledTimes(1);
  expect((await catalog()).days['2026-10-20']).toEqual(before);
  await rebuildHomepage(bindings.SITE_BUCKET, origin);
  expect(render).toHaveBeenCalledTimes(1);
});

it('repairs a manually changed historical headline and later a lost historical PNG using independent snapshots', async () => {
  const first = await publishDigest(bindings.SITE_BUCKET, digest(), origin, now, true);
  const source = (await currentPublication(bindings.SITE_BUCKET)).posts[0].key;
  const future = new Date('2026-12-01T18:00:00.000Z');
  await publishDigest(bindings.SITE_BUCKET, digest('Future', future.toISOString()), origin, future, true);
  expect((await currentPublication(bindings.SITE_BUCKET)).posts.some(ref => ref.id === first.post!.id)).toBe(false);
  await bindings.SITE_BUCKET.delete(source);
  const value = await catalog(); const old = { ...value.days['2026-10-20'] };
  const day = await (await bindings.SITE_BUCKET.get(old.key))!.json<ArchiveDay>();
  day.stories[0].item.headline = 'Repaired historical headline';
  value.days['2026-10-20'].key = await saveJson('archive-days', day);
  value.days['2026-10-20'].modified = '2026-11-30T18:00:00.000Z';
  await commitCatalog(value);
  const render = vi.spyOn(social, 'dailyCard'); const head = vi.fn(store().head);
  await publishDigest(store({ head }), digest('Another future', future.toISOString()), origin, future, true);
  expect(render).not.toHaveBeenCalled();
  expect(head.mock.calls.some(([key]) => key === old.image.slice(1))).toBe(false);
  await rebuildHomepage(bindings.SITE_BUCKET, origin);
  expect(render).toHaveBeenCalledExactlyOnceWith('2026-10-20', 'Repaired historical headline');
  const repaired = (await catalog()).days['2026-10-20'];
  expect(repaired.image).not.toBe(old.image);
  expect(repaired.key).toBe(value.days['2026-10-20'].key);
  expect(repaired.modified).toBe(value.days['2026-10-20'].modified);
  await bindings.SITE_BUCKET.delete(repaired.image.slice(1));
  await rebuildHomepage(bindings.SITE_BUCKET, origin);
  expect(render).toHaveBeenCalledTimes(2);
  expect(await bindings.SITE_BUCKET.head(repaired.image.slice(1))).not.toBeNull();
  expect((await catalog()).days['2026-10-20']).toEqual(repaired);
});

it.each(['publish', 'rebuild'] as const)('uses a divergent direct pointer as authority during %s', async operation => {
  await publishDigest(bindings.SITE_BUCKET, digest(), origin, now, true);
  const value = await catalog();
  value.days['2026-09-01'] = { ...value.days['2026-10-20'], key: await saveJson('archive-days', { date: '2026-09-01', stories: [], images: {} }), identities: [] };
  const direct = await commitCatalog(value, true);
  expect((await currentPublication(bindings.SITE_BUCKET)).archives).toBe(direct);
  expect(await (await pageResource(new Request(origin + '/archive/'), bindings.SITE_BUCKET, origin))!.text()).toContain('/2026/09/01/');
  expect(await (await metadataResource(new Request(origin + '/sitemap.xml'), bindings.SITE_BUCKET, origin))!.text()).toContain('/2026/09/01/');
  const head = vi.fn(store().head); const get = vi.fn(store().get);
  if (operation === 'publish') await publishDigest(store({ head, get }), digest('Next'), origin, now, true);
  else await rebuildHomepage(store({ head, get }), origin);
  expect(head.mock.calls.filter(([key]) => key === 'pages/index.html')).toHaveLength(1);
  expect((await catalog()).days['2026-09-01']).toBeDefined();
  const index = (await bindings.SITE_BUCKET.head('pages/index.html'))!;
  expect((await loadPublication(bindings.SITE_BUCKET, index.customMetadata!.manifest)).archives).toBe(index.customMetadata!.archives);
});

it('keeps failed pointer reconciliation and card repairs behind the index commit', async () => {
  await publishDigest(bindings.SITE_BUCKET, digest(), origin, now, true);
  const value = await catalog();
  value.days['2026-09-01'] = { ...value.days['2026-10-20'], key: await saveJson('archive-days', { date: '2026-09-01', stories: [], images: {} }), identities: [] };
  const direct = await commitCatalog(value, true);
  const before = (await bindings.SITE_BUCKET.head('pages/index.html'))!;
  const failing = store({ put: async (key, body, options) => {
    if (key === 'pages/index.html') throw new Error('Injected index failure');
    return bindings.SITE_BUCKET.put(key, body, options);
  } });
  await expect(publishDigest(failing, digest('Uncommitted', '2026-10-21T18:00:00.000Z'), origin, new Date('2026-10-21T18:00:00.000Z'), true)).rejects.toBeDefined();
  expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.etag).toBe(before.etag);
  expect((await currentPublication(bindings.SITE_BUCKET)).archives).toBe(direct);
  expect(await pageResource(new Request(origin + '/2026/10/21/'), bindings.SITE_BUCKET, origin)).toBeUndefined();
  expect(await (await metadataResource(new Request(origin + '/sitemap.xml'), bindings.SITE_BUCKET, origin))!.text()).not.toContain('/2026/10/21/');
  await expect(rebuildHomepage(store({ head: async key => {
    if (key.startsWith('assets/daily/')) throw new Error('Injected card read failure');
    return bindings.SITE_BUCKET.head(key);
  } }), origin)).rejects.toMatchObject({ kind: 'storage' });
  expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.etag).toBe(before.etag);
});

it.each([null, 'not JSON', '{}', '{"version":2,"posts":"broken"}'])('returns consistent public 503s for unusable fallback manifests: %s', async content => {
  await bindings.SITE_BUCKET.put('pages/index.html', 'Legacy index', { customMetadata: { manifest: 'publications/bad.json' } });
  if (content !== null) await bindings.SITE_BUCKET.put('publications/bad.json', content);
  for (const path of ['/archive/', '/2026/10/20/', '/sitemap.xml']) for (const method of ['GET', 'HEAD']) {
    const response = await worker.fetch(new Request(origin + path, { method, headers: { 'If-None-Match': '*' } }), bindings);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    if (method === 'HEAD') expect(await response.text()).toBe('');
    else expect(await response.json()).toEqual({ ok: false, error: 'News archives are temporarily unavailable. Please try again later.' });
  }
});

it('rejects invalid direct pointers before publication writes instead of falling back', async () => {
  await publishDigest(bindings.SITE_BUCKET, digest(), origin, now, true);
  const index = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
  await bindings.SITE_BUCKET.put('pages/index.html', await index.text(), { customMetadata: { ...index.customMetadata, archives: 'bad-pointer' } });
  const put = vi.fn(store().put);
  await expect(publishDigest(store({ put }), digest('Next'), origin, now, true)).rejects.toMatchObject({ cause: { status: 503 } });
  expect(put).not.toHaveBeenCalled();
});
