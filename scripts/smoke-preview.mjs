import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SaxesParser } from 'saxes';
import { readCredential, validateCredential } from './credentials.mjs';
import { maintenance, maintenanceTarget } from './maintenance.mjs';

export function checkRssHeaders(response) {
  if (response.status !== 304) assert.equal(response.headers.get('Content-Type'), 'application/rss+xml; charset=utf-8');
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate');
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex');
}

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
    items: [{ group: 'Preview verification', group_url: 'https://lakearrowhead.town/', headline: run, body: `This is preview test content.\n\n**Markdown works.**\n\n![Uploaded image](${imageUrl})`, post_url: `https://lakearrowhead.town/?smoke=${encodeURIComponent(run)}`, category: 'announcement', posted_at: new Date().toISOString() }],
  };
  let previousTag;
  let previousRssTag;
  let workerVersion;
  const requestIds = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    input.title = `${run}${attempt === 2 ? ' follow-up correction' : ''}`;
    input.items[0].headline = input.title;
    if (attempt === 2) input.items[0].post_url += '&followup=1';
    const response = await fetch(`${origin}/api/digests`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.ok, true); assert.equal(result.url, '/');
    assert.equal(result.request_id, response.headers.get('X-Request-ID'));
    requestIds.push(result.request_id);
    assert.equal(response.headers.get('X-API-Version'), '2');
    assert(response.headers.get('X-Worker-Version'));
    workerVersion ??= response.headers.get('X-Worker-Version');
    assert.equal(response.headers.get('X-Worker-Version'), workerVersion);
    assert.equal(result.duplicate, attempt === 1);
    assert.deepEqual(result.counts, { submitted: 1, published: attempt === 1 ? 0 : 1, duplicates: attempt === 1 ? 1 : 0 });
    assert.equal(result.post === null, attempt === 1);
    const homepage = await fetch(origin, { headers: { 'Accept-Encoding': 'gzip', ...(previousTag ? { 'If-None-Match': previousTag } : {}) } });
    assert.equal(homepage.status, attempt === 1 ? 304 : 200, 'Duplicates must preserve the homepage and ETag');
    const rss = await fetch(`${origin}/rss.xml`, { headers: previousRssTag ? { 'If-None-Match': previousRssTag } : {} });
    assert.equal(rss.status, attempt === 1 ? 304 : 200, 'RSS must change with publications and remain unchanged for duplicates');
    checkRssHeaders(rss);
    if (attempt === 1) {
      assert.equal(rss.headers.get('etag'), previousRssTag);
      assert.equal(await rss.text(), '');
    }
    else {
      const xml = await rss.text();
      const text = [];
      const parser = new SaxesParser({ xmlns: true });
      parser.on('text', value => { text.push(value); });
      parser.write(xml).close();
      const decoded = text.join('\n');
      assert(decoded.includes(input.title));
      assert(decoded.includes('<strong>Markdown works.</strong>'));
      assert(decoded.includes(`src="${imageUrl}"`));
      assert(decoded.includes(input.items[0].post_url));
      previousRssTag = rss.headers.get('etag');
      assert(previousRssTag?.startsWith('W/'), 'RSS must expose a weak ETag');
      const rssHead = await fetch(`${origin}/rss.xml`, { method: 'HEAD' });
      assert.equal(rssHead.status, 200); assert.equal(rssHead.headers.get('etag'), previousRssTag); assert.equal(await rssHead.text(), '');
      checkRssHeaders(rssHead);
    }
    if (attempt === 1) continue;
    const html = await homepage.text();
    assert(html.includes('<strong>Markdown works.</strong>'));
    assert(html.includes('Last published'));
    assert.equal(html.split(`rel="noopener noreferrer">${run}`).length - 1, attempt === 2 ? 2 : 1);
    assert(html.includes('class="article-image article-thumbnail"'));
    assert(!html.includes('class="post-link"'));
    assert(html.indexOf('Posts from') > html.indexOf('</main>'));
    assert(!html.includes('href="/digests/'));
    assert(html.includes('rel="alternate" type="application/rss+xml"'));
    assert(html.includes(`href="${origin}/rss.xml"`));
    assert(html.includes('<a href="/rss.xml">RSS feed</a>'));
    previousTag = homepage.headers.get('etag');
    assert(previousTag?.startsWith('W/'), 'HTML must expose a weak ETag');
    if (edge) assert.match(homepage.headers.get('content-encoding') || '', /gzip|br|zstd/, 'Cloudflare must compress HTML');
  }
  const empty = await fetch(`${origin}/api/digests`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, items: [] }) });
  assert.equal(empty.status, 400);
  const invalid = await empty.json();
  assert.equal(invalid.code, 'validation_failed');
  assert(invalid.details.some(issue => issue.code === 'empty_items'));
  assert.equal(invalid.request_id, empty.headers.get('X-Request-ID'));
  const emptyBody = JSON.stringify({ ...input, items: [] });
  assert.equal(invalid.diagnostics.bytes_received, Buffer.byteLength(emptyBody));
  assert.equal(invalid.diagnostics.body_complete, true);
  assert.equal(invalid.diagnostics.body_sha256, createHash('sha256').update(emptyBody).digest('hex'));
  requestIds.push(invalid.request_id);
  const malformedBody = 'position 12 abcdefghijklmnopqrstuvwxyz';
  const malformed = await fetch(`${origin}/api/digests`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: malformedBody });
  assert.equal(malformed.status, 400);
  const syntaxError = await malformed.json();
  assert.equal(syntaxError.code, 'invalid_json');
  assert.deepEqual(syntaxError.details, {}, 'Quoted input must never supply a syntax position');
  assert.equal(syntaxError.diagnostics.body_complete, true);
  assert.equal(syntaxError.diagnostics.body_sha256, createHash('sha256').update(malformedBody).digest('hex'));
  requestIds.push(syntaxError.request_id);
  assert.equal((await fetch(origin, { headers: { 'If-None-Match': previousTag } })).status, 304);
  assert.equal((await fetch(`${origin}/rss.xml`, { headers: { 'If-None-Match': previousRssTag } })).status, 304);
  assert.equal((await fetch(`${origin}/api/digests`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${origin}/digests/2026-10-16`)).status, 404);
  assert.equal((await fetch(`${origin}/posts/`)).status, 404);
  const job = await maintenance('start', 'preview', undefined, { secret, origin, request: fetch });
  (options.log ?? console.log)(`Preview smoke checks passed: ${origin}. Rebuild ${job.id} queued; check its status manually.`);
  return { origin, job, request_ids: requestIds, worker_version: workerVersion };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await smoke(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
