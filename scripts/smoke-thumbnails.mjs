import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageSize } from 'image-size';
import { createSmokeContext } from './smoke-support.mjs';
import { maintenanceTarget } from './maintenance.mjs';
import { reportFailure, ValidationError } from './validation-errors.mjs';

export const THUMBNAIL_ARTIFACT_LIMIT = 1024 * 1024;
export async function thumbnailBytes(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new ValidationError('thumbnail_empty', 'Thumbnail response has no image body');
  const parts = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > THUMBNAIL_ARTIFACT_LIMIT) throw new ValidationError('thumbnail_oversized', 'Thumbnail artifact exceeds 1 MiB');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(parts, size);
}

// Writes fixtures only to the allowlisted preview environment, never production.
export async function smokeThumbnails(args = process.argv.slice(2), options = {}) {
const origin = maintenanceTarget('preview', args[0]);
if (new URL(origin).hostname === 'localhost') throw new Error('Thumbnail acceptance requires the deployed preview Images binding and Workers Cache');
const context = createSmokeContext(origin, { ...options, artifactName: 'thumbnails' });
const result = await context.run(async () => {
const fetch = context.request; const auth = context.headers;
const directory = options.artifactsDirectory ?? await mkdtemp(join(tmpdir(), 'lakearrowhead-thumbnails-'));
if (options.artifactsDirectory) await mkdir(directory, { recursive: true });
const photo = await readFile(new URL('../test/fixtures/thumbnail-pattern.jpg', import.meta.url));
assert.deepEqual(imageSize(photo), { width: 1920, height: 1280, type: 'jpg' });
const fixtures = [
  { name: 'photo', extension: 'jpg', type: 'image/jpeg', bytes: photo },
  { name: 'transparent', extension: 'png', type: 'image/png', bytes: await readFile(new URL('../test/fixtures/thumbnail-transparent.png', import.meta.url)) },
  { name: 'animated', extension: 'gif', type: 'image/gif', bytes: await readFile(new URL('../test/fixtures/thumbnail-animated.gif', import.meta.url)) },
];
function chunks(bytes) {
  const result = [];
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    result.push({ type: bytes.toString('ascii', offset, offset + 4), data: bytes.subarray(offset + 8, offset + 8 + size) });
    offset += 8 + size + size % 2;
  }
  return result;
}
const thumbnail = (fixture, edge, format = 'webp') => `${origin}/thumbnails/v2/${fixture.url.split('/').at(-1)}/${edge}.${format}`;
for (const fixture of fixtures) {
  const form = new FormData();
  form.append('file', new File([fixture.bytes], `${fixture.name}.${fixture.extension}`, { type: fixture.type }));
  const response = await fetch(`${origin}/api/images`, { method: 'POST', headers: auth, body: form });
  assert.equal(response.status, 200);
  const upload = await response.json();
  assert.equal(new URL(upload.url).origin, origin);
  fixture.url = upload.url;
  const url = thumbnail(fixture, 480);
  const modern = await fetch(url, { headers: { Accept: 'image/webp' }, redirect: 'manual' });
  assert.equal(modern.status, 200, `Expected optimized ${fixture.name}, got ${modern.status}`);
  assert.equal(modern.headers.get('content-type'), 'image/webp');
  assert(!modern.headers.get('vary')?.split(',').some(value => value.trim().toLowerCase() === 'accept'));
  const bytes = await thumbnailBytes(modern);
  const encoded = imageSize(bytes);
  assert.equal(encoded.type, 'webp', 'Thumbnail bytes must be WebP');
  const scale = Math.min(1, 480 / Math.max(upload.width, upload.height));
  assert.equal(encoded.width, Math.max(1, Math.floor(upload.width * scale)));
  assert.equal(encoded.height, Math.max(1, Math.floor(upload.height * scale)));
  const legacy = await fetch(thumbnail(fixture, 480, fixture.extension), { headers: { Accept: 'image/webp;q=0,*/*;q=1' }, redirect: 'manual' });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.headers.get('content-type'), fixture.type);
  assert.notEqual(legacy.headers.get('etag'), modern.headers.get('etag'));
  await legacy.arrayBuffer();
  const unchanged = await fetch(url, { headers: { Accept: 'image/webp', 'If-None-Match': modern.headers.get('etag') } });
  assert.equal(unchanged.status, 304);
  const head = await fetch(url, { method: 'HEAD', headers: { Accept: 'image/webp' } });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  let hit = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const cached = await fetch(url, { headers: { Accept: 'image/webp' } });
    assert.equal(cached.status, 200);
    assert.equal(cached.headers.get('content-type'), 'image/webp');
    hit ||= cached.headers.get('cf-cache-status') === 'HIT';
    await cached.arrayBuffer();
    if (hit) break;
  }
  assert(hit, `${fixture.name} must hit Workers Cache`);
  if (fixture.name === 'photo') {
    assert(bytes.length <= photo.length * 0.1, '480px thumbnail must save at least 90%');
    for (const edge of [96, 160, 192, 288, 320]) {
      const candidate = await fetch(thumbnail(fixture, edge), { headers: { Accept: 'image/webp' } });
      assert.equal(candidate.status, 200);
      assert.equal(imageSize(Buffer.from(await candidate.arrayBuffer())).width, edge);
    }
  } else if (fixture.name === 'transparent') {
    const data = chunks(bytes);
    assert(data.some(chunk => chunk.type === 'VP8X' && (chunk.data[0] & 16) || chunk.type === 'VP8L' && (chunk.data.readUInt32LE(1) & (1 << 28))), 'WebP must retain alpha');
  } else {
    assert.equal(chunks(bytes).filter(chunk => chunk.type === 'ANMF').length, 2, 'WebP must preserve both animation frames');
  }
  await writeFile(join(directory, `${fixture.name}.webp`), bytes);
  (options.log ?? console.log)(JSON.stringify({ fixture: fixture.name, source_bytes: fixture.bytes.length, thumbnail_bytes: bytes.length, reduction_percent: Number((100 * (1 - bytes.length / fixture.bytes.length)).toFixed(2)), dimensions: encoded, cache: 'HIT' }));
}
const now = context.now().toISOString();
const run = `thumbnail:${crypto.randomUUID()}`;
context.registerDigest(run);
const digest = await fetch(`${origin}/api/digests`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: run, source: 'thumbnail-acceptance', client_ref: run, items: fixtures.map(fixture => ({
    headline: `Thumbnail verification ${run}: ${fixture.name}`, group: 'Preview verification', group_url: 'https://lakearrowhead.town/',
    post_url: `${origin}/?thumbnail-fixture=${fixture.name}&run=${encodeURIComponent(run)}`, posted_at: now, category: 'announcement',
    body: `![${fixture.name} thumbnail verification](${fixture.url})\n\nPreview fixture for responsive sizing, image quality, transparency, and animation.`,
  })),
}) });
assert.equal(digest.status, 200);
const published = await digest.json(); assert(published.post?.id); assert.equal(published.counts.published, fixtures.length);
const homepage = await (await fetch(origin)).text();
for (const fixture of fixtures) { assert(homepage.includes(`Thumbnail verification ${run}: ${fixture.name}`)); assert(homepage.includes(fixture.url.split('/').at(-1))); }
assert(homepage.includes('/thumbnails/v2/'));
assert(homepage.includes('<picture>'));
const v1 = await fetch(`${origin}/thumbnails/v1/${fixtures[0].url.split('/').at(-1)}/160`, { headers: { Accept: 'image/webp' }, redirect: 'manual' });
assert.equal(v1.status, 200); assert.equal(v1.headers.get('content-type'), 'image/webp'); await v1.arrayBuffer();
assert(homepage.includes('sizes="(max-width: 600px) 96px, 160px"'));
return { origin, post_id: published.post.id, artifacts: directory };
});
(options.log ?? console.log)(JSON.stringify({ preview: origin, artifacts: result.artifacts, status: 'passed' }));
return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await smokeThumbnails(undefined, { artifactsDirectory: '.artifacts/preview' }); } catch (error) { reportFailure('Thumbnail acceptance failed; inspect .artifacts/preview/thumbnails.json', error); process.exitCode = 1; }
}
