import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { currentPublication, loadPost, publishDigest, rebuildHomepage, retractPost } from '../src/publishing';
import { loadCatalog, loadArchiveDay, stableJson, type ArchiveCatalog, type ArchiveDay } from '../src/archives';
import { fingerprint, OperationTrace } from '../src/diagnostics';
import { prepareWrites } from '../src/prepared-writes';
import * as social from '../src/social';
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
async function jsonObject(prefix: string, value: unknown) {
  const body = stableJson(value); const key = `${prefix}/${fingerprint(body)}.json`;
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
async function seedArchives(count = 23) {
  const first = await publishDigest(bindings.SITE_BUCKET, digest(), origin, at, true, undefined, { publisherFingerprint: owner });
  const value = await catalog();
  const png = await (await bindings.SITE_BUCKET.get(value.days['2026-10-20'].image.slice(1)))!.arrayBuffer();
  for (let i = 1; i <= count; i++) {
    const date = `2026-08-${String(i).padStart(2, '0')}`; const activity = `${date}T18:00:00Z`;
    const postId = `historical-${i}`;
    const day: ArchiveDay = { date, images: {}, stories: [{ postId, itemIndex: 0, date, activity, timestamp: Date.parse(activity), item: digest(postId, activity).items[0] }] };
    const image = `/assets/daily/${fingerprint(date)}.png`;
    await bindings.SITE_BUCKET.put(image.slice(1), png); // Legacy card without cardInputHash.
    value.days[date] = { key: await jsonObject('archive-days', day), image, cardVersion: social.DAILY_CARD_VERSION, identities: [`${postId}:0`], modified: activity };
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
    expect(result.complete).toBe(false);
    expect(put.mock.calls.some(([key]) => key === 'pages/index.html')).toBe(false);
    expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.customMetadata).toEqual(original.customMetadata);
  });

  it('checkpoints ten days per alarm, survives eviction, and preserves interleaved publications and retractions', async () => {
    const first = await seedArchives();
    const before = (await bindings.SITE_BUCKET.head('pages/index.html'))!.etag;
    const render = vi.spyOn(social, 'dailyCard').mockImplementation(async (date, headline) => new TextEncoder().encode(date + headline));
    const job = await publisher().enqueueRebuild(origin, context);
    await runDurableObjectAlarm(publisher());
    expect(render).toHaveBeenCalledTimes(10);
    expect(await publisher().jobStatus(job.id)).toMatchObject({ status: 'running', archive_progress: { completed_days: 10, total_days: 24 } });
    expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.etag).toBe(before);
    await evictDurableObject(publisher());
    expect((await request('/api/digests', digest('Newer'))).status).toBe(200);
    expect((await request(`/api/posts/${first.post!.id}/items/0/updates`, { group: 'Group', post_url: `${origin}/update`, body: 'New update', posted_at: at.toISOString() })).status).toBe(200);
    expect((await request(`/api/posts/${first.post!.id}/retract`, {})).status).toBe(200);
    const latest = (await bindings.SITE_BUCKET.head('pages/index.html'))!.etag;
    const rendersBeforeNextAlarm = render.mock.calls.length;
    await runDurableObjectAlarm(publisher());
    expect(render).toHaveBeenCalledTimes(rendersBeforeNextAlarm + 10);
    expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.etag).toBe(latest);
    expect(await finish(job.id)).toMatchObject({ status: 'completed', archive_progress: { completed_days: 24, total_days: 24 } });
    expect(render).toHaveBeenCalledTimes(rendersBeforeNextAlarm + 13);
    const html = await (await request('/')).text();
    expect(html).toContain('Newer'); expect(html).not.toContain('>Original</a>'); expect(html).not.toContain('New update');
    const publication = await currentPublication(bindings.SITE_BUCKET);
    expect((await loadPost(bindings.SITE_BUCKET, publication.posts.find(post => post.id === first.post!.id)!)).retracted_at).toBeTruthy();
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
});

describe('publication I/O', () => {
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
