import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { publishDigest, currentPublication } from '../src/publishing';
import { checkpointKey, pauseKey } from '../src/rebuild-evidence';
import type { Env } from '../src/types';

const bindings = env as unknown as Env;
const origin = 'https://lakearrowhead.town';
const publisher = () => bindings.PUBLISHER.getByName('site');
const inside = runInDurableObject as unknown as <T>(stub: unknown, action: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
beforeEach(async () => { vi.restoreAllMocks(); await reset(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
async function seed() {
  await publishDigest(bindings.SITE_BUCKET, { title: 'Review', source: 'Review', items: [{ group: 'Review', group_url: origin,
    headline: 'Story', body: 'Body', category: '', post_url: origin + '/story', posted_at: new Date().toISOString() }] }, origin, new Date(), true);
  await inside(publisher(), async (_instance, state) => { await state.storage.put('migration', { complete: true, processed: 1 }); });
  return publisher().enqueueRebuild(origin);
}
async function input() {
  const index = (await bindings.SITE_BUCKET.head('pages/index.html'))!;
  const manifest = `publications/${crypto.randomUUID()}.json`;
  await bindings.SITE_BUCKET.put(manifest, JSON.stringify(await currentPublication(bindings.SITE_BUCKET)));
  return { expected_version: index.version, manifest, rss: index.customMetadata!.rss, archives: index.customMetadata!.archives ?? null };
}
it('retains non-commit certainty after an absent checkpoint and receipt HEAD failure', async () => {
  const job = await seed();
  await inside(publisher(), async (instance, state) => {
    expect(await state.storage.get(checkpointKey(job.id))).toBeUndefined();
    const head = vi.spyOn(instance.env.SITE_BUCKET, 'head').mockRejectedValue(new Error('Temporary R2 outage'));
    try { await expect(instance.alarm()).rejects.toBeDefined(); } finally { head.mockRestore(); }
    expect(await state.storage.get(`job:${job.id}`)).toMatchObject({ recovery: { publication_status: 'not_committed', stage: 'rebuild_receipt_read' } });
    expect(await state.storage.get(checkpointKey(job.id))).toBeUndefined();
  });
});
it('reuses an unscheduled head from the first repair through repeated repairs', async () => {
  const head = await seed();
  await inside(publisher(), async (_instance, state) => state.storage.deleteAlarm());
  const first = await publisher().publicationRepairV1(await input(), origin);
  expect(first).toMatchObject({ ok: true });
  expect(await publisher().jobStatus(head.id)).toMatchObject({ manual_resume: true });
  const second = await publisher().publicationRepairV1(await input(), origin);
  expect(second).toMatchObject({ ok: true, result: { regeneration_status: 'awaiting_resume', job: { id: head.id, manual_resume: true } } });
  await inside(publisher(), async (_instance, state) => expect(await state.storage.get('jobs')).toEqual([head.id]));
});
it('preserves bootstrap checkpoint bookkeeping during another uncertain dispatch', async () => {
  const job = await seed();
  await inside(publisher(), async (instance, state) => {
    await state.storage.put(checkpointKey(job.id), { version: 2, generation_id: job.generation_id, phase: 'dispatching', migration: { complete: true, processed: 77 } });
    const put = instance.env.SITE_BUCKET.put.bind(instance.env.SITE_BUCKET);
    const fail = vi.spyOn(instance.env.SITE_BUCKET, 'put').mockImplementation((key: any, ...args: any[]) => {
      if (key === 'pages/index.html') throw new Error('Lost index write'); return put(key, ...args);
    });
    try { await expect(instance.alarm()).rejects.toBeDefined(); } finally { fail.mockRestore(); }
    const checkpoint = await state.storage.get<any>(checkpointKey(job.id));
    expect(checkpoint).toMatchObject({ phase: 'dispatching', generation_id: job.generation_id });
    expect(checkpoint.migration).toEqual({ complete: true, processed: 77 });
  });
});
it('does not inherit historical repair eligibility after resume and an unrelated pause', async () => {
  const job = await seed();
  await inside(publisher(), async (_instance, state) => {
    await state.storage.put(`job:${job.id}`, { ...job, status: 'running', manual_resume: true, scheduling: 'manual', pause_reason: 'manual_resume',
      recovery: { code: 'source_damaged', stage: 'source_loading', retryable: false, publication_status: 'unknown', failed_at: new Date().toISOString() } });
    await state.storage.put(checkpointKey(job.id), { version: 2, generation_id: job.generation_id, phase: 'dispatching' });
    await state.storage.deleteAlarm();
  });
  expect(await publisher().publicationRepairV1(await input(), origin)).toMatchObject({ ok: true });
  await publisher().resumeRebuild(job.id);
  await inside(publisher(), async (_instance, state) => {
    const current = await state.storage.get<any>(`job:${job.id}`);
    await state.storage.put(`job:${job.id}`, { ...current, manual_resume: true, scheduling: 'manual', pause_reason: 'manual_resume' });
    await state.storage.deleteAlarm();
  });
  expect(await publisher().publicationRepairV1(await input(), origin)).toMatchObject({ ok: false, failure: { code: 'rebuild_blocked' } });
  await inside(publisher(), async (_instance, state) => expect(await state.storage.get(pauseKey(job.id))).toBeUndefined());
});
it('attributes checkpoint damage during reservation to repair evidence validation', async () => {
  const job = await seed();
  await inside(publisher(), async (_instance, state) => {
    await state.storage.put(`job:${job.id}`, { ...job, status: 'failed', error_code: 'source_damaged' });
    await state.storage.put(checkpointKey(job.id), { bad: true });
  });
  expect(await publisher().publicationRepairV1(await input(), origin)).toMatchObject({ ok: false,
    failure: { code: 'rebuild_checkpoint_damaged', stage: 'repair_rebuild_evidence' } });
});
it('tags dispatch checkpoint duration as commit phase', async () => {
  await seed(); const events: any[] = [];
  vi.spyOn(console, 'info').mockImplementation(value => events.push(value));
  await inside(publisher(), async instance => instance.alarm());
  expect(events).toContainEqual(expect.objectContaining({ event: 'operation_stage', stage: 'rebuild_dispatch_checkpoint', phase: 'commit' }));
});
it('retains conditional read revalidation and does not rely on upload-time fencing', async () => {
  const first = (await bindings.SITE_BUCKET.put('probe', 'same'))!;
  const second = await bindings.SITE_BUCKET.put('probe', 'replacement', { onlyIf: { etagMatches: first.etag, uploadedBefore: new Date(0) } });
  expect(second).not.toBeNull();
  await seed();
  const worker = (await import('../src/worker')).default;
  const get = await worker.fetch(new Request(origin), bindings);
  const conditional = await worker.fetch(new Request(origin, { headers: { 'If-None-Match': get.headers.get('ETag')! } }), bindings);
  expect(conditional.status).toBe(304);
});
it('pauses committed activation immediately for missing migration evidence', async () => {
  const job = await seed();
  await inside(publisher(), async (instance, state) => {
    await state.storage.put(`job:${job.id}`, { ...job, status: 'running', manual_resume: true, scheduling: 'manual', pause_reason: 'manual_resume',
      recovery: { code: 'source_damaged', stage: 'source_loading', retryable: false, publication_status: 'committed', failed_at: new Date().toISOString() } });
    await state.storage.put(checkpointKey(job.id), { version: 2, generation_id: job.generation_id, phase: 'dispatching' });
    await state.storage.deleteAlarm();
    const payload = await input();
    const put = instance.env.SITE_BUCKET.put.bind(instance.env.SITE_BUCKET);
    const corruptMigration = vi.spyOn(instance.env.SITE_BUCKET, 'put').mockImplementation(async (key: any, ...args: any[]) => {
      const result = await put(key, ...args);
      if (key === 'pages/index.html') await state.storage.put('migration', { complete: false, processed: 0 });
      return result;
    });
    try {
      expect(await instance.publicationRepairV1(payload, origin)).toMatchObject({ ok: false,
        failure: { code: 'rebuild_checkpoint_damaged', retryable: false, publication_status: 'committed' } });
    } finally { corruptMigration.mockRestore(); }
    const key = (await state.storage.get<string>('publication_repair_pending'))!;
    expect(await state.storage.get(key)).toMatchObject({ attempts: 1, stalled: true, last_error: { code: 'rebuild_checkpoint_damaged', retryable: false } });
    expect(await state.storage.getAlarm()).toBeNull();
    const snapshot = (await instance.publicationRepairV1(undefined, origin)).result;
    expect(snapshot.recovery).toMatchObject({ state: 'damaged', publication_status: 'committed' });
    const committedVersion = snapshot.publication.version;
    await state.storage.put(checkpointKey(job.id), { version: 2, generation_id: job.generation_id, phase: 'dispatching', migration: { complete: true, processed: 1 } });
    await instance.publicationRepairControlV1('resume', { expected_version: snapshot.publication.version, expected_recovery_token: snapshot.recovery.recovery_token });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 2000);
    await instance.alarm();
    expect((await instance.publicationRepairV1(undefined, origin)).result.recovery).toBeNull();
    expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.version).toBe(committedVersion);
    expect(await instance.jobStatus(job.id)).toMatchObject({ status: 'queued', manual_resume: true });
    expect(await state.storage.get('jobs')).toEqual([job.id]);
  });
});

it('leaves an unscheduled head and its alarm unchanged when repair does not commit', async () => {
  const job = await seed();
  await inside(publisher(), async (_instance, state) => state.storage.deleteAlarm());
  const payload = await input();
  await inside(publisher(), async (instance, state) => {
    const put = instance.env.SITE_BUCKET.put.bind(instance.env.SITE_BUCKET);
    const conflict = vi.spyOn(instance.env.SITE_BUCKET, 'put').mockImplementation((key: any, ...args: any[]) => key === 'pages/index.html' ? Promise.resolve(null) : put(key, ...args));
    try { expect(await instance.publicationRepairV1(payload, origin)).toMatchObject({ ok: false, failure: { code: 'publication_changed' } }); }
    finally { conflict.mockRestore(); }
    expect(await state.storage.get(`job:${job.id}`)).toEqual(job);
    expect(await state.storage.get('jobs')).toEqual([job.id]);
    expect(await state.storage.getAlarm()).toBeNull();
    expect(await state.storage.get(pauseKey(job.id))).toBeUndefined();
  });
});
it('skips receipt HEAD on a valid prepared generation while retaining required publication reads', async () => {
  const job = await seed(); const events: any[] = [];
  vi.spyOn(console, 'info').mockImplementation(value => events.push(value));
  await inside(publisher(), async (instance, state) => {
    await state.storage.put(checkpointKey(job.id), { version: 2, generation_id: job.generation_id, phase: 'prepared' });
    const get = vi.spyOn(state.storage, 'get');
    await instance.alarm();
    expect(await instance.jobStatus(job.id)).toMatchObject({ status: 'completed' });
    expect(get.mock.calls.some(([keys]) => Array.isArray(keys) && keys.includes(checkpointKey(job.id)))).toBe(true);
  });
  expect(events.some(event => event.stage === 'rebuild_receipt_read')).toBe(false);
});
it('rechecks alarm delivery after validating targets before reusing an initially unscheduled head', async () => {
  const job = await seed();
  await inside(publisher(), async (_instance, state) => state.storage.deleteAlarm());
  const payload = await input();
  await inside(publisher(), async (instance, state) => {
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const get = instance.env.SITE_BUCKET.get.bind(instance.env.SITE_BUCKET);
    let blocked = false;
    const wait = vi.spyOn(instance.env.SITE_BUCKET, 'get').mockImplementation(async (key: any) => {
      if (key === payload.manifest && !blocked) { blocked = true; entered(); await held; }
      return get(key);
    });
    try {
      const repair = instance.publicationRepairV1(payload, origin); await started;
      const delivered = instance.alarm(); release();
      const result = await repair;
      expect(result).toMatchObject({ ok: true });
      expect(result.result.job.id).not.toBe(job.id);
      expect(result.result.regeneration_status).toBeUndefined();
      await delivered;
      expect(await instance.jobStatus(job.id)).toMatchObject({ status: 'completed' });
      expect((await instance.jobStatus(job.id)).manual_resume).toBeUndefined();
    } finally { release(); wait.mockRestore(); }
  });
});
