import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { dimensions, metadataKey, type ImageMetadata } from '../src/image-metadata';
import { IMAGE_CACHE } from '../src/images';
import { responsiveThumbnail, thumbnailWidth, THUMBNAIL_EDGES } from '../src/thumbnail-sizes';
import { acceptsWebp } from '../src/thumbnails';
import { renderArchivePage, renderPage } from '../src/render';
import { renderRss } from '../src/rss';
import type { Env, StoredPost } from '../src/types';
import transparentPng from './fixtures/thumbnail-transparent.png';

const bindings = env as unknown as Env;
const origin = 'https://lakearrowhead.town';
const hash = 'a'.repeat(64);
const imageUrl = `${origin}/images/${hash}.jpg`;
const path = `/thumbnails/v1/${hash}.jpg/160`;
const landscape: ImageMetadata = { width: 1920, height: 1280, type: 'image/jpeg' };
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
const fetch = (url = path, init: RequestInit = {}, overrides: Partial<Env> = {}) => worker.fetch(new Request(origin + url, init), { ...bindings, ...overrides });
const source = async (metadata: ImageMetadata = landscape, extension = 'jpg') => {
  await bindings.SITE_BUCKET.put(`images/${hash}.${extension}`, png);
  await bindings.SITE_BUCKET.put(metadataKey(hash), JSON.stringify(metadata));
};
function encoder(error?: unknown) {
  const transform = vi.fn();
  const output = vi.fn(async (options: ImageOutputOptions) => {
    if (error) throw error;
    return { response: ({ headers }: ImageTransformationResponseOptions = {}) => {
      const result = new Headers(headers);
      result.set('Content-Type', options.format);
      return new Response(png, { headers: result });
    } };
  });
  const input = vi.fn((stream: ReadableStream<Uint8Array>) => {
    // A real encoder consumes the input. Read it to catch locked-stream mistakes.
    transform.mockImplementation(() => ({ output: async (options: ImageOutputOptions) => { await new Response(stream).arrayBuffer(); return output(options); } }));
    return { transform };
  });
  return { IMAGES: { input } as unknown as ImagesBinding, input, transform, output };
}
beforeEach(async () => {
  await reset();
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('responsive thumbnail geometry', () => {
  it.each([
    [1920, 1280, [96, 160, 192, 288, 320, 480], '96px, 160px'],
    [1280, 1920, [64, 106, 128, 192, 213, 320], '64px, 106.6667px'],
    [800, 800, [96, 160, 192, 288, 320, 480], '96px, 160px'],
    [30, 20, [30, 30, 30, 30, 30, 30], '30px, 30px'],
  ])('matches a %sx%s source to its layout and integer output widths', (width, height, expected, sizes) => {
    const size = { width, height, type: 'image/jpeg' };
    expect(THUMBNAIL_EDGES.map(edge => thumbnailWidth(size, edge))).toEqual(expected);
    const thumbnail = responsiveThumbnail(imageUrl, origin, size)!;
    expect(thumbnail.src).toBe(`${origin}/thumbnails/v2/${hash}.jpg/${Math.max(width, height) < 96 ? 96 : 160}.jpg`);
    expect(thumbnail.sizes).toBe(`(max-width: 600px) ${sizes}`);
    const descriptors = thumbnail.srcset.split(', ').map(candidate => Number(candidate.match(/ (\d+)w$/)![1]));
    expect(descriptors).toEqual([...new Set(expected)]);
  });
  it('uses EXIF-oriented dimensions for portrait thumbnails', () => {
    const exif = [69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0];
    const size = dimensions(new Uint8Array([255,216,255,225,0,34,...exif,255,192,0,17,8,0,2,0,3,3,1,17,0,2,17,0,3,17,0]));
    expect(size).toMatchObject({ width: 2, height: 3 });
    expect(responsiveThumbnail(imageUrl, origin, size)!.sizes).toBe('(max-width: 600px) 2px, 2px');
  });
  it.each([imageUrl.replace(origin, 'https://other.example'), imageUrl + '?v=1', imageUrl + '#fragment', `${origin}/images/photo.jpg`])('leaves noncanonical or external URLs alone: %s', url => {
    expect(responsiveThumbnail(url, origin, landscape)).toBeUndefined();
  });
  it('requires known valid dimensions', () => {
    expect(responsiveThumbnail(imageUrl, origin)).toBeUndefined();
    expect(responsiveThumbnail(imageUrl, origin, { ...landscape, width: 0 })).toBeUndefined();
  });
});

describe('responsive article rendering', () => {
  it('covers homepage, archive and updates while preserving originals in RSS and stored bodies', () => {
    const post: StoredPost = { id: 'test', title: 'News', source: 'test', date: '2026-10-22', received_at: '2026-10-22T12:00:00Z', items: [{
      headline: 'Community story', category: 'announcement', group: 'Community', group_url: 'https://example.com/group', post_url: 'https://example.com/story',
      posted_at: '2026-10-22T12:00:00Z', body: `![Photo & caption](${imageUrl})\n\nStory.\n\n![Remote](https://example.com/remote.jpg)`,
      updates: [{ group: 'Update', post_url: 'https://example.com/update', posted_at: '2026-10-22T13:00:00Z', received_at: '2026-10-22T13:00:00Z', body: `![Follow-up](${imageUrl})` }],
    }] };
    const images = { [imageUrl]: landscape };
    const html = renderPage([post], { origin, images });
    expect(html).toContain('src="' + origin + `/thumbnails/v2/${hash}.jpg/160.jpg` + '"');
    expect(html).toContain('alt="Photo &amp; caption" width="1920" height="1280"');
    expect(html.match(/srcset=/g)).toHaveLength(4);
    expect(html.match(/loading="eager"/g)).toHaveLength(1);
    expect(html.match(/loading="lazy"/g)).toHaveLength(2);
    expect(html).toContain('<img src="https://example.com/remote.jpg" alt="Remote" loading="lazy" decoding="async">');
    expect(html).toContain('href="https://example.com/story" rel="noopener noreferrer"><picture>');
    const archive = renderArchivePage(origin, { date: post.date, images, stories: [{ item: post.items[0], itemIndex: 0, timestamp: Date.parse(post.received_at), postId: post.id, date: post.date, activity: post.received_at }] },
      { key: 'archive-days/test.json', image: '/assets/daily/test.png', identities: [] });
    expect(archive.match(/srcset=/g)).toHaveLength(4);
    const rss = renderRss([post], { origin, images });
    expect(rss).toContain(imageUrl);
    expect(rss).not.toContain('/thumbnails/');
    expect(post.items[0].body).toContain(imageUrl);
  });
});

describe('thumbnail serving', () => {
  it.each([
    [null, false], ['*/*', false], ['image/*', false], ['image/avif,image/webp,*/*;q=0.8', true],
    ['image/webp;q=0', false], ['image/webp;q=0,*/*;q=1', false], ['image/webp;q=0.5', true],
    ['IMAGE/WEBP;Q=0.8', true], ['image/webp;q=garbage', false], ['image/webp;q=0,image/webp;q=1', false],
  ])('negotiates explicit WebP support in %s', (accept, expected) => expect(acceptsWebp(accept)).toBe(expected));
  it('honors relative quality and wildcard specificity when choosing between source and WebP', () => {
    expect(acceptsWebp('image/jpeg;q=1,image/webp;q=0.5', 'image/jpeg')).toBe(false);
    expect(acceptsWebp('image/jpeg;q=0.2,image/webp;q=0.5', 'image/jpeg')).toBe(true);
    expect(acceptsWebp('image/*;q=1,image/webp;q=0.5', 'image/jpeg')).toBe(false);
    expect(acceptsWebp('image/jpeg;q=0,image/*;q=1,image/webp;q=0.5', 'image/jpeg')).toBe(true);
  });

  it('transforms R2 bytes, varies cache and ETags by encoding, and handles HEAD/304', async () => {
    await source();
    const mock = encoder();
    const webp = await fetch(path, { headers: { Accept: 'image/webp' } }, mock);
    expect(webp.status).toBe(200);
    expect(webp.headers.get('Content-Type')).toBe('image/webp');
    expect(webp.headers.get('Vary')).toBe('Accept');
    expect(webp.headers.get('Cache-Control')).toBe(IMAGE_CACHE);
    expect(webp.headers.get('Cloudflare-CDN-Cache-Control')).toBe(IMAGE_CACHE);
    expect(mock.transform).toHaveBeenCalledWith({ width: 160, fit: 'scale-down' });
    expect(mock.output).toHaveBeenCalledWith({ format: 'image/webp', quality: 80, anim: true });
    await webp.arrayBuffer();
    const jpeg = await fetch(path, {}, mock);
    expect(jpeg.headers.get('Content-Type')).toBe('image/jpeg');
    expect(jpeg.headers.get('ETag')).not.toBe(webp.headers.get('ETag'));
    await jpeg.arrayBuffer();
    const unchanged = await fetch(path, { headers: { Accept: 'image/webp', 'If-None-Match': webp.headers.get('ETag')! } }, mock);
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get('Vary')).toBe('Accept');
    expect(mock.output).toHaveBeenCalledTimes(2);
    const changedFormat = await fetch(path, { headers: { 'If-None-Match': webp.headers.get('ETag')! } }, mock);
    expect(changedFormat.status).toBe(200);
    await changedFormat.arrayBuffer();
    const head = await fetch(path, { method: 'HEAD' }, mock);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('ETag')).toBe(jpeg.headers.get('ETag'));
  });
  it.each(['png', 'webp', 'gif'])('retains %s encoding and animation when WebP is not accepted', async extension => {
    await source({ ...landscape, type: `image/${extension}` }, extension);
    const mock = encoder();
    const response = await fetch(path.replace('.jpg', '.' + extension), {}, mock);
    expect(response.headers.get('Content-Type')).toBe(`image/${extension}`);
    expect(mock.output).toHaveBeenCalledWith({ format: `image/${extension}`,
      ...(extension !== 'gif' ? { quality: 80 } : {}), ...(extension !== 'png' ? { anim: true } : {}) });
    await response.arrayBuffer();
  });
  it('discovers absent or damaged metadata without writing and never upscales', async () => {
    await source();
    for (const metadata of [null, 'not json', '{"width":0}']) {
      if (metadata === null) await bindings.SITE_BUCKET.delete(metadataKey(hash));
      else await bindings.SITE_BUCKET.put(metadataKey(hash), metadata);
      const mock = encoder();
      const response = await fetch(path, {}, mock);
      expect(response.status).toBe(200);
      expect(mock.transform).toHaveBeenCalledWith({ width: 1, fit: 'scale-down' });
      await response.arrayBuffer();
      const saved = await bindings.SITE_BUCKET.get(metadataKey(hash));
      expect(saved ? await saved.text() : null).toBe(metadata);
    }
  });
  it.each([9422, 9412, undefined])('redirects encoder failure %s without caching it, then recovers', async code => {
    await source();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failed = encoder(Object.assign(new Error('Private upstream detail'), code ? { code } : {}));
    const response = await fetch(path, {}, failed);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(`/images/${hash}.jpg`);
    for (const header of ['Cache-Control', 'Cloudflare-CDN-Cache-Control', 'CDN-Cache-Control', 'Surrogate-Control']) expect(response.headers.get(header)).toBe('no-store');
    expect(response.headers.has('ETag')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'thumbnail_fallback', edge: 160,
      reason: code === 9422 ? 'quota_exhausted' : 'transformation_failed' }));
    const recovered = await fetch(path, {}, encoder());
    expect(recovered.status).toBe(200);
    await recovered.arrayBuffer();
  });
  it('falls back when binding is unavailable but preserves missing-original 404s', async () => {
    expect((await fetch(path, {}, { IMAGES: undefined })).status).toBe(404);
    await source();
    expect((await fetch(path, { method: 'HEAD' }, { IMAGES: undefined })).status).toBe(302);
  });
  it('encodes a real PNG through the offline Images binding without upscaling', async () => {
    await bindings.SITE_BUCKET.put(`images/${hash}.png`, transparentPng);
    const response = await fetch(path.replace('.jpg', '.png'), { headers: { Accept: 'image/webp' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    expect(dimensions(new Uint8Array(await response.arrayBuffer()))).toMatchObject({ width: 64, height: 48, type: 'image/webp' });
  });
  it('rejects invalid routes and query strings before accessing R2 or Images', async () => {
    const get = vi.fn(() => { throw new Error('Must not read storage'); });
    const mock = encoder();
    for (const url of [path + '?quality=1', path.replace('/160', '/161'), path.replace('/v1/', '/v2/'), path.replace('.jpg', '.svg'), path.replace(hash, 'bad')]) {
      expect((await fetch(url, {}, { ...mock, SITE_BUCKET: { get } as unknown as R2Bucket })).status).toBe(404);
    }
    expect(get).not.toHaveBeenCalled();
    expect(mock.input).not.toHaveBeenCalled();
    expect((await fetch(path, { method: 'POST' }, mock)).status).toBe(405);
  });
});

it('serves canonical v2 formats independently of Accept and skips source bodies for HEAD and 304', async () => {
  await source(); const mock = encoder(); const v2 = `/thumbnails/v2/${hash}.jpg/160.webp`;
  for (const Accept of ['image/webp;q=0', 'application/arbitrary', 'image/jpeg']) {
    const response = await fetch(v2, { headers: { Accept } }, mock); expect(response.headers.get('content-type')).toBe('image/webp'); expect(response.headers.get('vary')).toBeNull(); await response.arrayBuffer();
  }
  const full = await fetch(v2, {}, mock); const etag = full.headers.get('etag')!; await full.arrayBuffer();
  const get = vi.fn((key: string) => { if (key.startsWith('images/')) throw new Error('Original body must not load'); return bindings.SITE_BUCKET.get(key); });
  const store = new Proxy(bindings.SITE_BUCKET, { get(target, property) { if (property === 'get') return get; const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; } });
  const count = mock.output.mock.calls.length;
  expect((await fetch(v2, { method: 'HEAD' }, { ...mock, SITE_BUCKET: store })).status).toBe(200);
  expect((await fetch(v2, { headers: { 'If-None-Match': etag } }, { ...mock, SITE_BUCKET: store })).status).toBe(304);
  expect(mock.output).toHaveBeenCalledTimes(count);
  expect((await fetch(v2.replace('.webp', '.png'), {}, mock)).status).toBe(404);
});
