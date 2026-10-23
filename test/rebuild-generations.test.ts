import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { publishDigest } from '../src/publishing';
import { REBUILD_GENERATION, REBUILD_MARKER } from '../src/index-metadata';
import { checkpointKey, generationKey } from '../src/rebuild-evidence';
import { currentPublication } from '../src/publishing';
import { fenceIndex, withoutIndexFence } from '../src/index-fence';
import { composeHomepageConditions } from '../src/homepage-conditions';
import type { Env } from '../src/types';

const bindings = env as unknown as Env;
const origin = 'https://lakearrowhead.town';
const publisher = () => bindings.PUBLISHER.getByName('site');
const inside = runInDurableObject as unknown as <T>(stub: unknown, callback: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
beforeEach(async () => { vi.restoreAllMocks(); await reset(); });
afterEach(() => vi.restoreAllMocks());

async function seed() {
  await publishDigest(bindings.SITE_BUCKET, { title: 'News', source: 'Test', items: [{ group: 'Test', group_url: origin,
    headline: 'Story', body: 'Body', category: '', post_url: origin + '/story', posted_at: new Date().toISOString() }] }, origin, new Date(), true);
  await inside(publisher(), async (_instance, state) => state.storage.put('migration', { complete: true, processed: 1 }));
  return publisher().enqueueRebuild(origin);
}

it('reads generation checkpoints and finalizes the matching receipt without rendering again', async () => {
  const job = { ...await seed(), generation_id: crypto.randomUUID() };
  const index = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
  await bindings.SITE_BUCKET.put('pages/index.html', await index.text(), { customMetadata: {
    ...index.customMetadata, [REBUILD_MARKER]: job.id, [REBUILD_GENERATION]: job.generation_id,
  } });
  const before = (await bindings.SITE_BUCKET.head('pages/index.html'))!.version;
  await inside(publisher(), async (instance, state) => {
    await state.storage.put(`job:${job.id}`, job);
    await state.storage.put(checkpointKey(job.id), { version: 2, generation_id: job.generation_id, phase: 'dispatching' });
    const get = vi.spyOn(instance.env.SITE_BUCKET, 'get').mockRejectedValue(new Error('A completed generation must not render'));
    try { await instance.alarm(); } finally { get.mockRestore(); }
    expect(await instance.jobStatus(job.id)).toMatchObject({ status: 'completed', generation_id: job.generation_id });
    expect(await state.storage.get(checkpointKey(job.id))).toBeUndefined();
  });
  expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.version).toBe(before);
});

it('does not accept another generation checkpoint as the active job evidence', async () => {
  const job = { ...await seed(), generation_id: crypto.randomUUID() };
  await inside(publisher(), async (instance, state) => {
    await state.storage.put(`job:${job.id}`, job);
    await state.storage.put(checkpointKey(job.id), { version: 2, generation_id: crypto.randomUUID(), phase: 'dispatching' });
    await instance.alarm();
    expect(await instance.jobStatus(job.id)).toMatchObject({ blocked: { reason: 'rebuild_checkpoint_damaged' }, recovery: { retryable: false } });
  });
});

async function repairInput() {
  const index = (await bindings.SITE_BUCKET.head('pages/index.html'))!;
  const manifest = `publications/${crypto.randomUUID()}.json`;
  await bindings.SITE_BUCKET.put(manifest, JSON.stringify(await currentPublication(bindings.SITE_BUCKET)));
  return { expected_version: index.version, manifest, rss: index.customMetadata!.rss, archives: index.customMetadata!.archives ?? null };
}

async function pausedJob() {
  const job = await seed();
  await inside(publisher(), async (_instance, state) => {
    await state.storage.put(`job:${job.id}`, { ...job, status: 'running', manual_resume: true, scheduling: 'manual', pause_reason: 'manual_resume',
      recovery: { code: 'source_damaged', stage: 'source_loading', retryable: false, publication_status: 'unknown', failed_at: new Date().toISOString() } });
    await state.storage.put(checkpointKey(job.id), { version: 2, generation_id: job.generation_id, phase: 'dispatching' });
    await state.storage.deleteAlarm();
  });
  return job;
}

it('repairs a paused generation twice, retaining one job, its pause and each prior checkpoint', async () => {
  const original = await pausedJob(); let previous = original.generation_id;
  for (let n = 0; n < 2; n++) {
    const input = await repairInput();
    const reply = await publisher().publicationRepairV1(input, origin);
    expect(reply).toMatchObject({ ok: true, result: { job: { id: original.id, manual_resume: true, scheduling: 'manual' } } });
    if (!reply.ok) throw new Error('Repair failed');
    const job = reply.result.job!; expect(job.generation_id).not.toBe(previous);
    await inside(publisher(), async (instance, state) => {
      expect(await state.storage.get('jobs')).toEqual([original.id]);
      expect(await state.storage.get(generationKey(original.id, job.generation_id!))).toMatchObject({ prior_job: { generation_id: previous } });
      expect(await state.storage.get(checkpointKey(original.id))).toMatchObject({ version: 2, phase: 'prepared', generation_id: job.generation_id });
      expect(await state.storage.getAlarm()).toBeNull();
      await instance.alarm(); expect(await instance.jobStatus(original.id)).toMatchObject({ blocked: { reason: 'manual_resume' } });
    });
    previous = job.generation_id;
  }
  await evictDurableObject(publisher());
  expect(await publisher().resumeRebuild(original.id)).toMatchObject({ id: original.id, generation_id: previous });
  await runDurableObjectAlarm(publisher());
  expect(await publisher().jobStatus(original.id)).toMatchObject({ status: 'completed', generation_id: previous });
  const receipt = (await bindings.SITE_BUCKET.head('pages/index.html'))!;
  expect(receipt.customMetadata).toMatchObject({ [REBUILD_MARKER]: original.id, [REBUILD_GENERATION]: previous });
});

it('does not change a paused head or its evidence when a repair is rejected', async () => {
  const job = await pausedJob(); const input = await repairInput();
  await inside(publisher(), async (instance, state) => {
    const before = await state.storage.list();
    expect(await instance.publicationRepairV1({ ...input, expected_version: 'stale' }, origin)).toMatchObject({ ok: false });
    expect(await state.storage.list()).toEqual(before);
    expect(await instance.publicationRepairV1({ ...input, rss: `publications/${crypto.randomUUID()}.rss.xml` }, origin)).toMatchObject({ ok: false });
    expect(await state.storage.list()).toEqual(before);
    expect(await instance.jobStatus(job.id)).toMatchObject({ generation_id: job.generation_id, blocked: { reason: 'manual_resume' } });
  });
});

it.each([false, true])('recovers a missing checkpoint from its receipt only with completed migration (complete=%s)', async complete => {
  const job = await seed();
  await inside(publisher(), async (instance, state) => {
    const transaction = state.storage.transaction.bind(state.storage); let commits = 0;
    const fault = vi.spyOn(state.storage, 'transaction').mockImplementation(callback => transaction(async storage => {
      await callback(storage); if (await storage.get(`job:${job.id}`).then((value: any) => value?.status === 'completed')) throw new Error('Lost finalization');
    }));
    try { await expect(instance.alarm()).rejects.toBeDefined(); } finally { fault.mockRestore(); }
    await state.storage.delete(checkpointKey(job.id));
    await state.storage.put('migration', { complete, processed: 1 });
    const index = (await bindings.SITE_BUCKET.head('pages/index.html'))!;
    const put = instance.env.SITE_BUCKET.put.bind(instance.env.SITE_BUCKET);
    const noPublication = vi.spyOn(instance.env.SITE_BUCKET, 'put').mockImplementation((key: any, ...args: any[]) => { if (key === 'pages/index.html') commits++; return put(key, ...args); });
    try { await instance.alarm(); } finally { noPublication.mockRestore(); }
    expect(await instance.jobStatus(job.id)).toMatchObject(complete ? { status: 'completed' } : { blocked: { reason: 'rebuild_checkpoint_damaged' } });
    expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.version).toBe(index.version); expect(commits).toBe(0);
  });
});

it('fences a delayed old generation across repair, conditions and subsequent identical-content publications', async () => {
  const job = await pausedJob();
  const old = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
  const visible = withoutIndexFence(await old.text());
  const input = await repairInput(); expect(await publisher().publicationRepairV1(input, origin)).toMatchObject({ ok: true });
  const lateWrite = () => bindings.SITE_BUCKET.put('pages/index.html', fenceIndex(visible), { onlyIf: { etagMatches: old.etag }, customMetadata: {
    ...old.customMetadata, [REBUILD_MARKER]: job.id, [REBUILD_GENERATION]: job.generation_id!,
  } });
  expect(await lateWrite()).toBeNull();
  await composeHomepageConditions(bindings.SITE_BUCKET, origin);
  expect(await lateWrite()).toBeNull();
  await publisher().resumeRebuild(job.id); await runDurableObjectAlarm(publisher());
  expect(await publisher().jobStatus(job.id)).toMatchObject({ status: 'completed' });
  expect(await lateWrite()).toBeNull();
});
