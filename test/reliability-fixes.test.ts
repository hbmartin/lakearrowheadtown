import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import worker from '../src/worker';
import { currentPublication, loadPost, publishDigest, rebuildHomepage, retractPost } from '../src/publishing';
import { loadCatalog, loadArchiveDay, stableJson, type ArchiveCatalog, type ArchiveDay } from '../src/archives';
import { fingerprint, OperationTrace } from '../src/diagnostics';
import { prepareWrites } from '../src/prepared-writes';
import * as social from '../src/social';
import * as rendering from '../src/render';
import type { ContentBucket, Digest, Env, PublishResult } from '../src/types';

const bindings = env as unknown as Env;
const origin = 'https://lakearrowhead.town';
const at = new Date('2026-10-20T18:00:00Z');
const secret = 'test-secret-at-least-thirty-two-characters-long';
const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
const owner = fingerprint(secret);
const context = { request_id: 'reliability-test', worker_version: 'test', environment: 'preview', operation: 'rebuild' };
const publisher = () => bindings.PUBLISHER.getByName('site');
const inPublisher = runInDurableObject as unknown as <T>(stub: unknown, callback: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
const digest = (name = 'Original', posted_at = at.toISOString()): Digest => ({ title: 'Batch', source: 'Community', items: [{
  group: 'Group', group_url: origin, headline: name, body: 'A story.', category: 'alert', post_url: `${origin}/source/${name}`, posted_at,
}] });
const request = (path: string, body?: unknown) => worker.fetch(new Request(origin + path, {
  method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), bindings);
const store = (overrides: Partial<ContentBucket> = {}): ContentBucket => ({ get: key => bindings.SITE_BUCKET.get(key), head: key => bindings.SITE_BUCKET.head(key),
  put: (key, body, options) => bindings.SITE_BUCKET.put(key, body, options), list: options => bindings.SITE_BUCKET.list(options), ...overrides });
const catalog = async () => loadCatalog(bindings.SITE_BUCKET, (await currentPublication(bindings.SITE_BUCKET)).archives);
async function jsonObject(prefix: string, value: unknown, pretty = false) {
  const body = pretty ? JSON.stringify(value, null, 2) : stableJson(value); const key = `${prefix}/${fingerprint(body)}.json`;
  await bindings.SITE_BUCKET.put(key, body); return key;
}
async function commitCatalog(value: ArchiveCatalog) {
  const page = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
  const publication = await currentPublication(bindings.SITE_BUCKET);
  const archives = await jsonObject('archive-catalogs', value);
  const manifest = `publications/${crypto.randomUUID()}.json`;
  await bindings.SITE_BUCKET.put(manifest, JSON.stringify({ ...publication, archives }));
  await bindings.SITE_BUCKET.put('pages/index.html', await page.text(), { httpMetadata: page.httpMetadata, customMetadata: { ...page.customMetadata, manifest, archives } });
}
async function seedArchives(count = 23, pretty = false) {
  const first = await publishDigest(bindings.SITE_BUCKET, digest(), origin, at, true, undefined, { publisherFingerprint: owner });
  const value = await catalog();
  const png = await (await bindings.SITE_BUCKET.get(value.days['2026-10-20'].image.slice(1)))!.arrayBuffer();
  for (let i = 1; i <= count; i++) {
    const date = `2026-08-${String(i).padStart(2, '0')}`; const activity = `${date}T18:00:00Z`;
    const postId = `historical-${i}`;
    const day: ArchiveDay = { date, images: {}, stories: [{ postId, itemIndex: 0, date, activity, timestamp: Date.parse(activity), item: digest(postId, activity).items[0] }] };
    const image = `/assets/daily/${fingerprint(date)}.png`;
    await bindings.SITE_BUCKET.put(image.slice(1), png); // Legacy card without cardInputHash.
    value.days[date] = { key: await jsonObject('archive-days', day, pretty), image, cardVersion: social.DAILY_CARD_VERSION, identities: [`${postId}:0`], modified: activity };
  }
  await commitCatalog(value);
  return first;
}
async function finish(id: string) {
  for (let i = 0; i < 12; i++) {
    const status = await publisher().jobStatus(id);
    if (status?.status === 'completed' || status?.status === 'failed') return status;
    await runDurableObjectAlarm(publisher());
  }
  throw new Error('Rebuild did not finish within the test budget');
}
let events: any[];
beforeEach(async () => {
  vi.restoreAllMocks(); await reset(); events = [];
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(value => events.push(value));
});

describe('safe requests and repair contracts', () => {
  it.each(['true', 'false', '', 'true&dry_run=false'])('rejects unsupported dry_run=%s before reading bodies or invoking mutations', async value => {
    const getByName = vi.fn();
    for (const path of ['/api/images', '/api/posts/missing/retract', '/api/rebuild', '/api/rebuild/00000000-0000-0000-0000-000000000001/resume']) {
      const input = new Request(`${origin}${path}?dry_run=${value}`, { method: 'POST', headers, body: 'not JSON' });
      const read = vi.spyOn(input.body!, 'getReader');
      const response = await worker.fetch(input, { ...bindings, PUBLISHER: { getByName } as unknown as Env['PUBLISHER'] });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, code: 'invalid_dry_run', suggestion: { action: 'remove_dry_run' } });
      expect(read).not.toHaveBeenCalled();
    }
    expect(getByName).not.toHaveBeenCalled();
    expect((await bindings.SITE_BUCKET.list()).objects).toEqual([]);
  });

  it('stops completed migration without a manifest and recovers only after an explicit operator manifest repair', async () => {
    const first = await publishDigest(bindings.SITE_BUCKET, digest(), origin, at, true);
    const page = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
    const html = await page.text(); const metadata = page.customMetadata!;
    await inPublisher(publisher(), async (_instance, state) => state.storage.put('migration', { complete: true, processed: 1 }));
    const { manifest: _manifest, ...broken } = metadata;
    await bindings.SITE_BUCKET.put('pages/index.html', html, { customMetadata: broken });
    const original = (await bindings.SITE_BUCKET.head('pages/index.html'))!;
    const blocked = await request('/api/digests', digest('Must-not-publish'));
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toMatchObject({ code: 'legacy_recovery_required', retryable: false, publication_status: 'not_committed' });
    const job = await publisher().enqueueRebuild(origin);
    await runDurableObjectAlarm(publisher());
    expect(await publisher().jobStatus(job.id)).toMatchObject({ status: 'failed', error_code: 'legacy_recovery_required' });
    expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.etag).toBe(original.etag);
    expect(await inPublisher(publisher(), async (_instance, state) => state.storage.get('migration'))).toEqual({ complete: true, processed: 1 });
    await bindings.SITE_BUCKET.put('pages/index.html', html, { customMetadata: metadata });
    await publisher().resumeRebuild(job.id);
    expect(await finish(job.id)).toMatchObject({ status: 'completed' });
    expect((await currentPublication(bindings.SITE_BUCKET)).posts[0].id).toBe(first.post!.id);
  });

  it.each(['publish', 'append', 'retract', 'preview_digest', 'preview_append'] as const)('blocks %s without reads, discovery, or writes when a completed migration loses its manifest', async operation => {
    const first = await (await request('/api/digests', digest())).json<PublishResult>();
    const page = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
    const { manifest: _manifest, ...metadata } = page.customMetadata!;
    await bindings.SITE_BUCKET.put('pages/index.html', await page.text(), { customMetadata: metadata });
    const spies: { mockRestore(): void }[] = [];
    const forbidden = vi.fn();
    await inPublisher(publisher(), async (instance, state) => {
      await state.storage.put('migration', { complete: true, processed: 1 });
      for (const method of ['get', 'list', 'put'] as const) {
        const original = instance.env.SITE_BUCKET[method].bind(instance.env.SITE_BUCKET);
        spies.push(vi.spyOn(instance.env.SITE_BUCKET, method).mockImplementation((...args: any[]) => { forbidden(); return original(...args); }));
      }
      const put = state.storage.put.bind(state.storage);
      spies.push(vi.spyOn(state.storage, 'put').mockImplementation((...args: any[]) => { forbidden(); return (put as any)(...args); }));
    });
    const preview = operation.startsWith('preview');
    const path = operation === 'publish' || operation === 'preview_digest' ? '/api/digests'
      : operation === 'retract' ? `/api/posts/${first.post!.id}/retract` : `/api/posts/${first.post!.id}/items/0/updates`;
    const payload = operation === 'publish' || operation === 'preview_digest' ? digest('Blocked')
      : { group: 'Group', body: 'Blocked update', post_url: `${origin}/blocked-update`, posted_at: at.toISOString() };
    try {
      const response = await request(path + (preview ? '?dry_run=true' : ''), payload);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'legacy_recovery_required', retryable: false,
        publication_status: preview ? 'not_attempted' : 'not_committed', ...(preview ? { dry_run: true, committed: false } : {}) });
      expect(forbidden).not.toHaveBeenCalled();
    } finally { for (const spy of spies) spy.mockRestore(); }
  });

  it('isolates batch lookup from a damaged direct archive pointer, but keeps mutations and archive reads closed', async () => {
    const first = await (await request('/api/digests', { ...digest(), client_ref: 'lookup' })).json<PublishResult>();
    const page = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
    await bindings.SITE_BUCKET.put('pages/index.html', await page.text(), { customMetadata: { ...page.customMetadata, archives: 'bad-pointer' } });
    expect(await (await request('/api/digests?client_ref=lookup')).json()).toMatchObject({ ok: true, post: first.post });
    const failed = await request('/api/digests', digest('blocked'));
    expect(failed.status).toBe(503); expect(failed.headers.get('Retry-After')).toBeNull();
    expect(await failed.json()).toMatchObject({ code: 'archive_damaged', retryable: false });
    expect((await request('/archive/')).status).toBe(503);
    const key = page.customMetadata!.manifest;
    await bindings.SITE_BUCKET.put(key, 'private broken JSON');
    const lookup = await request('/api/digests?client_ref=lookup');
    expect(lookup.status).toBe(500);
    expect(events).toContainEqual(expect.objectContaining({ event: 'batch_lookup_failed', error_code: 'manifest_damaged', manifest_key: key }));
    expect(JSON.stringify(events)).not.toContain('private broken JSON');
  });

  it('does not discover raw legacy digests when no batch manifest exists', async () => {
    await bindings.SITE_BUCKET.put('digests/2026-10-20.json', JSON.stringify(digest()));
    let list!: ReturnType<typeof vi.spyOn>;
    await inPublisher(publisher(), async instance => { list = vi.spyOn(instance.env.SITE_BUCKET, 'list'); });
    try { expect((await request('/api/digests?client_ref=absent')).status).toBe(404); }
    finally { expect(list).not.toHaveBeenCalled(); list.mockRestore(); }
  });

  it('uses retraction deadlines in failure advice and logs repeated retraction as a no-op', async () => {
    const first = await (await request('/api/digests', digest())).json<PublishResult>();
    const path = `/api/posts/${first.post!.id}/retract`;
    const unavailable = await worker.fetch(new Request(origin + path, { method: 'POST', headers }), {
      ...bindings, PUBLISHER: { getByName: () => ({ retractPostV1: async () => { throw new Error('private RPC error'); } }) } as unknown as Env['PUBLISHER'],
    });
    const failure = await unavailable.json<any>();
    expect(failure).toMatchObject({ publication_status: 'unknown', retryable: true });
    expect(failure.message).toContain('24 hours'); expect(failure.suggestion.message).toContain('24 hours');
    expect(failure.message).not.toContain('30'); expect(failure.suggestion.message).not.toContain('30');
    const notCommitted = await worker.fetch(new Request(origin + path, { method: 'POST', headers }), {
      ...bindings, PUBLISHER: { getByName: () => ({ retractPostV1: async () => ({ ok: false, failure: { status: 500, code: 'storage_error', error: 'Storage failed',
        stage: 'source_write', publication_status: 'not_committed', retryable: true } }) }) } as unknown as Env['PUBLISHER'],
    });
    const uncommitted = await notCommitted.json<any>();
    expect(uncommitted.message).toContain('24 hours'); expect(uncommitted.message).not.toContain('30');
    expect((await request(path, {})).status).toBe(200);
    const repeated = await request(path, {}); const result = await repeated.json<any>();
    expect(result.status).toBe('already_retracted');
    expect(events.find(event => event.event === 'request_completed' && event.request_id === result.request_id)).toMatchObject({ publication_outcome: 'already_retracted', publication_status: undefined });
  });

  it('removes only fully empty days and preserves other stories and old immutable objects', async () => {
    const a = await publishDigest(bindings.SITE_BUCKET, digest('A', '2026-10-19T18:00:00Z'), origin, at, true, undefined, { publisherFingerprint: owner });
    const b = await publishDigest(bindings.SITE_BUCKET, digest('B', '2026-10-19T19:00:00Z'), origin, at, true, undefined, { publisherFingerprint: owner });
    const old = (await catalog()).days['2026-10-19'];
    await retractPost(bindings.SITE_BUCKET, a.post!.id, owner, origin, at, true);
    expect((await loadArchiveDay(bindings.SITE_BUCKET, '2026-10-19', (await catalog()).days['2026-10-19'])).stories.map(story => story.item.headline)).toEqual(['B']);
    await retractPost(bindings.SITE_BUCKET, b.post!.id, owner, origin, at, true);
    expect((await catalog()).days).toEqual({});
    expect((await request('/2026/10/19/')).status).toBe(404);
    expect(await (await request('/archive/')).text()).not.toContain('/2026/10/19/');
    expect(await (await request('/sitemap.xml')).text()).not.toContain('/2026/10/19/');
    expect(await bindings.SITE_BUCKET.head(old.key)).not.toBeNull();
    const empty = await catalog();
    empty.days['2026-10-18'] = { ...old, key: await jsonObject('archive-days', { date: '2026-10-18', stories: [], images: {} }), identities: [] };
    await commitCatalog(empty);
    await rebuildHomepage(bindings.SITE_BUCKET, origin);
    expect((await catalog()).days).toEqual({});
    expect((await request('/2026/10/18/')).status).toBe(404);
  });
});

describe('bounded resumable archive rebuilds', () => {
  it('returns explicit pending and committed results and writes aggregate checkpoints only for pending work', async () => {
    await seedArchives(12);
    const work = { jobId: crypto.randomUUID() };
    const pending = await rebuildHomepage(bindings.SITE_BUCKET, origin, undefined, true, undefined, work);
    expect(pending).toMatchObject({ kind: 'pending', progress: { completed_days: 10, total_days: 13 } });
    if (pending.kind !== 'pending') throw new Error('Expected pending archive work');
    expect(await bindings.SITE_BUCKET.head(pending.checkpoint)).not.toBeNull();
    const committed = await rebuildHomepage(bindings.SITE_BUCKET, origin, undefined, true, undefined, { ...work, checkpoint: pending.checkpoint });
    expect(committed).toEqual({ kind: 'committed', progress: { completed_days: 13, total_days: 13 } });
    expect((await bindings.SITE_BUCKET.list({ prefix: `rebuild-work/${work.jobId}/checkpoints/` })).objects).toHaveLength(1);
  });

  it('ties the final index check to the alarm snapshot even if the index changes before helper entry', async () => {
    await publishDigest(bindings.SITE_BUCKET, digest('Older'), origin, at, true);
    const older = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
    const olderHtml = await older.text();
    await publishDigest(bindings.SITE_BUCKET, digest('Newer'), origin, new Date(at.getTime() + 3600000), true);
    const newer = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
    const newerHtml = await newer.text();
    await bindings.SITE_BUCKET.put('pages/index.html', olderHtml, { customMetadata: older.customMetadata });
    await inPublisher(publisher(), async (_instance, state) => state.storage.put('migration', { complete: true, processed: 2 }));
    const job = await publisher().enqueueRebuild(origin, context);
    let restore!: () => void;
    await inPublisher(publisher(), async instance => {
      const bucket = instance.env.SITE_BUCKET; const head = bucket.head.bind(bucket);
      let changed = false;
      const spy = vi.spyOn(bucket, 'head').mockImplementation(async (key: any) => {
        const result = await head(key);
        if (key === 'pages/index.html' && !changed) {
          changed = true;
          await bucket.put(key, newerHtml, { customMetadata: newer.customMetadata });
        }
        return result;
      });
      restore = () => spy.mockRestore();
    });
    try { await runDurableObjectAlarm(publisher()); } finally { restore(); }
    expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.customMetadata).toEqual(newer.customMetadata);
    expect(await publisher().jobStatus(job.id)).toMatchObject({ status: 'running', phase: 'render', archive_progress: { completed_days: 1, total_days: 1 } });
    expect((await bindings.SITE_BUCKET.list({ prefix: `rebuild-work/${job.id}/checkpoints/` })).objects).toEqual([]);
    expect(await finish(job.id)).toMatchObject({ status: 'completed' });
    const html = await (await bindings.SITE_BUCKET.get('pages/index.html'))!.text();
    expect(html).toContain('Newer'); expect(html).toContain('Older');
    expect((await bindings.SITE_BUCKET.list({ prefix: `rebuild-work/${job.id}/checkpoints/` })).objects).toEqual([]);
  });

  it('renders one day at a time and persists its image, JSON, and receipt before starting the next day', async () => {
    await seedArchives(12, true);
    const order: string[] = []; let active = 0; let peak = 0;
    const render = vi.spyOn(social, 'dailyCard').mockImplementation(async (date, headline) => {
      order.push(`render:${date}`); active++; peak = Math.max(peak, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 0));
        return new TextEncoder().encode(date + headline);
      } finally { active--; }
    });
    const job = await publisher().enqueueRebuild(origin);
    let restore!: () => void;
    const receipts = new Map<string, { key: string; image: string }>();
    await inPublisher(publisher(), async instance => {
      const put = instance.env.SITE_BUCKET.put.bind(instance.env.SITE_BUCKET);
      const spy = vi.spyOn(instance.env.SITE_BUCKET, 'put').mockImplementation(async (key: any, body: any, options: any) => {
        const result = await put(key, body, options);
        order.push(`saved:${key}`);
        const date = /\/days\/(\d{4}-\d{2}-\d{2})\//.exec(key)?.[1];
        if (date) receipts.set(date, JSON.parse(body).result.reference);
        return result;
      });
      restore = () => spy.mockRestore();
    });
    try { await runDurableObjectAlarm(publisher()); } finally { restore(); }
    expect(peak).toBe(1); expect(active).toBe(0);
    expect(render).toHaveBeenCalledTimes(10); expect(receipts.size).toBe(10);
    expect(await publisher().jobStatus(job.id)).toMatchObject({ status: 'running', archive_progress: { completed_days: 10, total_days: 13 } });
    for (const [i, [date]] of render.mock.calls.entries()) {
      const ref = receipts.get(date)!;
      const imageSaved = order.indexOf(`saved:${ref.image.slice(1)}`);
      const daySaved = order.indexOf(`saved:${ref.key}`);
      const receiptSaved = order.findIndex(entry => entry.startsWith('saved:rebuild-work/') && entry.includes(`/days/${date}/`));
      expect(imageSaved).toBeGreaterThan(order.indexOf(`render:${date}`));
      expect(daySaved).toBeGreaterThan(order.indexOf(`render:${date}`));
      expect(receiptSaved).toBeGreaterThan(Math.max(imageSaved, daySaved));
      if (i + 1 < render.mock.calls.length) expect(receiptSaved).toBeLessThan(order.indexOf(`render:${render.mock.calls[i + 1][0]}`));
    }
  });

  it('rechecks metadata-only snapshot changes after rendering and before committing', async () => {
    await publishDigest(bindings.SITE_BUCKET, digest(), origin, at, true);
    const original = (await bindings.SITE_BUCKET.head('pages/index.html'))!;
    let reads = 0;
    const put = vi.fn(store().put);
    const result = await rebuildHomepage(store({ put, head: async key => {
      const object = await bindings.SITE_BUCKET.head(key);
      if (key === 'pages/index.html' && ++reads === 2) return { ...object!, customMetadata: { ...object!.customMetadata, manifest: 'publications/newer.json' },
        writeHttpMetadata: headers => object!.writeHttpMetadata(headers) };
      return object;
    } }), origin, new OperationTrace(context), true, undefined, { jobId: crypto.randomUUID() });
    expect(result).toMatchObject({ kind: 'reconcile', progress: { completed_days: 1, total_days: 1 } });
    expect(put.mock.calls.some(([key]) => key === 'pages/index.html')).toBe(false);
    expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.customMetadata).toEqual(original.customMetadata);
  });

  it('reuses terminal receipts after reconciliation from an older aggregate checkpoint', async () => {
    await seedArchives(12, true);
    const render = vi.spyOn(social, 'dailyCard').mockImplementation(async (date, headline) => new TextEncoder().encode(date + headline));
    const work = { jobId: crypto.randomUUID() };
    const pending = await rebuildHomepage(bindings.SITE_BUCKET, origin, undefined, true, undefined, work);
    if (pending.kind !== 'pending') throw new Error('Expected incomplete archive pass');
    expect(pending.progress).toEqual({ completed_days: 10, total_days: 13 });
    const before = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
    const html = await before.text(); let reads = 0;
    const revised = { ...before.customMetadata, operator_revision: 'corrected' };
    const stale = await rebuildHomepage(store({ head: async key => {
      if (key === 'pages/index.html' && ++reads === 2) await bindings.SITE_BUCKET.put(key, html, { customMetadata: revised });
      return bindings.SITE_BUCKET.head(key);
    } }), origin, undefined, true, undefined, { ...work, checkpoint: pending.checkpoint });
    expect(stale).toEqual({ kind: 'reconcile', progress: { completed_days: 13, total_days: 13 } });
    expect(render).toHaveBeenCalledTimes(12);
    expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.customMetadata).toEqual(revised);
    expect((await bindings.SITE_BUCKET.list({ prefix: `rebuild-work/${work.jobId}/checkpoints/` })).objects).toHaveLength(1);
    const repaired = await rebuildHomepage(bindings.SITE_BUCKET, origin, undefined, true, undefined, { ...work, checkpoint: pending.checkpoint });
    expect(repaired).toEqual({ kind: 'committed', progress: { completed_days: 13, total_days: 13 } });
    expect(render).toHaveBeenCalledTimes(12);
    expect((await bindings.SITE_BUCKET.list({ prefix: `rebuild-work/${work.jobId}/checkpoints/` })).objects).toHaveLength(1);
  });

  it('checkpoints ten days per alarm, survives eviction, and preserves interleaved publications and retractions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    // Keep platform alarm scheduling on the real clock while requests use the fixture date.
    vi.spyOn(Date, 'now').mockImplementation(vi.getRealSystemTime);
    onTestFinished(() => { vi.useRealTimers(); });
    const first = await seedArchives();
    const survivor = await publishDigest(bindings.SITE_BUCKET, digest('Survivor'), origin, at, true);
    const before = (await bindings.SITE_BUCKET.head('pages/index.html'))!.etag;
    const render = vi.spyOn(social, 'dailyCard').mockImplementation(async (date, headline) => new TextEncoder().encode(date + headline));
    const job = await publisher().enqueueRebuild(origin, context);
    await runDurableObjectAlarm(publisher());
    expect(render).toHaveBeenCalledTimes(10);
    expect(await publisher().jobStatus(job.id)).toMatchObject({ status: 'running', archive_progress: { completed_days: 10, total_days: 24 } });
    expect((await bindings.SITE_BUCKET.list({ prefix: `rebuild-work/${job.id}/checkpoints/` })).objects).toHaveLength(1);
    expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.etag).toBe(before);
    await evictDurableObject(publisher());
    const newer = await request('/api/digests', digest('Newer'));
    expect(newer.status).toBe(200);
    const newerPost = await newer.json<PublishResult>();
    const update = { group: 'Group', post_url: `${origin}/surviving-update`, body: 'Surviving update', posted_at: at.toISOString() };
    expect((await request(`/api/posts/${survivor.post!.id}/items/0/updates`, update)).status).toBe(200);
    expect((await request(`/api/posts/${first.post!.id}/retract`, {})).status).toBe(200);
    const latest = (await bindings.SITE_BUCKET.head('pages/index.html'))!.etag;
    const rendersBeforeNextAlarm = render.mock.calls.length;
    await runDurableObjectAlarm(publisher());
    expect(render).toHaveBeenCalledTimes(rendersBeforeNextAlarm + 10);
    expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.etag).toBe(latest);
    expect(await finish(job.id)).toMatchObject({ status: 'completed', archive_progress: { completed_days: 24, total_days: 24 } });
    expect((await bindings.SITE_BUCKET.list({ prefix: `rebuild-work/${job.id}/checkpoints/` })).objects).toHaveLength(2);
    expect(render).toHaveBeenCalledTimes(rendersBeforeNextAlarm + 13);
    const html = await (await request('/')).text();
    expect(html).toContain('Newer'); expect(html).not.toContain('>Original</a>'); expect(html).toContain(update.body);
    const publication = await currentPublication(bindings.SITE_BUCKET);
    expect((await loadPost(bindings.SITE_BUCKET, publication.posts.find(post => post.id === first.post!.id)!)).retracted_at).toBeTruthy();
    const stored = await loadPost(bindings.SITE_BUCKET, publication.posts.find(post => post.id === survivor.post!.id)!);
    expect(stored.items[0].updates).toMatchObject([update]);
    const value = await catalog();
    const day = await loadArchiveDay(bindings.SITE_BUCKET, '2026-10-20', value.days['2026-10-20']);
    expect(day.stories.find(story => story.postId === survivor.post!.id)!.item.updates).toMatchObject([update]);
    expect(day.stories.some(story => story.postId === newerPost.post!.id)).toBe(true);
    expect(day.stories.some(story => story.postId === first.post!.id)).toBe(false);
    expect(await (await request('/rss.xml')).text()).toContain(update.body);
    for (const fields of ['full', 'index']) {
      const read = await (await request(`/api/posts?days=30&fields=${fields}`)).json<any>();
      const story = read.posts.find((post: any) => post.post_id === survivor.post!.id).items[0];
      expect(story).toMatchObject({ item_index: 0, updates: [{ update_index: 0, post_url: update.post_url, posted_at: update.posted_at }] });
      if (fields === 'full') expect(story.updates[0].body).toBe(update.body);
      else expect(story.updates[0]).not.toHaveProperty('body');
      expect(read.posts.some((post: any) => post.post_id === newerPost.post!.id)).toBe(true);
      expect(read.posts.some((post: any) => post.post_id === first.post!.id)).toBe(false);
    }
    expect(events.filter(event => event.event === 'operation_stage' && ['rebuild_finalize', 'rebuild_failure_record'].includes(event.stage)).every(event => event.phase === undefined)).toBe(true);
    expect(JSON.stringify(await publisher().jobStatus(job.id))).not.toContain('rebuild-work/');
  });

  it('invalidates changed day inputs and never restores a day removed between alarms', async () => {
    await seedArchives();
    const render = vi.spyOn(social, 'dailyCard').mockImplementation(async (date, headline) => new TextEncoder().encode(date + headline));
    const job = await publisher().enqueueRebuild(origin);
    await runDurableObjectAlarm(publisher());
    const value = await catalog();
    const day = await loadArchiveDay(bindings.SITE_BUCKET, '2026-08-01', value.days['2026-08-01']);
    day.stories[0].item.headline = 'Corrected historical headline';
    value.days['2026-08-01'].key = await jsonObject('archive-days', day);
    delete value.days['2026-08-02'];
    await commitCatalog(value);
    expect(await finish(job.id)).toMatchObject({ status: 'completed' });
    const final = await catalog();
    expect(final.days['2026-08-02']).toBeUndefined();
    expect((await loadArchiveDay(bindings.SITE_BUCKET, '2026-08-01', final.days['2026-08-01'])).stories[0].item.headline).toBe('Corrected historical headline');
    expect(render.mock.calls.filter(([date]) => date === '2026-08-01')).toHaveLength(2);
    expect(render.mock.calls.filter(([date]) => date === '2026-08-03')).toHaveLength(1);
  });

  it('reloads same-key source corrections between archive alarms', async () => {
    const original = await seedArchives(12);
    const job = await publisher().enqueueRebuild(origin);
    await runDurableObjectAlarm(publisher());
    const publication = await currentPublication(bindings.SITE_BUCKET);
    const ref = publication.posts.find(post => post.id === original.post!.id)!;
    const post = await loadPost(bindings.SITE_BUCKET, ref);
    post.items[0].body = 'Corrected body between alarms'; post.items[0].headline = 'Corrected headline';
    await bindings.SITE_BUCKET.put(ref.key, JSON.stringify(post));
    expect(await finish(job.id)).toMatchObject({ status: 'completed' });
    const html = await (await bindings.SITE_BUCKET.get('pages/index.html'))!.text();
    expect(html).toContain(post.items[0].body); expect(html).toContain(post.items[0].headline);
    const value = await catalog();
    expect((await loadArchiveDay(bindings.SITE_BUCKET, '2026-10-20', value.days['2026-10-20'])).stories[0].item.body).toBe(post.items[0].body);
  });

  it.each(['rendering', 'rebuild_finalize'] as const)('reuses completed day receipts after %s fails on the terminal alarm', async stage => {
    await seedArchives(12);
    const render = vi.spyOn(social, 'dailyCard').mockImplementation(async (date, headline) => new TextEncoder().encode(date + headline));
    const job = await publisher().enqueueRebuild(origin, context);
    await runDurableObjectAlarm(publisher());
    const before = (await bindings.SITE_BUCKET.head('pages/index.html'))!.customMetadata;
    let injected = false; let restore!: () => void;
    if (stage === 'rendering') {
      const spy = vi.spyOn(rendering, 'renderPage').mockImplementationOnce(() => { injected = true; throw new Error('Injected final rendering failure'); });
      restore = () => spy.mockRestore();
    } else {
      await inPublisher(publisher(), async (_instance, state) => {
        const transaction = state.storage.transaction.bind(state.storage);
        const spy = vi.spyOn(state.storage, 'transaction').mockImplementation(callback => transaction(storage => callback(new Proxy(storage, {
          get(target, property) {
            if (property === 'delete') return (key: string) => {
              if (key === `rebuild:${job.id}` && !injected) { injected = true; throw new Error('Injected finalization failure'); }
              return target.delete(key);
            };
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }))));
        restore = () => spy.mockRestore();
      });
    }
    try { await runDurableObjectAlarm(publisher()); } finally { restore(); }
    expect(injected).toBe(true);
    expect(await publisher().jobStatus(job.id)).toMatchObject({ status: 'failed', failed_stage: stage });
    expect(render).toHaveBeenCalledTimes(12);
    const after = (await bindings.SITE_BUCKET.head('pages/index.html'))!.customMetadata;
    if (stage === 'rendering') expect(after).toEqual(before);
    else expect(after!.manifest).not.toBe(before!.manifest);
    expect((await bindings.SITE_BUCKET.list({ prefix: `rebuild-work/${job.id}/checkpoints/` })).objects).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ event: 'rebuild_failed', stage, publication_status: stage === 'rendering' ? 'not_committed' : 'committed' }));
    await publisher().resumeRebuild(job.id); await evictDurableObject(publisher());
    expect(await finish(job.id)).toMatchObject({ status: 'completed' });
    expect(render).toHaveBeenCalledTimes(12);
  });

  it.each(['archive_image_write', 'rebuild_archive_checkpoint'])('retains completed repair work after failure at %s', async stage => {
    await seedArchives(12);
    const render = vi.spyOn(social, 'dailyCard').mockImplementation(async (date, headline) => new TextEncoder().encode(date + headline));
    const job = await publisher().enqueueRebuild(origin, context);
    const before = (await bindings.SITE_BUCKET.head('pages/index.html'))!.etag;
    let restore!: () => void;
    await inPublisher(publisher(), async instance => {
      const put = instance.env.SITE_BUCKET.put.bind(instance.env.SITE_BUCKET);
      const spy = vi.spyOn(instance.env.SITE_BUCKET, 'put').mockImplementation(async (key: any, body: any, options: any) => {
        if (stage === 'archive_image_write' ? key.startsWith('assets/daily/') : key.includes('/checkpoints/')) throw new Error('Injected checkpoint failure');
        return put(key, body, options);
      });
      restore = () => spy.mockRestore();
    });
    try { await runDurableObjectAlarm(publisher()); } finally { restore(); }
    expect(await publisher().jobStatus(job.id)).toMatchObject({ status: 'failed', failed_stage: stage });
    expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.etag).toBe(before);
    const previousRenders = render.mock.calls.length;
    await publisher().resumeRebuild(job.id); await evictDurableObject(publisher());
    await runDurableObjectAlarm(publisher());
    if (stage === 'rebuild_archive_checkpoint') expect(render).toHaveBeenCalledTimes(previousRenders);
    expect(await finish(job.id)).toMatchObject({ status: 'completed' });
    expect(render.mock.calls.length).toBe(stage === 'archive_image_write' ? 13 : 12);
    expect(events.filter(event => event.event === 'operation_stage' && event.stage === 'rebuild_failure_record').every(event => event.phase === undefined)).toBe(true);
  });

  it.each(['archive_day_write', 'rebuild_day_checkpoint', 'rebuild_archive_progress', 'archive_catalog_write'] as const)('recovers after %s without losing completed work or committing partial results', async stage => {
    await seedArchives(12, true);
    const render = vi.spyOn(social, 'dailyCard').mockImplementation(async (date, headline) => new TextEncoder().encode(date + headline));
    const before = (await bindings.SITE_BUCKET.head('pages/index.html'))!;
    const job = await publisher().enqueueRebuild(origin, context);
    let injected = false; let restore!: () => void;
    await inPublisher(publisher(), async (instance, state) => {
      const put = instance.env.SITE_BUCKET.put.bind(instance.env.SITE_BUCKET);
      const putSpy = vi.spyOn(instance.env.SITE_BUCKET, 'put').mockImplementation(async (key: any, body: any, options: any) => {
        // Fail the second historical day so the first has a durable receipt.
        const target = stage === 'archive_day_write' ? key.startsWith('archive-days/') && new TextDecoder().decode(body).includes('2026-08-02')
          : stage === 'rebuild_day_checkpoint' ? key.includes('/days/2026-08-02/')
          : stage === 'archive_catalog_write' && key.startsWith('archive-catalogs/');
        if (target && !injected) { injected = true; throw new Error('Injected work persistence failure'); }
        return put(key, body, options);
      });
      const transaction = state.storage.transaction.bind(state.storage);
      const transactionSpy = vi.spyOn(state.storage, 'transaction').mockImplementation(callback => transaction(async storage => {
        const proxy = new Proxy(storage, { get(target, property) {
          if (property === 'put') return (...args: any[]) => {
            if (stage === 'rebuild_archive_progress' && args[0] === `rebuild:${job.id}` && !injected) {
              injected = true; throw new Error('Injected Durable Object checkpoint failure');
            }
            return (target.put as any)(...args);
          };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        return callback(proxy);
      }));
      restore = () => { putSpy.mockRestore(); transactionSpy.mockRestore(); };
    });
    try {
      await runDurableObjectAlarm(publisher());
      if (stage === 'archive_catalog_write') await runDurableObjectAlarm(publisher());
    } finally { restore(); }
    expect(injected).toBe(true);
    expect(await publisher().jobStatus(job.id)).toMatchObject({ status: 'failed', failed_stage: stage });
    const unchanged = (await bindings.SITE_BUCKET.head('pages/index.html'))!;
    expect(unchanged.etag).toBe(before.etag); expect(unchanged.customMetadata).toEqual(before.customMetadata);
    const previousRenders = render.mock.calls.map(([date]) => date);
    expect(previousRenders.filter(date => date === '2026-08-01')).toHaveLength(1);
    await publisher().resumeRebuild(job.id); await evictDurableObject(publisher());
    expect(await finish(job.id)).toMatchObject({ status: 'completed' });
    // Only the interrupted day can repeat; all days with receipts survive eviction.
    const repeatedDay = stage === 'archive_day_write' || stage === 'rebuild_day_checkpoint';
    expect(render).toHaveBeenCalledTimes(repeatedDay ? 13 : 12);
    for (const date of new Set(previousRenders)) {
      expect(render.mock.calls.filter(([rendered]) => rendered === date)).toHaveLength(repeatedDay && date === '2026-08-02' ? 2 : 1);
    }
    const committed = (await bindings.SITE_BUCKET.head('pages/index.html'))!;
    expect(committed.customMetadata!.manifest).not.toBe(before.customMetadata!.manifest);
    expect(Object.keys((await catalog()).days)).toHaveLength(13);
  });
});

describe('publication I/O', () => {
  it.each(['publish', 'append', 'retract', 'preview_digest', 'preview_append'] as const)('shares the migration guard snapshot throughout the %s RPC', async operation => {
    const first = await (await request('/api/digests', digest())).json<PublishResult>();
    const stub = publisher();
    await inPublisher(stub, async (_instance, state) => state.storage.put('migration', { complete: true, processed: 1 }));
    const reads = new Map<string, number>(); const heads = new Map<string, number>();
    const spies: { mockRestore(): void }[] = [];
    await inPublisher(stub, async instance => {
      const bucket = instance.env.SITE_BUCKET;
      const get = bucket.get.bind(bucket); const head = bucket.head.bind(bucket);
      spies.push(vi.spyOn(bucket, 'get').mockImplementation((key: any) => {
        reads.set(key, (reads.get(key) ?? 0) + 1); return get(key);
      }), vi.spyOn(bucket, 'head').mockImplementation((key: any) => {
        heads.set(key, (heads.get(key) ?? 0) + 1); return head(key);
      }));
    });
    const update = { group: 'Group', body: 'Surviving update', post_url: `${origin}/rpc-update`, posted_at: at.toISOString() };
    const rpcContext = { ...context, request_id: `rpc-${operation}`, operation };
    try {
      const reply = await ({
        publish: () => stub.publishV2({ ...digest('Next'), client_ref: 'rpc-next' }, origin, rpcContext),
        append: () => stub.appendUpdateV1(first.post!.id, 0, update, origin, rpcContext),
        retract: () => stub.retractPostV1(first.post!.id, owner, origin, rpcContext),
        preview_digest: () => stub.previewDigestV1({ ...digest('Next'), client_ref: 'rpc-next' }, origin, rpcContext),
        preview_append: () => stub.previewAppendV1(first.post!.id, 0, update, origin, rpcContext),
      })[operation]();
      expect(reply.ok).toBe(true);
      expect(heads.get('pages/index.html')).toBe(1);
      expect([...reads.keys()].some(key => key.startsWith('publications/'))).toBe(true);
      for (const [key, count] of reads) if (/^(publications|posts|post-revisions|history-index)\//.test(key)) expect(count, key).toBe(1);
      const stages = events.filter(event => event.event === 'operation_stage' && event.request_id === rpcContext.request_id);
      expect(stages.filter(event => event.stage === 'committed_snapshot_loading')).toHaveLength(1);
      expect(stages.filter(event => event.stage === 'source_loading')).toHaveLength(1);
      expect(stages.filter(event => event.stage === 'publication_loading')).toHaveLength(1);
    } finally { for (const spy of spies) spy.mockRestore(); }
  });

  it('loads each manifest, source and history index once for retraction and client_ref publishing', async () => {
    const first = await publishDigest(bindings.SITE_BUCKET, digest(), origin, at, true, undefined, { publisherFingerprint: owner });
    for (const action of [
      (bucket: ContentBucket) => publishDigest(bucket, { ...digest('Next'), client_ref: 'ref' }, origin, at, true),
      (bucket: ContentBucket) => retractPost(bucket, first.post!.id, owner, origin, at, true),
    ]) {
      const reads = new Map<string, number>();
      await action(store({ get: key => { reads.set(key, (reads.get(key) ?? 0) + 1); return bindings.SITE_BUCKET.get(key); } }));
      for (const [key, count] of reads) if (/^(publications|posts|post-revisions|history-index)\//.test(key)) expect(count, key).toBe(1);
    }
  });

  it('bounds independent writes at four, orders repeated keys, and writes the index last', async () => {
    const calls: string[] = []; let active = 0; let peak = 0; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const trace = new OperationTrace(context);
    const prepared = prepareWrites(store({ put: async (key, body) => {
      active++; peak = Math.max(peak, active); calls.push(`start:${key}:${new TextDecoder().decode(body as Uint8Array)}`);
      await gate;
      calls.push(`end:${key}`); active--; return null;
    } }), trace);
    for (let i = 0; i < 8; i++) await trace.run(`write_${i}`, () => prepared.bucket.put(i === 7 ? 'object-0' : `object-${i}`, String(i)));
    await trace.run('index_write', () => prepared.bucket.put('pages/index.html', 'index'));
    const committed = prepared.commit();
    await vi.waitFor(() => expect(active).toBe(4));
    expect(calls.some(call => call.includes('pages/index.html'))).toBe(false);
    release(); await committed;
    expect(peak).toBe(4);
    expect(calls.indexOf('start:object-0:7')).toBeGreaterThan(calls.indexOf('end:object-0'));
    expect(calls.slice(-2)).toEqual(['start:pages/index.html:index', 'end:pages/index.html']);
    expect(trace.phase).toBeUndefined();
    expect(events.filter(event => event.event === 'operation_stage' && event.phase === 'commit').map(event => event.stage)).toEqual(expect.arrayContaining(['write_0', 'write_7', 'index_write']));
  });

  it('waits for in-flight writes after failure and never crosses the index barrier', async () => {
    let release!: () => void; let fail!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const failureGate = new Promise<void>(resolve => { fail = resolve; });
    const written: string[] = []; let active = 0;
    const trace = new OperationTrace(context);
    const prepared = prepareWrites(store({ put: async key => {
      written.push(key); active++;
      try { if (key === 'broken') { await failureGate; throw new Error('private failure'); } await gate; return null; }
      finally { active--; }
    } }), trace);
    for (const key of ['broken', 'a', 'b', 'c', 'later', 'pages/index.html']) await trace.run(key, () => prepared.bucket.put(key, key));
    let settled = false;
    const committed = prepared.commit();
    void committed.catch(() => { settled = true; });
    await vi.waitFor(() => expect(active).toBe(4));
    fail(); await vi.waitFor(() => expect(active).toBe(3));
    expect(settled).toBe(false);
    release(); await expect(committed).rejects.toMatchObject({ kind: 'storage' });
    expect(written).toEqual(['broken', 'a', 'b', 'c']);
    expect(trace.failed_stage).toBe('broken'); expect(trace.phase).toBeUndefined();
  });
});
