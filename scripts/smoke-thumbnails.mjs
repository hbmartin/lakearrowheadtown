import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageSize } from 'image-size';
import { readPublishingCredential } from './credentials.mjs';
import { maintenanceTarget } from './maintenance.mjs';

// Writes fixtures only to the allowlisted preview environment, never production.
const origin = maintenanceTarget('preview', process.argv[2]);
const secret = readPublishingCredential('preview');
const auth = { Authorization: `Bearer ${secret}` };
const directory = await mkdtemp(join(tmpdir(), 'lakearrowhead-thumbnails-'));
const photoUrl = 'https://lakearrowhead.town/images/afbc50b8eef368050ef72c259299410e5abeaf0687566aa875592db84c42eb0e.jpg';
const photoResponse = await fetch(photoUrl);
assert.equal(photoResponse.status, 200);
const photo = Buffer.from(await photoResponse.arrayBuffer());
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
const thumbnail = (fixture, edge) => `${origin}/thumbnails/v1/${fixture.url.split('/').at(-1)}/${edge}`;
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
  assert.match(modern.headers.get('vary') ?? '', /\bAccept\b/i);
  const bytes = Buffer.from(await modern.arrayBuffer());
  await writeFile(join(directory, `${fixture.name}.webp`), bytes);
  const encoded = imageSize(bytes);
  const scale = Math.min(1, 480 / Math.max(upload.width, upload.height));
  assert.equal(encoded.width, Math.max(1, Math.floor(upload.width * scale)));
  const legacy = await fetch(url, { headers: { Accept: 'image/webp;q=0,*/*;q=1' }, redirect: 'manual' });
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
  console.log(JSON.stringify({ fixture: fixture.name, source_bytes: fixture.bytes.length, thumbnail_bytes: bytes.length, reduction_percent: Number((100 * (1 - bytes.length / fixture.bytes.length)).toFixed(2)), dimensions: encoded, cache: 'HIT' }));
}
const now = new Date().toISOString();
const digest = await fetch(`${origin}/api/digests`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({
  title: 'Responsive thumbnail acceptance', source: 'thumbnail-acceptance', items: fixtures.map(fixture => ({
    headline: `Thumbnail verification: ${fixture.name}`, group: 'Preview verification', group_url: 'https://lakearrowhead.town/',
    post_url: `https://lakearrowhead.town/?thumbnail-fixture=${fixture.name}`, posted_at: now, category: 'announcement',
    body: `![${fixture.name} thumbnail verification](${fixture.url})\n\nPreview fixture for responsive sizing, image quality, transparency, and animation.`,
  })),
}) });
assert.equal(digest.status, 200);
const homepage = await (await fetch(origin)).text();
assert(homepage.includes('/thumbnails/v1/'));
assert(homepage.includes('sizes="(max-width: 600px) 96px, 160px"'));
console.log(JSON.stringify({ preview: origin, artifacts: directory, status: 'passed' }));
