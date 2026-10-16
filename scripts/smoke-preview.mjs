import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const origin = new URL(process.argv[2] || 'https://lakearrowheadtown-preview.harold-martin.workers.dev').origin;
const target = new URL(origin);
if (!(target.protocol === 'https:' && target.hostname === 'lakearrowheadtown-preview.harold-martin.workers.dev') && !(target.protocol === 'http:' && target.hostname === 'localhost')) throw new Error('This script only publishes to the isolated preview Worker or localhost');
const fetch = (url, options = {}) => globalThis.fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
const secret = /^API_SECRET=(.+)$/m.exec(readFileSync('.dev.vars.preview', 'utf8'))?.[1];
assert(secret, 'Provision .dev.vars.preview first');
const headers = { Authorization: `Bearer ${secret}` };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const form = new FormData();
form.append('file', new File([png], 'preview.png', { type: 'image/png' }));
const imageResponse = await fetch(`${origin}/api/images`, { method: 'POST', headers, body: form });
assert.equal(imageResponse.status, 200, await imageResponse.clone().text());
const { url: imageUrl } = await imageResponse.json();
assert.equal(new URL(imageUrl).origin, origin);
const uploadedImage = await fetch(imageUrl);
assert.equal(uploadedImage.status, 200);
assert.deepEqual(Buffer.from(await uploadedImage.arrayBuffer()), png);
const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const previous = new Date(`${localDay}T12:00:00Z`);
previous.setUTCDate(previous.getUTCDate() - 1);
const dates = [previous.toISOString().slice(0, 10), localDay];
for (const date of dates) {
  const input = {
    date, title: `Preview publishing verification — ${date}`, source: 'deployment-smoke-test',
    items: [{ group: 'Preview verification', group_url: 'https://lakearrowhead.town/', headline: 'Publishing verification', body: `This is test content for the preview deployment.\n\n**Markdown works.**\n\n![Uploaded preview image](${imageUrl})`, post_url: 'https://lakearrowhead.town/', category: 'announcement', posted_at: new Date().toISOString() }],
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    input.title = `${attempt ? 'Corrected preview' : 'Preview'} publishing verification — ${date}`;
    const response = await fetch(`${origin}/api/digests`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { ok: true, url: `/digests/${date}` });
    const page = await fetch(`${origin}/digests/${date}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<strong>Markdown works\.<\/strong>/);
  }
}
const homepage = await fetch(origin);
const etag = homepage.headers.get('etag');
assert(etag, 'The live homepage must expose an ETag');
const html = await homepage.text();
for (const date of dates) {
  assert(html.includes(`Corrected preview publishing verification — ${date}`));
  assert.equal((html.match(new RegExp(`id="digest-${date}"`, 'g')) || []).length, 1);
}
assert.equal((await fetch(origin, { headers: { 'If-None-Match': etag } })).status, 304);
assert.equal((await fetch(`${origin}/api/digests`, { method: 'POST', body: '{}' })).status, 401);
assert.equal((await fetch(`${origin}/digests/${localDay}.json`)).status, 404);
console.log(`Preview smoke checks passed: ${origin}`);
