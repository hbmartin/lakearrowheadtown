import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { appendUpdate, currentPublication, loadPost, publishDigest, rebuildHomepage } from '../src/publishing';
import { loadCatalog, stableJson } from '../src/archives';
import { createImageResolver, metadataKey } from '../src/image-metadata';
import { hashBytes } from '../src/images';
import { pageResource } from '../src/pages';
import { metadataResource } from '../src/public-metadata';
import * as social from '../src/social';
import type { ArchiveCatalog } from '../src/archives';
import type { ContentBucket, Digest, Env } from '../src/types';

const bindings = env as unknown as Env;
const origin = 'https://lakearrowhead.town';
const now = new Date('2026-10-20T18:00:00Z');
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
const digest = (name = 'First'): Digest => ({ title: 'Batch', source: 'Source', items: [{ group: 'Group', group_url: 'https://example.com/group', headline: name,
  body: 'Original body', post_url: `https://example.com/${name}`, posted_at: now.toISOString(), category: '' }] });
const bucket = (overrides: Partial<ContentBucket> = {}): ContentBucket => ({
  get: key => bindings.SITE_BUCKET.get(key), head: key => bindings.SITE_BUCKET.head(key),
  put: (key, body, options) => bindings.SITE_BUCKET.put(key, body, options), list: options => bindings.SITE_BUCKET.list(options), ...overrides,
});
function observed() {
  const reads = new Map<string, number>(); const heads = new Map<string, number>(); const writes: string[] = [];
  return { reads, heads, writes, store: bucket({ head: key => { heads.set(key, (heads.get(key) ?? 0) + 1); return bindings.SITE_BUCKET.head(key); },
    get: key => { reads.set(key, (reads.get(key) ?? 0) + 1); return bindings.SITE_BUCKET.get(key); },
    put: (key, body, options) => { writes.push(key); return bindings.SITE_BUCKET.put(key, body, options); } }) };
}
const catalog = async () => loadCatalog(bindings.SITE_BUCKET, (await currentPublication(bindings.SITE_BUCKET)).archives);
async function commitCatalog(value: ArchiveCatalog) {
  const body = stableJson(value); const key = `archive-catalogs/${await hashBytes(new TextEncoder().encode(body))}.json`;
  await bindings.SITE_BUCKET.put(key, body);
  const publication = await currentPublication(bindings.SITE_BUCKET);
  const index = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
  const manifest = `publications/${crypto.randomUUID()}.json`;
  await bindings.SITE_BUCKET.put(manifest, JSON.stringify({ ...publication, archives: key }));
  await bindings.SITE_BUCKET.put('pages/index.html', await index.text(), { httpMetadata: index.httpMetadata, customMetadata: { ...index.customMetadata, manifest, archives: key } });
}
beforeEach(async () => { vi.restoreAllMocks(); for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {}); await reset(); });

it('uses one image cache across activity days and the homepage, including unsuccessful lookups', async () => {
  const paths = ['a', 'b', 'c'].map(char => `images/${char.repeat(64)}.png`);
  await bindings.SITE_BUCKET.put(paths[0], png);
  await bindings.SITE_BUCKET.put(paths[1], 'broken image');
  const input = digest();
  input.items[0].body = paths.map(path => `![Image](/${path})`).join('\n\n');
  input.items[0].posted_at = '2026-10-19T18:00:00Z';
  const stored = { ...input, items: [{ ...input.items[0], updates: [{ group: 'Update', post_url: 'https://example.com/update', body: input.items[0].body, posted_at: now.toISOString(), received_at: now.toISOString() }] }] };
  const stats = observed();
  await publishDigest(stats.store, stored, origin, now, true);
  for (const path of paths) {
    expect(stats.reads.get(path)).toBe(1);
    expect(stats.reads.get(metadataKey(path.split('/')[1].slice(0, 64)))).toBe(1);
  }
  const resolve = createImageResolver(bindings.SITE_BUCKET, origin);
  const bad = [{ ...input.items[0], body: `![Image](/${paths[1]})` }];
  expect(await resolve(bad)).toEqual({});
  await bindings.SITE_BUCKET.put(paths[1], png);
  expect(await resolve(bad)).toEqual({});
  expect(Object.values(await createImageResolver(bindings.SITE_BUCKET, origin)(bad))).toEqual([{ width: 1, height: 1, type: 'image/png' }]);
  // The first archive-enabled publish seeds the saved week before its new view.
  const previous = await currentPublication(bindings.SITE_BUCKET);
  delete previous.archives;
  const index = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
  await bindings.SITE_BUCKET.put('publications/pre-archives.json', JSON.stringify(previous));
  await bindings.SITE_BUCKET.put('pages/index.html', await index.text(), { customMetadata: { manifest: 'publications/pre-archives.json', rss: index.customMetadata!.rss } });
  await bindings.SITE_BUCKET.delete(metadataKey('a'.repeat(64)));
  const seeding = observed();
  await publishDigest(seeding.store, digest('After seed'), origin, new Date(now.getTime() + 3600000), true);
  expect(seeding.reads.get(metadataKey('a'.repeat(64)))).toBe(1);
  expect(seeding.reads.get(paths[0])).toBe(1);
  // Seed writes update the card cache before the new view checks the same date.
  expect([...seeding.heads.keys()].filter(key => key.startsWith('assets/daily/'))).toEqual([]);
});

it('limits image work to two concurrent resolutions and shares in-flight lookups', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let active = 0; let peak = 0; let reads = 0;
  const resolve = createImageResolver(bucket({ get: async key => {
    active++; peak = Math.max(peak, active); reads++;
    try { await gate; return await bindings.SITE_BUCKET.get(key); }
    finally { active--; }
  } }), origin);
  const input = [{ ...digest().items[0], body: ['a', 'b', 'c', 'd'].map(char => `![Image](/images/${char.repeat(64)}.png)`).join('\n\n') }];
  const pending = Promise.all([resolve(input), resolve(input)]);
  try { await vi.waitFor(() => expect(active).toBe(2)); }
  finally { release(); }
  await pending;
  expect(peak).toBe(2); expect(reads).toBe(8);
});

it('reuses cards for body changes but regenerates for headlines and version changes', async () => {
  const first = await publishDigest(bindings.SITE_BUCKET, digest(), origin, now, true);
  const before = (await catalog()).days['2026-10-20'];
  const render = vi.spyOn(social, 'dailyCard'); const stats = observed();
  await appendUpdate(stats.store, first.post!.id, 0, { group: 'Update', post_url: 'https://example.com/update', body: 'New body', posted_at: now.toISOString() }, origin, now, true);
  expect(render).not.toHaveBeenCalled();
  expect((await catalog()).days['2026-10-20'].image).toBe(before.image);
  expect(stats.writes.filter(key => key.startsWith('assets/daily/'))).toEqual([]);
  const publication = await currentPublication(bindings.SITE_BUCKET);
  const ref = publication.posts[0]; const post = await loadPost(bindings.SITE_BUCKET, ref);
  post.items[0].headline = 'Corrected leading headline';
  await bindings.SITE_BUCKET.put(ref.key, JSON.stringify(post));
  await rebuildHomepage(stats.store, origin);
  expect(render).toHaveBeenCalledTimes(1);
  const updated = await catalog(); const card = updated.days['2026-10-20'].image;
  expect(card).not.toBe(before.image);
  updated.days['2026-10-20'].cardVersion = 0;
  await commitCatalog(updated);
  await bindings.SITE_BUCKET.delete(card.slice(1));
  stats.writes.length = 0;
  await rebuildHomepage(stats.store, origin);
  expect(render).toHaveBeenCalledTimes(2);
  expect(await bindings.SITE_BUCKET.head(card.slice(1))).not.toBeNull();
  expect(stats.writes.filter(key => key.startsWith('archive-days/'))).toEqual([]);
});

it('canonicalizes existing archive bytes without changing content modification dates or cards', async () => {
  expect(stableJson({ z: 1, ä: 2, A: 3, a: { z: 1, A: 2 } })).toBe('{"A":3,"a":{"A":2,"z":1},"z":1,"ä":2}');
  await publishDigest(bindings.SITE_BUCKET, digest(), origin, now, true);
  const value = await catalog(); const old = { ...value.days['2026-10-20'] };
  const body = JSON.stringify(await (await bindings.SITE_BUCKET.get(old.key))!.json(), null, 2);
  value.days['2026-10-20'].key = `archive-days/${await hashBytes(new TextEncoder().encode(body))}.json`;
  await bindings.SITE_BUCKET.put(value.days['2026-10-20'].key, body);
  await commitCatalog(value);
  const render = vi.spyOn(social, 'dailyCard');
  await rebuildHomepage(bindings.SITE_BUCKET, origin);
  const current = (await catalog()).days['2026-10-20'];
  expect(current.key).toBe(old.key); expect(current.modified).toBe(old.modified); expect(current.image).toBe(old.image);
  expect(render).not.toHaveBeenCalled();
});

it('loads the previous publication once for publish, append and rebuild', async () => {
  const first = await publishDigest(bindings.SITE_BUCKET, digest(), origin, now, true);
  for (const action of [
    (store: ContentBucket) => publishDigest(store, digest('Next'), origin, now, true),
    (store: ContentBucket) => appendUpdate(store, first.post!.id, 0, { group: 'Update', post_url: 'https://example.com/update', body: '', posted_at: now.toISOString() }, origin, now, true),
    (store: ContentBucket) => rebuildHomepage(store, origin),
  ]) {
    const key = (await bindings.SITE_BUCKET.head('pages/index.html'))!.customMetadata!.manifest;
    const stats = observed(); await action(stats.store);
    expect(stats.reads.get(key)).toBe(1);
    const index = (await bindings.SITE_BUCKET.head('pages/index.html'))!;
    expect(index.customMetadata!.archives).toBe((await currentPublication(bindings.SITE_BUCKET)).archives);
  }
});

it('reads archive pointers directly, supports legacy indexes, and rejects damaged committed pointers', async () => {
  await publishDigest(bindings.SITE_BUCKET, digest(), origin, now, true);
  const index = (await bindings.SITE_BUCKET.get('pages/index.html'))!; const html = await index.text();
  const stats = observed();
  expect((await pageResource(new Request(origin + '/2026/10/20/'), stats.store, origin))!.status).toBe(200);
  expect(stats.reads.has(index.customMetadata!.manifest)).toBe(false);
  const { archives, ...legacy } = index.customMetadata!;
  await bindings.SITE_BUCKET.put('pages/index.html', html, { customMetadata: legacy });
  expect((await pageResource(new Request(origin + '/archive/'), stats.store, origin))!.status).toBe(200);
  expect(stats.reads.get(legacy.manifest)).toBe(1);
  for (const pointer of ['', 'invalid', `archive-catalogs/${'0'.repeat(64)}.json`]) {
    await bindings.SITE_BUCKET.put('pages/index.html', html, { customMetadata: { ...legacy, archives: pointer } });
    await expect(pageResource(new Request(origin + '/archive/'), stats.store, origin)).rejects.toMatchObject({ status: 503 });
    await expect(metadataResource(new Request(origin + '/sitemap.xml'), stats.store, origin)).rejects.toMatchObject({ status: 503 });
  }
  await bindings.SITE_BUCKET.put('pages/index.html', html, { customMetadata: { ...legacy, archives } });
  await bindings.SITE_BUCKET.delete(legacy.manifest);
  expect((await pageResource(new Request(origin + '/archive/'), stats.store, origin))!.status).toBe(200);
  expect((await metadataResource(new Request(origin + '/sitemap.xml'), stats.store, origin))!.status).toBe(200);
});
