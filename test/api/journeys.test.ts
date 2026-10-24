import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestHarness } from 'wrangler';
import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import fixture from '../fixtures/town-card.json';
import { digest, item, secret } from '../helpers/fixtures';
import type { Env } from '../../src/types';
const options = (enabled = false) => ({ workers: [{ configPath: './wrangler.jsonc', env: 'preview', vars: { SITE_ORIGIN: '', ALERT_CONFIRMATIONS_ENABLED: String(enabled) }, secrets: { API_SECRET: secret } }] });
const server = createTestHarness(options());
let origin: string;
beforeAll(async () => { origin = (await server.listen()).url.origin; });
beforeEach(async () => { await server.reset(); origin = (await server.listen()).url.origin; });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => server.close());
async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers); if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${secret}`);
  const response = await fetch(origin + path, { ...init, headers, signal: AbortSignal.timeout(30000) });
  if (path.startsWith('/api/')) {
    expect(response.headers.get('X-API-Version')).toBe('3'); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Request-ID')).toBeTruthy(); expect(response.headers.get('X-Worker-Version')).toBeTruthy();
    if (init.method !== 'HEAD') {
      const body: any = await response.clone().json(); expect(body.request_id).toBe(response.headers.get('X-Request-ID'));
    }
  }
  return response;
}
const send = (path: string, body: unknown = {}) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function json(path: string) { const response = await request(path); expect(response.status).toBe(200); return response.json() as Promise<any>; }
const uuid = '00000000-0000-0000-0000-000000000001';
const endpoints = [
  ['/api/digests', 'GET, HEAD, POST'], ['/api/posts', 'GET, HEAD'], ['/api/events', 'GET, HEAD, POST'], ['/api/alerts', 'GET, HEAD, POST'],
  [`/api/alerts/${uuid}`, 'GET, HEAD'], ['/api/alerts/confirmations', 'POST'], [`/api/alerts/${uuid}/entries/${uuid}/retract`, 'POST'],
  ['/api/changes', 'GET, HEAD'], ['/api/images', 'POST'], [`/api/posts/${uuid}/retract`, 'POST'], [`/api/posts/${uuid}/items/0/updates`, 'POST'],
  ['/api/rebuild', 'POST'], [`/api/rebuild/${uuid}`, 'GET'], [`/api/rebuild/${uuid}/resume`, 'POST'],
  ['/api/publication/repair', 'GET, HEAD, POST'], ['/api/publication/repair/resume', 'POST'], ['/api/publication/repair/cancel', 'POST'],
];
it('enforces authentication, method contracts, diagnostics, and empty HEAD bodies across endpoint families', async () => {
  for (const [path, allow] of endpoints) {
    const anonymous = await request(path, { method: allow.split(', ')[0], headers: { Authorization: '' } }); expect(anonymous.status, path).toBe(401);
    const method = await request(path, { method: 'PUT' }); expect(method.status, path).toBe(405); expect(method.headers.get('Allow'), path).toBe(allow);
    const head = await request(path, { method: 'HEAD' }); expect((await head.arrayBuffer()).byteLength, path).toBe(0);
  }
});
it('publishes a recoverable story and keeps API, HTML, RSS and archives consistent through updates and retraction', async () => {
  const input = digest(); const preview = await send('/api/digests?dry_run=true', input);
  expect(await preview.json()).toMatchObject({ dry_run: true, committed: false });
  expect((await request(`/api/digests?client_ref=${input.client_ref}`)).status).toBe(404);
  const response = await send('/api/digests', input); expect(response.status).toBe(200);
  // Deliberately discard the POST body: recover solely through the persisted reference.
  const lookup = await json(`/api/digests?client_ref=${input.client_ref}`); const id = lookup.post.id;
  const retry: any = await (await send('/api/digests', input)).json(); expect(retry.duplicate).toBe(true);
  expect((await send('/api/digests', { ...input, items: [item()] })).status).toBe(409);
  const update = { group: 'Correction', post_url: 'https://example.com/correction', body: 'Additional verified details', posted_at: new Date().toISOString() };
  expect((await send(`/api/posts/${id}/items/0/updates`, update)).status).toBe(200);
  await send(`/api/posts/${id}/items/0/updates`, update);
  const posts = await json('/api/posts'); const story = posts.posts.find((post: any) => post.post_id === id).items[0];
  expect(story.updates).toHaveLength(1);
  for (const path of ['/', '/rss.xml']) { const text = await (await request(path)).text(); expect(text).toContain(input.items[0].headline); expect(text).toContain(update.body); }
  const html = await (await request('/')).text(); const archive = html.match(/href="(\/\d{4}\/\d{2}\/\d{2}\/)"/)![1];
  expect(await (await request(archive)).text()).toContain(update.body);
  const compact = await json('/api/posts?fields=index'); expect(compact.posts[0].items[0]).not.toHaveProperty('body');
  expect((await send(`/api/posts/${id}/retract`)).status).toBe(200);
  expect(await (await send(`/api/posts/${id}/retract`)).json()).toMatchObject({ status: 'already_retracted' });
  expect((await json(`/api/digests?client_ref=${input.client_ref}`)).status).toBe('retracted');
  for (const path of ['/', '/rss.xml', archive]) expect(await (await request(path)).text()).not.toContain(input.items[0].headline);
});
it('publishes timed and all-day events and exposes their exact identities through reads, calendar and reconciliation', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const input = { ...digest(), items: [
    { ...item({ headline: 'All day library' }), all_day: true, starts_at: today, location: 'Library' },
    { ...item({ headline: 'Timed meeting' }), all_day: false, starts_at: `${today}T18:00:00Z`, ends_at: `${today}T19:00:00Z` },
  ] };
  const published: any = await (await send('/api/events', input)).json(); expect(published.counts.published).toBe(2);
  const duplicate: any = await (await send('/api/events', input)).json(); expect(duplicate.counts.duplicates).toBe(2);
  const events = await json('/api/events?days=1'); expect(events.events).toHaveLength(2);
  expect(events.events.map((event: any) => event.post_id)).toEqual([published.post.id, published.post.id]);
  const calendar = await (await request('/calendar/')).text(); expect(calendar).toContain('All day library'); expect(calendar).toContain('Timed meeting'); expect(calendar).toContain('<time datetime=');
  expect((await json('/api/changes')).changes.filter((change: any) => change.resource === 'event')).toHaveLength(2);
  expect((await send('/api/events', { ...input, items: [{ ...input.items[1], ends_at: input.items[1].starts_at }] })).status).toBe(400);
  expect((await request('/api/events?days=31')).status).toBe(400);
});
it.each([false, true])('supports alert lifecycles with confirmation writes enabled=%s', async enabled => {
  await server.update(options(enabled));
  const common = { source: 'caltrans', source_url: 'https://example.com/road', observed_at: new Date().toISOString() };
  const input = { ...common, client_ref: crypto.randomUUID(), phase: 'open', category: 'traffic', kind: 'closure', routes: ['SR-18'], headline: 'HTTP road closure' };
  const opened: any = await (await send('/api/alerts', input)).json(); expect(opened.status).toBe('published'); expect(opened.expires_at).toBe(new Date(Date.parse(common.observed_at) + 86400000).toISOString());
  expect(await (await send('/api/alerts', input)).json()).toMatchObject({ status: 'duplicate', entry_id: opened.entry_id });
  const checks = { confirmations: [{ ...common, client_ref: crypto.randomUUID(), alert_id: opened.alert_id }] };
  expect(await (await send('/api/alerts/confirmations?dry_run=true', checks)).json()).toMatchObject({ committed: false, counts: { confirmed: 1 } });
  const batch = await send('/api/alerts/confirmations', checks);
  if (enabled) {
    expect(batch.status).toBe(200); expect((await json(`/api/alerts/${opened.alert_id}?history=coalesced`)).alert.history[1].confirmation_run.count).toBe(1);
  } else {
    expect(batch.status).toBe(503); expect(batch.headers.get('Retry-After')).toBeNull();
    expect(await batch.json()).toMatchObject({ code: 'confirmations_not_enabled', retryable: false, publication_status: 'not_attempted' });
    expect((await send('/api/alerts', { ...checks.confirmations[0], phase: 'update' })).status).toBe(200);
  }
  expect((await json(`/api/alerts/${opened.alert_id}?fields=index`)).alert).not.toHaveProperty('history');
  const resolved: any = await (await send('/api/alerts', { ...common, client_ref: crypto.randomUUID(), alert_id: opened.alert_id, phase: 'resolved' })).json();
  expect(resolved.expires_at).toBeNull(); expect(await (await request('/')).text()).not.toContain(input.headline);
  expect(await (await send(`/api/alerts/${opened.alert_id}/entries/${resolved.entry_id}/retract`)).json()).toMatchObject({ state: 'open' });
  expect(await (await request('/')).text()).toContain(input.headline);
});
it('pins reconciliation pages through concurrent writes and converges after incremental removals', async () => {
  const initial: any = await (await send('/api/digests', digest({ items: Array.from({ length: 23 }, (_, i) => item({ headline: `Pinned ${i}` })) }))).json();
  const first = await json('/api/changes'); expect(first.changes).toHaveLength(20); expect(first.sync_cursor).toBeNull();
  await send('/api/digests', digest({ items: [item({ headline: 'Concurrent publication' })] }));
  const second = await json(`/api/changes?cursor=${encodeURIComponent(first.next_cursor)}`); expect(second.as_of).toBe(first.as_of); expect(second.changes).toHaveLength(3);
  const local = new Map([...first.changes, ...second.changes].map((change: any) => [JSON.stringify(change.identity), change.data]));
  await send(`/api/posts/${initial.post.id}/retract`);
  let page = await json(`/api/changes?since=${encodeURIComponent(second.sync_cursor)}`);
  do {
    for (const change of page.changes) { const key = JSON.stringify(change.identity); if (change.operation === 'remove') local.delete(key); else local.set(key, change.data); }
    if (!page.next_cursor) break; page = await json(`/api/changes?cursor=${encodeURIComponent(page.next_cursor)}`);
  } while (true);
  const full = await json('/api/posts'); expect(local.size).toBe(1); expect(full.posts).toHaveLength(1);
  expect([...local.values()][0]).toMatchObject({ headline: full.posts[0].items[0].headline });
});
it('validates multipart input and serves uploaded originals and explicit thumbnail validators', async () => {
  expect((await send('/api/images')).status).toBe(415);
  const bytes = await readFile(new NodeURL('../fixtures/thumbnail-transparent.png', import.meta.url));
  const form = new FormData(); form.append('file', new File([bytes], 'fixture.png', { type: 'image/png' }));
  const upload: any = await (await request('/api/images', { method: 'POST', body: form })).json();
  const path = new URL(upload.url).pathname; const original = await request(path); expect(new Uint8Array(await original.arrayBuffer())).toEqual(new Uint8Array(bytes));
  const thumbPath = `/thumbnails/v2/${path.split('/').at(-1)}/96.png`; const thumb = await request(thumbPath); expect(thumb.status).toBe(200); expect(thumb.headers.get('Content-Type')).toBe('image/png');
  expect((await request(thumbPath, { headers: { 'If-None-Match': thumb.headers.get('ETag')! } })).status).toBe(304);
  expect((await (await request(thumbPath, { method: 'HEAD' })).arrayBuffer()).byteLength).toBe(0);
});
it('rebuilds supported legacy content and recovers queued work after eviction', async () => {
  const worker = server.getWorker<Env>(); const bindings = await worker.getEnv(); const input = digest();
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  await bindings.SITE_BUCKET.put(`digests/${date}.json`, JSON.stringify({ ...input, date }));
  expect((await request('/api/posts')).status).toBe(200);
  const queued: any = await (await send('/api/rebuild')).json(); expect(queued.job.id).toBeTruthy();
  await worker.evictDurableObject('PUBLISHER', { name: 'site' });
  let job;
  const deadline = performance.now() + 15000;
  do { job = (await json(`/api/rebuild/${queued.job.id}`)).job; if (job.status === 'completed' || job.status === 'failed') break; await new Promise(resolve => setTimeout(resolve, 100)); } while (performance.now() < deadline);
  expect(job.status).toBe('completed'); expect(await (await request('/')).text()).toContain(input.items[0].headline);
});
it('dispatches scheduled weather pulls, revalidates upstream, and preserves the last valid page on failure', async () => {
  const realFetch = globalThis.fetch; const upstream = vi.fn(async (_url: any, _init?: any): Promise<Response> => Response.json(fixture.expected, { headers: { ETag: '"weather-fixture"' } }));
  vi.spyOn(globalThis, 'fetch').mockImplementation((url: any, init?: any) => String(url).includes('raw.githubusercontent.com') ? upstream(url, init) : realFetch(url, init));
  const worker = server.getWorker();
  await worker.scheduled({ cron: '*/10 * * * *', scheduledTime: new Date() });
  const page = await request('/'); const html = await page.text(); expect(html).toContain('Today on the mountain');
  upstream.mockImplementation(async (_url, init) => { expect(init?.headers?.['If-None-Match']).toBe('"weather-fixture"'); return new Response(null, { status: 304 }); });
  await worker.scheduled({ cron: '*/10 * * * *', scheduledTime: new Date() });
  expect((await request('/')).headers.get('ETag')).toBe(page.headers.get('ETag'));
  upstream.mockImplementation(async () => new Response('unavailable', { status: 503 }));
  await worker.scheduled({ cron: '*/10 * * * *', scheduledTime: new Date() });
  expect(await (await request('/')).text()).toBe(html);
});
it('keeps ownership across credential rotation and derives expiry through HTTP reads', async () => {
  const input = digest(); const published: any = await (await send('/api/digests', input)).json();
  const rotated = secret + '-rotated';
  await server.update({ workers: [{ ...options().workers[0], secrets: { API_SECRET: rotated } }] });
  const rejected = await request(`/api/posts/${published.post.id}/retract`, { method: 'POST', headers: { Authorization: `Bearer ${rotated}` } });
  expect(rejected.status).toBe(403);
  await server.update(options());
  const old = { source: 'caltrans', source_url: 'https://example.com/expired', observed_at: new Date(Date.now() - 25 * 3600000).toISOString(), client_ref: crypto.randomUUID(), phase: 'open', category: 'traffic', kind: 'hazard', routes: ['SR-18'], headline: 'Needs confirmation' };
  const opened: any = await (await send('/api/alerts', old)).json(); expect(opened.state).toBe('expired-unconfirmed');
  expect((await json(`/api/alerts/${opened.alert_id}`)).alert.state).toBe('expired-unconfirmed');
  const confirmed: any = await (await send('/api/alerts', { source: old.source, source_url: old.source_url, observed_at: new Date().toISOString(), client_ref: crypto.randomUUID(), phase: 'update', alert_id: opened.alert_id })).json();
  expect(confirmed.state).toBe('open');
});
it('rejects malformed, non-UTF8 and oversized bodies before attempting publication', async () => {
  for (const [body, contentType, code, status] of [
    ['{', 'application/json', 'invalid_json', 400], [new Uint8Array([255]), 'application/json', 'invalid_utf8', 400],
    ['{}', 'text/plain', 'unsupported_media_type', 415], ['x'.repeat(1024 * 1024 + 1), 'application/json', 'body_too_large', 413],
  ] as const) {
    const response = await request('/api/digests', { method: 'POST', headers: { 'Content-Type': contentType }, body });
    expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ code, retryable: false, publication_status: 'not_attempted' });
  }
  const bindings = await server.getWorker<Env>().getEnv(); expect((await bindings.SITE_BUCKET.list()).objects).toHaveLength(0);
});
