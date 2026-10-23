import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { publishDigest } from '../src/publishing';
import { REBUILD_GENERATION, REBUILD_MARKER } from '../src/index-metadata';
import { checkpointKey } from '../src/rebuild-evidence';
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
