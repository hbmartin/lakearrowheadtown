import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { appendUpdate, currentPublication, publishDigest } from '../src/publishing';
import { committedFailureAdvice } from '../src/errors';
import type { ContentBucket, Digest, Env } from '../src/types';
import type { RepairInput } from '../src/publication-repair';

const bindings = env as unknown as Env;
const origin = 'https://lakearrowhead.town';
const secret = 'test-secret-at-least-thirty-two-characters-long';
const publisher = () => bindings.PUBLISHER.getByName('site');
const inside = runInDurableObject as unknown as <T>(stub: unknown, callback: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
const digest = (name = 'First'): Digest => ({ title: name, source: 'Community', items: [{ group: 'Group', group_url: origin,
  headline: name, body: 'Body', category: '', post_url: `${origin}/source/${name}`, posted_at: new Date().toISOString() }] });
const update = () => ({ group: 'Group', body: 'Update', post_url: `${origin}/update`, posted_at: new Date().toISOString() });
const store = (overrides: Partial<ContentBucket> = {}): ContentBucket => ({ get: key => bindings.SITE_BUCKET.get(key), head: key => bindings.SITE_BUCKET.head(key),
  list: options => bindings.SITE_BUCKET.list(options), put: (key, body, options) => bindings.SITE_BUCKET.put(key, body, options), ...overrides });
async function seed() {
  const result = await publishDigest(bindings.SITE_BUCKET, digest(), origin, new Date(), true);
  await inside(publisher(), async (_instance, state) => state.storage.put('migration', { processed: 1, complete: true }));
  return result.post!.id;
}
async function repairInput(): Promise<RepairInput> {
  const index = (await bindings.SITE_BUCKET.head('pages/index.html'))!;
  const manifest = `publications/${crypto.randomUUID()}.json`;
  await bindings.SITE_BUCKET.put(manifest, await (await bindings.SITE_BUCKET.get(index.customMetadata!.manifest))!.text());
  return { expected_version: index.version, manifest, rss: index.customMetadata!.rss, archives: index.customMetadata!.archives ?? null };
}
function request(method = 'GET', body?: unknown, authorized = true, overrides: Partial<Env> = {}) {
  return worker.fetch(new Request(origin + '/api/publication/repair', { method, headers: { ...(authorized ? { Authorization: `Bearer ${secret}` } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { ...bindings, ...overrides });
}
beforeEach(async () => {
  vi.restoreAllMocks(); await reset();
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(['append', 'preview'] as const)('reads a damaged %s target once and retains source_loading attribution even if restored', async operation => {
  const id = await seed();
  const ref = (await currentPublication(bindings.SITE_BUCKET)).posts[0];
  await inside(publisher(), async instance => {
    let reads = 0;
    const bucket: ContentBucket = instance.env.SITE_BUCKET;
    const get = bucket.get.bind(bucket);
    const spy = vi.spyOn(bucket, 'get').mockImplementation(async (key: string) => key === ref.key && ++reads === 1 ? null : get(key));
    try {
      const reply = operation === 'append' ? await instance.appendUpdateV1(id, 0, update(), origin) : await instance.previewAppendV1(id, 0, update(), origin);
      expect(reply).toMatchObject({ ok: false, failure: { stage: 'source_loading', code: 'source_damaged', retryable: false,
        publication_status: operation === 'preview' ? 'not_attempted' : 'not_committed' } });
      expect(reads).toBe(1);
    } finally { spy.mockRestore(); }
  });
});

it('continues to omit a damaged unrelated source while appending to a valid target', async () => {
  const id = await seed();
  await publishDigest(bindings.SITE_BUCKET, digest('Other'), origin, new Date(), true);
  const ref = (await currentPublication(bindings.SITE_BUCKET)).posts.find(ref => ref.id !== id)!;
  await bindings.SITE_BUCKET.delete(ref.key);
  expect(await appendUpdate(bindings.SITE_BUCKET, id, 0, update(), origin, new Date(), true)).toMatchObject({ status: 'appended' });
  expect((await currentPublication(bindings.SITE_BUCKET)).omitted_posts?.map(ref => ref.id)).toEqual([ref.id]);
});

it.each(['replace', 'delete', 'create'] as const)('rejects an index %s between snapshot loading and conditional commit', async race => {
  if (race !== 'create') await seed();
  const before = await bindings.SITE_BUCKET.head('pages/index.html');
  const bucket = store({ put: async (key, body, options) => {
    if (key === 'pages/index.html') {
      if (race === 'delete') await bindings.SITE_BUCKET.delete(key);
      else await bindings.SITE_BUCKET.put(key, 'Concurrent index', { customMetadata: { owner: 'other' } });
      expect(options?.onlyIf).toEqual(before ? { etagMatches: before.etag } : { etagDoesNotMatch: '*' });
    }
    return bindings.SITE_BUCKET.put(key, body, options);
  } });
  await expect(publishDigest(bucket, digest('Conflict'), origin, new Date(), true)).rejects.toMatchObject({ publication_status: 'not_committed', stage: 'index_write',
    cause: { status: 503, code: 'publication_conflict', retryable: true, retry_at: expect.any(String) } });
  expect(await bindings.SITE_BUCKET.get('pages/index.html').then(object => object?.text() ?? null)).toBe(race === 'delete' ? null : 'Concurrent index');
});

it('returns conditional conflicts with retry timing through the actual HTTP boundary', async () => {
  await seed();
  await inside(publisher(), async instance => {
    const bucket: ContentBucket = instance.env.SITE_BUCKET; const put = bucket.put.bind(bucket);
    const spy = vi.spyOn(bucket, 'put').mockImplementation((key: string, body: any, options?: R2PutOptions) => key === 'pages/index.html' ? Promise.resolve(null) : put(key, body, options));
    try {
      const response = await worker.fetch(new Request(origin + '/api/digests', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(digest('Next')) }),
        { ...bindings, PUBLISHER: { getByName: () => instance } as unknown as Env['PUBLISHER'] });
      expect(response.status).toBe(503); expect(response.headers.get('Retry-After')).toBe('1');
      expect(await response.json()).toMatchObject({ code: 'publication_conflict', retryable: true, publication_status: 'not_committed', retry_at: expect.any(String), diagnostics: { stage: 'index_write' } });
    } finally { spy.mockRestore(); }
  });
});

it('preserves unknown commit certainty on a lost index-write acknowledgement', async () => {
  await seed();
  const bucket = store({ put: async (key, body, options) => {
    const object = await bindings.SITE_BUCKET.put(key, body, options);
    if (key === 'pages/index.html') throw new Error('Lost acknowledgement');
    return object;
  } });
  await expect(publishDigest(bucket, digest('Next'), origin, new Date(), true)).rejects.toMatchObject({ publication_status: 'unknown', stage: 'index_write' });
});

it('authenticates snapshots and repairs, supports HEAD, and reports a missing index', async () => {
  expect((await request('GET', undefined, false)).status).toBe(401);
  expect((await request()).status).toBe(404);
  expect((await request('PUT', {})).status).toBe(405);
  await seed();
  const response = await request();
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ ok: true, publication: { version: expect.any(String), manifest: expect.any(String) } });
  expect(await (await request('HEAD')).text()).toBe('');
});

it('preserves index bytes and metadata, durably schedules regeneration first, and makes repeated repairs a no-op', async () => {
  await seed(); const input = await repairInput();
  const original = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
  const body = await original.text();
  const customMetadata = { ...original.customMetadata, operator_note: 'Retain me' };
  await bindings.SITE_BUCKET.put('pages/index.html', body, { customMetadata, httpMetadata: { ...original.httpMetadata, contentLanguage: 'en-US' } });
  input.expected_version = (await bindings.SITE_BUCKET.head('pages/index.html'))!.version;
  await inside(publisher(), async (instance, state) => {
    const bucket: ContentBucket = instance.env.SITE_BUCKET; const put = bucket.put.bind(bucket);
    const spy = vi.spyOn(bucket, 'put').mockImplementation(async (key: string, bytes: any, options?: R2PutOptions) => {
      if (key === 'pages/index.html') {
        expect((await state.storage.get<string[]>('jobs'))?.length).toBeGreaterThan(0);
        expect(await state.storage.getAlarm()).not.toBeNull();
      }
      return put(key, bytes, options);
    });
    try { expect(await instance.publicationRepairV1(input, origin)).toMatchObject({ ok: true, result: { unchanged: false, job: { status: 'queued' } } }); }
    finally { spy.mockRestore(); }
  });
  const repaired = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
  expect(await repaired.text()).toBe(body);
  expect(repaired.customMetadata).toEqual({ ...customMetadata, manifest: input.manifest });
  expect(repaired.httpMetadata?.contentLanguage).toBe('en-US');
  const response = await request('POST', input);
  expect(response.status).toBe(200);
  const result = await response.json<any>();
  expect(result).toMatchObject({ unchanged: true, publication: { version: repaired.version }, job: { status: 'queued' } });
  await runDurableObjectAlarm(publisher());
  expect(await publisher().jobStatus(result.job.id)).toMatchObject({ status: 'completed' });
});

it('rejects stale repairs and invalid targets without queueing or changing the index', async () => {
  await seed(); const input = await repairInput();
  for (const patch of [{ expected_version: 'stale' }, { rss: `publications/${crypto.randomUUID()}.rss.xml` }, { archives: null }, { manifest: 'posts/not-a-manifest.json' }]) {
    const before = (await bindings.SITE_BUCKET.head('pages/index.html'))!.version;
    const response = await request('POST', { ...input, ...patch });
    expect(response.status).toBe('expected_version' in patch ? 409 : 400);
    expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.version).toBe(before);
    await inside(publisher(), async (_instance, state) => expect(await state.storage.get('jobs')).toBeUndefined());
  }
});

it('can inspect and repair damaged pointers, and automatically recovers a related failed rebuild', async () => {
  await seed(); const input = await repairInput();
  const index = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
  await bindings.SITE_BUCKET.put('pages/index.html', await index.text(), { customMetadata: { ...index.customMetadata, manifest: `publications/${crypto.randomUUID()}.json` } });
  const job = await publisher().enqueueRebuild(origin);
  await runDurableObjectAlarm(publisher());
  expect(await publisher().jobStatus(job.id)).toMatchObject({ status: 'failed', error_code: 'manifest_damaged' });
  const current = await (await request()).json<any>(); input.expected_version = current.publication.version;
  const response = await request('POST', input); expect(response.status).toBe(200);
  const repaired = await response.json<any>();
  await runDurableObjectAlarm(publisher()); await runDurableObjectAlarm(publisher());
  expect(await publisher().jobStatus(job.id)).toMatchObject({ status: 'completed' });
  expect(await publisher().jobStatus(repaired.job.id)).toMatchObject({ status: 'completed' });
});

it('persists bounded conflict backoff across eviction and completes without manual resume', async () => {
  await seed(); const job = await publisher().enqueueRebuild(origin);
  let clock = Date.now();
  const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
  for (const [i, seconds] of [1, 2, 4, 8, 16, 30, 30].entries()) {
    await inside(publisher(), async instance => {
      const bucket: ContentBucket = instance.env.SITE_BUCKET; const put = bucket.put.bind(bucket);
      const spy = vi.spyOn(bucket, 'put').mockImplementation((key: string, body: any, options?: R2PutOptions) => key === 'pages/index.html' ? Promise.resolve(null) : put(key, body, options));
      try { await instance.alarm(); } finally { spy.mockRestore(); }
    });
    const status = await publisher().jobStatus(job.id);
    expect(status).toMatchObject({ status: 'running', conflict_count: i + 1, next_retry_at: new Date(clock + seconds * 1000).toISOString() });
    await evictDurableObject(publisher());
    // A premature alarm must retain the deadline without another attempt.
    await runDurableObjectAlarm(publisher());
    expect(await publisher().jobStatus(job.id)).toMatchObject({ conflict_count: i + 1, next_retry_at: status!.next_retry_at });
    clock = Date.parse(status!.next_retry_at!);
  }
  await runDurableObjectAlarm(publisher());
  expect(await publisher().jobStatus(job.id)).toMatchObject({ status: 'completed' });
  expect((await publisher().jobStatus(job.id))!.next_retry_at).toBeUndefined(); now.mockRestore();
});

it('gives missing and unknown operations the same conservative advice', () => {
  expect(committedFailureAdvice(true)).toBe(committedFailureAdvice(true, 'unknown'));
  expect(committedFailureAdvice(true, 'publish')).toBe(committedFailureAdvice(true, 'digest'));
});

it.each(['manifest', 'source', 'history', 'catalogue'] as const)('validates the repair %s before queueing or changing pointers', async damaged => {
  await seed(); const input = await repairInput();
  const publication = await currentPublication(bindings.SITE_BUCKET);
  if (damaged === 'manifest') await bindings.SITE_BUCKET.delete(input.manifest);
  if (damaged === 'source') await bindings.SITE_BUCKET.put(publication.posts[0].key, 'broken');
  if (damaged === 'history') await bindings.SITE_BUCKET.delete(publication.history_index!);
  if (damaged === 'catalogue') await bindings.SITE_BUCKET.delete(input.archives!);
  const response = await request('POST', input);
  expect(response.status).toBe(damaged === 'catalogue' ? 503 : 500);
  expect(await response.json()).toMatchObject({ retryable: false, publication_status: 'not_committed' });
  expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.version).toBe(input.expected_version);
  await inside(publisher(), async (_instance, state) => expect(await state.storage.get('jobs')).toBeUndefined());
});

it('serializes pointer repair behind a rebuild commit and rejects the now-stale reviewed version', async () => {
  await seed(); const input = await repairInput();
  await inside(publisher(), async instance => {
    const job = await instance.enqueueRebuild(origin);
    let release!: () => void; let reached!: () => void; let admitted!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const indexPending = new Promise<void>(resolve => { reached = resolve; });
    const repairAdmitted = new Promise<void>(resolve => { admitted = resolve; });
    const bucket: ContentBucket = instance.env.SITE_BUCKET; const put = bucket.put.bind(bucket);
    const putSpy = vi.spyOn(bucket, 'put').mockImplementation(async (key, body, options) => {
      if (key === 'pages/index.html') { reached(); await gate; }
      return put(key, body, options);
    });
    const serialize = instance.serialize.bind(instance); let repairEntered = false;
    const serialSpy = vi.spyOn(instance, 'serialize').mockImplementation((action: any, context: any) => {
      if (context?.operation !== 'publication_repair') return serialize(action, context);
      const result = serialize(() => { repairEntered = true; return action(); }, context); admitted(); return result;
    });
    const rebuilding = instance.alarm(); let repair: Promise<any> | undefined;
    try {
      await indexPending;
      repair = instance.publicationRepairV1(input, origin, { request_id: 'queued-repair', operation: 'publication_repair', environment: 'test', worker_version: 'test' });
      await repairAdmitted; expect(repairEntered).toBe(false);
    } finally {
      release();
      try {
        await rebuilding;
        expect(await repair).toMatchObject({ ok: false, failure: { code: 'publication_changed', status: 409 } });
      } finally { putSpy.mockRestore(); serialSpy.mockRestore(); }
    }
    expect(await instance.jobStatus(job.id)).toMatchObject({ status: 'completed' });
    expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.customMetadata!.manifest).not.toBe(input.manifest);
  });
});

it('returns a repair conflict with retry timing and leaves a durable rebuild queued for the current snapshot', async () => {
  await seed(); const input = await repairInput();
  await inside(publisher(), async (instance, state) => {
    const bucket: ContentBucket = instance.env.SITE_BUCKET; const put = bucket.put.bind(bucket);
    const spy = vi.spyOn(bucket, 'put').mockImplementation((key, body, options) => key === 'pages/index.html' ? Promise.resolve(null) : put(key, body, options));
    try {
      const response = await request('POST', input, true, { PUBLISHER: { getByName: () => instance } as unknown as Env['PUBLISHER'] });
      expect(response.status).toBe(503); expect(response.headers.get('Retry-After')).toBe('1');
      expect(await response.json()).toMatchObject({ code: 'publication_conflict', retry_at: expect.any(String), publication_status: 'not_committed' });
      expect((await state.storage.get<string[]>('jobs'))).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });
  expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.version).toBe(input.expected_version);
  await runDurableObjectAlarm(publisher());
});

it('does not resume an unrelated fatal rebuild when a repair is submitted', async () => {
  await seed(); const input = await repairInput(); const job = await publisher().enqueueRebuild(origin);
  await inside(publisher(), async (_instance, state) => state.storage.put(`job:${job.id}`, { ...job, status: 'failed', error_code: 'render_failed' }));
  const response = await request('POST', input);
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'rebuild_blocked' });
  expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.version).toBe(input.expected_version);
});
