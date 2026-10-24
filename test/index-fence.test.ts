import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { decodeIndex, fencedIndexBytes, withoutIndexFence } from '../src/index-fence';
import { currentPublication, publishDigest } from '../src/publishing';
import { composeHomepageConditions } from '../src/homepage-conditions';
import type { Env } from '../src/types';

const bindings = env as unknown as Env;
const origin = 'https://lakearrowhead.town';
const publisher = () => bindings.PUBLISHER.getByName('site');
const inside = runInDurableObject as unknown as <T>(stub: unknown, callback: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
beforeEach(async () => { vi.restoreAllMocks(); await reset(); });
afterEach(() => vi.restoreAllMocks());
it.each(['<p>café</p>', '\ufeff<p>雪</p>'])('preserves UTF-8 bytes and BOM apart from the reserved fence: %s', html => {
  const encoded = new TextEncoder().encode(html);
  const result = fencedIndexBytes(encoded, { contentType: 'text/html; charset="UTF-8"' });
  expect([...result.slice(0, encoded.length)]).toEqual([...encoded]);
  expect(withoutIndexFence(decodeIndex(result))).toBe(html);
});
it.each([
  { bytes: new Uint8Array([0x3c, 0x70, 0x3e, 0xe9]), metadata: {} },
  { bytes: new TextEncoder().encode('<p>ASCII</p>'), metadata: { contentEncoding: 'gzip' } },
  { bytes: new Uint8Array([0x1f, 0x8b, 0x08, 0xff]), metadata: { contentEncoding: 'gzip' } },
  { bytes: new TextEncoder().encode('<p>ASCII</p>'), metadata: { contentType: 'text/html; charset=iso-8859-1' } },
])('rejects unsupported index representations before any repair side effects: $metadata', async ({ bytes, metadata }) => {
  await publishDigest(bindings.SITE_BUCKET, { title: 'News', source: 'Test', items: [{ group: 'Test', group_url: origin,
    headline: 'Story', body: 'Body', category: '', post_url: origin + '/story', posted_at: new Date().toISOString() }] }, origin, new Date(), true);
  const previous = (await bindings.SITE_BUCKET.head('pages/index.html'))!;
  await bindings.SITE_BUCKET.put('pages/index.html', bytes, { customMetadata: previous.customMetadata, httpMetadata: metadata });
  const index = (await bindings.SITE_BUCKET.head('pages/index.html'))!;
  const manifest = `publications/${crypto.randomUUID()}.json`;
  await bindings.SITE_BUCKET.put(manifest, JSON.stringify(await currentPublication(bindings.SITE_BUCKET)));
  const payload = { expected_version: index.version, manifest, rss: index.customMetadata!.rss, archives: index.customMetadata!.archives ?? null };
  await inside(publisher(), async (instance, state) => {
    const before = await state.storage.list();
    const get = instance.env.SITE_BUCKET.get.bind(instance.env.SITE_BUCKET);
    const sources = vi.spyOn(instance.env.SITE_BUCKET, 'get').mockImplementation((key: any) => {
      if (key !== 'pages/index.html') throw new Error('Must not hydrate target sources'); return get(key);
    });
    try { expect(await instance.publicationRepairV1(payload, origin)).toMatchObject({ ok: false, failure: {
      status: 400, code: 'invalid_repair_target', stage: 'repair_representation_validation', publication_status: 'not_committed',
      details: { reason: 'unsupported_index_representation' },
    } }); } finally { sources.mockRestore(); }
    expect(await state.storage.list()).toEqual(before); expect(await state.storage.getAlarm()).toBeNull();
  });
  expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.version).toBe(index.version);
  expect(new Uint8Array(await (await bindings.SITE_BUCKET.get('pages/index.html'))!.arrayBuffer())).toEqual(bytes);
  await expect(composeHomepageConditions(bindings.SITE_BUCKET, origin)).rejects.toMatchObject({ code: 'index_representation_unsupported' });
  expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.version).toBe(index.version);
});
it('checks HTTP metadata supplied as Headers and preserves valid BOMs', () => {
  const bytes = new TextEncoder().encode('\ufeff<p>Body</p>');
  expect(decodeIndex(bytes, new Headers({ 'Content-Type': 'text/html; charset=utf8', 'Content-Encoding': 'identity' })).startsWith('\ufeff')).toBe(true);
  expect(() => decodeIndex(bytes, new Headers({ 'Content-Encoding': 'br' }))).toThrow(/unsupported/);
});
