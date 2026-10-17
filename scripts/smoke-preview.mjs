import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readCredential, validateCredential } from './credentials.mjs';
import { maintenance, maintenanceTarget } from './maintenance.mjs';

export function parseSmokeArgs(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, options: { 'verify-edge': { type: 'boolean' } }, allowPositionals: true, strict: true });
  if (positionals.length > 1) throw new Error('Expected at most one preview URL');
  return { origin: maintenanceTarget('preview', positionals[0] ?? 'https://lakearrowheadtown-preview.harold-martin.workers.dev'), edge: values['verify-edge'] ?? false };
}

export async function smoke(args = process.argv.slice(2), options = {}) {
  const { origin, edge } = parseSmokeArgs(args);
  const fetch = (url, init = {}) => (options.request ?? globalThis.fetch)(url, { ...init, signal: AbortSignal.timeout(30000) });
  const secret = validateCredential((options.credential ?? readCredential)('preview'));
  const headers = { Authorization: `Bearer ${secret}` };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const form = new FormData();
  form.append('file', new File([png], 'preview.png', { type: 'image/png' }));
  const imageResponse = await fetch(`${origin}/api/images`, { method: 'POST', headers, body: form });
  assert.equal(imageResponse.status, 200, await imageResponse.clone().text());
  const { url: imageUrl } = await imageResponse.json();
  assert.equal(new URL(imageUrl).origin, origin);
  for (let attempt = 0; attempt < 2; attempt++) {
    const image = await fetch(imageUrl);
    assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    if (edge && attempt === 1) assert.equal(image.headers.get('cf-cache-status'), 'HIT', 'A repeated image request must hit Workers Caching');
  }
  const run = `Preview verification ${crypto.randomUUID()}`;
  const input = {
    date: '2099-01-01', title: run, source: 'deployment-smoke-test',
    items: [{ group: 'Preview verification', group_url: 'https://lakearrowhead.town/', headline: run, body: `This is preview test content.\n\n**Markdown works.**\n\n![Uploaded image](${imageUrl})`, post_url: 'https://lakearrowhead.town/', category: 'announcement', posted_at: new Date().toISOString() }],
  };
  let previousTag;
  for (let attempt = 0; attempt < 3; attempt++) {
    input.title = `${run}${attempt === 2 ? ' follow-up correction' : ''}`;
    input.items[0].headline = input.title;
    const response = await fetch(`${origin}/api/digests`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { ok: true, url: '/' });
    const homepage = await fetch(origin, { headers: { 'Accept-Encoding': 'gzip', ...(previousTag ? { 'If-None-Match': previousTag } : {}) } });
    assert.equal(homepage.status, 200, 'Each append must immediately change the homepage');
    const html = await homepage.text();
    assert(html.includes('<strong>Markdown works.</strong>'));
    assert(html.includes('Last published'));
    assert.equal(html.split(`rel="noopener noreferrer">${run}`).length - 1, attempt + 1);
    assert(html.includes('class="article-image article-thumbnail"'));
    assert(!html.includes('class="post-link"'));
    assert(html.indexOf('Posts from') > html.indexOf('</main>'));
    assert(!html.includes('href="/digests/'));
    previousTag = homepage.headers.get('etag');
    assert(previousTag?.startsWith('W/'), 'HTML must expose a weak ETag');
    if (edge) assert.match(homepage.headers.get('content-encoding') || '', /gzip|br|zstd/, 'Cloudflare must compress HTML');
  }
  assert.equal((await fetch(origin, { headers: { 'If-None-Match': previousTag } })).status, 304);
  assert.equal((await fetch(`${origin}/api/digests`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${origin}/digests/2026-10-16`)).status, 404);
  assert.equal((await fetch(`${origin}/posts/`)).status, 404);
  const job = await maintenance('start', 'preview', undefined, { secret, origin, request: fetch });
  (options.log ?? console.log)(`Preview smoke checks passed: ${origin}. Rebuild ${job.id} queued; check its status manually.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await smoke(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
