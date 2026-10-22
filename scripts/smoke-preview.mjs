import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SaxesParser } from 'saxes';
import { readCredential, validateCredential } from './credentials.mjs';
import { smokeAlerts } from './smoke-alerts.mjs';
import { smokeChanges } from './smoke-changes.mjs';
import { maintenance, maintenanceTarget, waitForRebuild } from './maintenance.mjs';

export function checkHtmlHeaders(response) {
  assert(response.headers.get('ETag')?.startsWith('W/'), 'HTML must expose a weak ETag');
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate, no-transform');
  assert(response.headers.get('Vary')?.split(',').some(value => value.trim().toLowerCase() === 'accept-encoding'), 'HTML must vary on Accept-Encoding');
}

export function checkRssHeaders(response) {
  const contentType = response.headers.get('Content-Type');
  if (response.status !== 304 || contentType !== null) assert.equal(contentType, 'application/rss+xml; charset=utf-8');
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
  // Confirm support through a read before any dry_run request reaches an older writer.
  const capability = await fetch(`${origin}/api/posts?fields=index`, { headers });
  assert.equal(capability.status, 200, await capability.clone().text());
  assert.equal(capability.headers.get('X-API-Version'), '3');
  assert.equal((await capability.json()).fields, 'index');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const form = new FormData();
  form.append('file', new File([png], 'preview.png', { type: 'image/png' }));
  const imageResponse = await fetch(`${origin}/api/images`, { method: 'POST', headers, body: form });
  assert.equal(imageResponse.status, 200, await imageResponse.clone().text());
  const { url: imageUrl, width, height } = await imageResponse.json();
  assert.equal(width, 1); assert.equal(height, 1);
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
    client_ref: `smoke:${crypto.randomUUID()}`,
    items: [{ group: 'Preview verification', group_url: 'https://lakearrowhead.town/', headline: run, body: `This is preview test content.\n\n**Markdown works.**\n\n![Uploaded image](${imageUrl})`, post_url: `https://lakearrowhead.town/?smoke=${encodeURIComponent(run)}`, category: 'announcement', posted_at: new Date().toISOString() }],
  };
  let previousTag;
  let previousRssTag;
  let workerVersion;
  let story;
  const requestIds = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    input.title = `${run}${attempt === 2 ? ' follow-up correction' : ''}`;
    input.items[0].headline = input.title;
    if (attempt === 2) { input.items[0].post_url += '&followup=1'; input.client_ref += ':followup'; }
    const beforeNews = await (await fetch(`${origin}/api/posts?fields=index`, { headers })).json();
    const beforePreview = await fetch(origin, { method: 'HEAD' });
    assert.equal(beforePreview.status, 200);
    checkHtmlHeaders(beforePreview);
    const preview = await fetch(`${origin}/api/digests?dry_run=true`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(preview.status, 200, await preview.clone().text());
    const planned = await preview.json();
    assert.equal(planned.dry_run, true); assert.equal(planned.committed, false); assert(planned.checked_at);
    assert.equal(planned.counts.published, attempt === 1 ? 0 : 1);
    const unchanged = await fetch(origin, { method: 'HEAD', headers: { 'If-None-Match': beforePreview.headers.get('etag') } });
    assert([200, 304].includes(unchanged.status));
    checkHtmlHeaders(unchanged);
    const afterNews = await (await fetch(`${origin}/api/posts?fields=index`, { headers })).json();
    assert.deepEqual(afterNews.posts, beforeNews.posts); assert.equal(afterNews.published_at, beforeNews.published_at);
    const response = await fetch(`${origin}/api/digests`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    story ??= result.items[0];
    assert.equal(result.ok, true); assert.equal(result.url, '/');
    assert.equal(result.request_id, response.headers.get('X-Request-ID'));
    requestIds.push(result.request_id);
    assert.equal(response.headers.get('X-API-Version'), '3');
    assert(response.headers.get('X-Worker-Version'));
    workerVersion ??= response.headers.get('X-Worker-Version');
    assert.equal(response.headers.get('X-Worker-Version'), workerVersion);
    assert.equal(result.duplicate, attempt === 1);
    assert.deepEqual(result.counts, { submitted: 1, published: attempt === 1 ? 0 : 1, duplicates: attempt === 1 ? 1 : 0 });
    assert.equal(result.post === null, attempt === 1);
    assert.equal(result.client_ref, input.client_ref);
    const lookup = await fetch(`${origin}/api/digests?client_ref=${encodeURIComponent(input.client_ref)}`, { headers });
    assert.equal(lookup.status, 200);
    const batch = await lookup.json();
    assert.equal(batch.status, 'published');
    assert.equal(batch.post.id, attempt === 1 ? story.post_id : result.post.id);
    const homepage = await fetch(origin, { headers: { 'Accept-Encoding': 'gzip', ...(previousTag ? { 'If-None-Match': previousTag } : {}) } });
    assert(attempt === 1 ? [200, 304].includes(homepage.status) : homepage.status === 200);
    checkHtmlHeaders(homepage);
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
    if (attempt === 1) { await homepage.arrayBuffer(); continue; }
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
  const listStories = async () => {
    let cursor;
    const posts = [];
    do {
      const response = await fetch(`${origin}/api/posts?days=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      const result = await response.json();
      assert.equal(result.ok, true);
      assert.equal(result.request_id, response.headers.get('X-Request-ID'));
      posts.push(...result.posts);
      cursor = result.next_cursor;
    } while (cursor);
    return posts;
  };
  assert((await listStories()).some(post => post.post_id === story.post_id && post.items.some(item => item.item_index === story.item_index)));
  const update = { group: 'Preview follow-up', post_url: `${input.items[0].post_url}&attached=1`, body: `Attached **source update** for ${run}.`, posted_at: new Date().toISOString() };
  const updatePath = `${origin}/api/posts/${story.post_id}/items/${story.item_index}/updates`;
  let appendedTag;
  let appendedRssTag;
  for (let attempt = 0; attempt < 2; attempt++) {
    const preview = await fetch(`${updatePath}?dry_run=true`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(update) });
    assert.equal(preview.status, 200, await preview.clone().text());
    const planned = await preview.json();
    assert.equal(planned.dry_run, true); assert.equal(planned.committed, false); assert.equal(planned.status, attempt ? 'duplicate' : 'appended');
    const response = await fetch(updatePath, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(update) });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.status, attempt ? 'duplicate' : 'appended');
    assert.equal(result.post_id, story.post_id); assert.equal(result.item_index, story.item_index); assert.equal(result.update_index, 0);
    assert(result.message); assert.equal(result.request_id, response.headers.get('X-Request-ID')); requestIds.push(result.request_id);
    if (attempt) assert.equal(result.suggestion.action, 'review_existing_story');
    const homepage = await fetch(origin, { headers: { 'If-None-Match': appendedTag ?? previousTag } });
    const rss = await fetch(`${origin}/rss.xml`, { headers: { 'If-None-Match': appendedRssTag ?? previousRssTag } });
    assert.equal(homepage.status, attempt ? 304 : 200); assert.equal(rss.status, attempt ? 304 : 200);
    checkRssHeaders(rss);
    if (!attempt) {
      assert((await homepage.text()).includes('Attached <strong>source update</strong>'));
      const xml = await rss.text();
      const parser = new SaxesParser({ xmlns: true }); parser.write(xml).close();
      assert(xml.includes('attached=1'));
      appendedTag = homepage.headers.get('etag'); appendedRssTag = rss.headers.get('etag');
      assert(appendedTag?.startsWith('W/')); assert(appendedRssTag?.startsWith('W/'));
    }
  }
  const readStory = (await listStories()).find(post => post.post_id === story.post_id).items.find(item => item.item_index === story.item_index);
  assert.equal(readStory.updates.length, 1); assert.equal(readStory.updates[0].post_url, update.post_url);
  const compact = await fetch(`${origin}/api/posts?days=30&fields=index`, { headers });
  assert.equal(compact.status, 200);
  const compactBody = await compact.json();
  assert.equal(compactBody.fields, 'index');
  assert(compactBody.posts.every(post => !('title' in post) && post.items.every(item => !('body' in item) && item.updates.every(source => !('body' in source)))));
  previousTag = appendedTag; previousRssTag = appendedRssTag;
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
  // Retract a separate labeled batch so the main HTML/RSS/archive checks retain their fixtures.
  const cleanupInput = { ...input, client_ref: `${input.client_ref}:retract`, items: [{ ...input.items[0], headline: 'Self-retraction smoke fixture', post_url: `${input.items[0].post_url}&retract=1` }] };
  const cleanupPublish = await fetch(`${origin}/api/digests`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(cleanupInput) });
  assert.equal(cleanupPublish.status, 200);
  const cleanupId = (await cleanupPublish.json()).post.id;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${origin}/api/posts/${cleanupId}/retract`, { method: 'POST', headers });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).status, attempt ? 'already_retracted' : 'retracted');
  }
  const cleanupLookup = await fetch(`${origin}/api/digests?client_ref=${encodeURIComponent(cleanupInput.client_ref)}`, { headers });
  assert.equal((await cleanupLookup.json()).status, 'retracted');
  assert(!(await listStories()).some(post => post.post_id === cleanupId));
  const seoHtml = await (await fetch(origin)).text();
  assert(seoHtml.includes('Lake Arrowhead News, Alerts &amp; Events | Lake Arrowhead . Town'));
  assert(seoHtml.includes('"alternateName":["Lake Arrowhead Town","lakearrowhead.town"]'));
  assert(seoHtml.includes('href="/archive/"'));
  const images = [...seoHtml.matchAll(/<img\b[^>]*>/g)].map(match => match[0]);
  assert.equal(images.filter(tag => tag.includes('loading="eager"')).length, 1);
  assert(images.every(tag => tag.includes('decoding="async"')));
  assert(images.some(tag => tag.includes(`/thumbnails/v2/${new URL(imageUrl).pathname.split('/').at(-1)}/96.png`) && tag.includes('width="1" height="1"')));
  const dailyPath = seoHtml.match(/<h2 id="day-[^"]+"><a href="(\/\d{4}\/\d{2}\/\d{2}\/)"/)[1];
  const daily = await fetch(origin + dailyPath);
  assert.equal(daily.status, 200);
  checkHtmlHeaders(daily);
  const dailyHtml = await daily.text();
  assert(dailyHtml.includes(`<link rel="canonical" href="${origin}${dailyPath}">`));
  assert.match(dailyHtml, /<title>Lake Arrowhead news — /);
  const cardUrl = dailyHtml.match(/<meta property="og:image" content="([^"]+)"/)[1];
  assert.equal(new URL(cardUrl).origin, origin);
  const card = await fetch(cardUrl);
  assert.equal(card.status, 200); assert.equal(card.headers.get('content-type'), 'image/png');
  const cardBytes = Buffer.from(await card.arrayBuffer());
  assert.equal(cardBytes.readUInt32BE(16), 1200); assert.equal(cardBytes.readUInt32BE(20), 630);
  const archive = await fetch(`${origin}/archive/`);
  checkHtmlHeaders(archive);
  assert.equal(archive.status, 200); assert((await archive.text()).includes(dailyPath));
  for (const path of ['/road-conditions/', '/power-outages/', '/emergency-resources/']) {
    const page = await fetch(origin + path);
    assert.equal(page.status, 200); assert.equal(page.headers.get('X-Robots-Tag'), 'noindex');
    checkHtmlHeaders(page);
    assert((await page.text()).includes(`<link rel="canonical" href="${origin}${path}">`));
  }
  const font = await fetch(`${origin}/assets/fonts/dm-sans-v1.woff2`);
  assert.equal(font.status, 200); assert.equal(font.headers.get('content-type'), 'font/woff2');
  const feed = await (await fetch(`${origin}/rss.xml`)).text();
  new SaxesParser({ xmlns: true }).write(feed).close();
  assert(feed.includes('<ttl>15</ttl>')); assert(feed.includes('<image>')); assert(feed.includes('<dc:creator>'));
  assert(feed.includes('<media:content '));
  await smokeAlerts(origin, fetch, headers);
  await smokeChanges(origin, fetch, headers);
  const queued = await maintenance('start', 'preview', undefined, { secret, origin, request: fetch });
  const job = await waitForRebuild(queued, 'preview', { secret, origin, request: fetch });
  (options.log ?? console.log)(`Preview smoke checks passed: ${origin}. Rebuild ${job.id} completed.`);
  return { origin, job, request_ids: requestIds, worker_version: workerVersion };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await smoke(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
