import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { RepairCoordinator, restartRebuild, newRebuild, pauseReason, REPAIR_MARKER } from '../../src/repair-coordinator';
import { OperationTrace } from '../../src/diagnostics';
import { publishDigest } from '../../src/publishing';
import { fingerprint } from '../../src/primitives';
import { HttpError } from '../../src/errors';
import { at, bucketWith, digest, origin } from '../helpers/fixtures';
import type { Env, RebuildJob } from '../../src/types';
const bindings = env as unknown as Env; const bucket = bindings.SITE_BUCKET;
const inside = runInDurableObject as unknown as <T>(stub: unknown, action: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
const inStorage = <T>(action: (storage: DurableObjectStorage) => Promise<T>) => inside(bindings.PUBLISHER.getByName('site'), (_instance, state) => action(state.storage));
beforeEach(async () => { vi.restoreAllMocks(); await reset(); for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {}); });
async function journal(storage: DurableObjectStorage, phase = 'prepared') {
  await publishDigest(bucket, digest(), origin, at, true);
  const index = (await bucket.head('pages/index.html'))!;
  const manifest = `publications/${crypto.randomUUID()}.json`;
  await bucket.put(manifest, await (await bucket.get(index.customMetadata!.manifest))!.text());
  const input = { expected_version: index.version, manifest, rss: index.customMetadata!.rss, archives: index.customMetadata!.archives ?? null };
  const key = `repair-request:${fingerprint(JSON.stringify([input.expected_version, input.manifest, input.rss, input.archives]))}`;
  const job = newRebuild(crypto.randomUUID(), origin, { complete: true, processed: 0 });
  const record = { id: crypto.randomUUID(), key, input, job, etag: index.etag, state: 'pending', attempts: 0, phase };
  await storage.put(key, record); await storage.put('publication_repair_pending', key);
  return { record, index, input };
}
const coordinator = (storage: DurableObjectStorage, store = bucketWith(bucket)) => new RepairCoordinator(store, storage, async () => ({ job: newRebuild(crypto.randomUUID(), origin, { complete: true, processed: 0 }) }));
it('drops definite old failures while retaining uncertain and committed recovery on restart', () => {
  const base = newRebuild(crypto.randomUUID(), origin, { complete: false, processed: 2 }, { request_id: 'test', operation: 'rebuild', candidate_job_id: 'candidate' } as any);
  expect(base.context).not.toHaveProperty('candidate_job_id'); expect(base.phase).toBe('migration');
  for (const publication_status of ['not_attempted', 'not_committed', 'unknown', 'committed'] as const) {
    const recovery = { code: 'storage_error', stage: 'test', retryable: true, publication_status, failed_at: at.toISOString() };
    const result = restartRebuild({ ...base, recovery, manual_resume: true, error_code: 'storage_error' });
    expect(result).not.toHaveProperty('manual_resume'); expect(result).not.toHaveProperty('error_code');
    expect(result.recovery).toEqual(['unknown', 'committed'].includes(publication_status) ? recovery : undefined);
  }
  expect(pauseReason(base)).toBe('manual_resume'); expect(pauseReason({ ...base, recovery: { code: 'rebuild_checkpoint_damaged' } as any })).toBe('rebuild_checkpoint_damaged');
});
it('exposes stalled journals and malformed journals without clearing outcome evidence', async () => inStorage(async storage => {
  const { record } = await journal(storage); const repair = coordinator(storage);
  await storage.put(record.key, { ...record, stalled: true });
  expect(await repair.blocker()).toMatchObject({ reason: 'repair_stalled' });
  await expect(repair.recover(new OperationTrace())).rejects.toMatchObject({ code: 'repair_stalled', retryable: false });
  await storage.put(record.key, { ...record, key: 'invalid' });
  expect(await repair.snapshot(new OperationTrace())).toMatchObject({ recovery: { state: 'damaged', publication_status: 'unknown' } });
  await expect(repair.recover(new OperationTrace())).rejects.toMatchObject({ code: 'repair_journal_damaged' });
}));
it('respects recovery deadlines and exposes a blocking mutation as uncommitted', async () => inStorage(async storage => {
  const { record } = await journal(storage, 'writing');
  await storage.put(record.key, { ...record, next_retry_at: new Date(Date.now() + 60000).toISOString() });
  const repair = coordinator(storage);
  await expect(repair.gate()).rejects.toMatchObject({ code: 'repair_blocked', publication_status: 'not_committed', retryable: true });
  expect(await storage.getAlarm()).toBeGreaterThan(Date.now());
}));
it.each(['queued', 'failed', 'completed'] as const)('cancels a prepared repair and preserves queue scheduling for a %s head', async status => inStorage(async storage => {
  const { record } = await journal(storage); const repair = coordinator(storage);
  const job = { ...record.job, status };
  await storage.put('jobs', ['missing', 'finished', job.id]); await storage.put('job:finished', { ...job, id: 'finished', status: 'completed' }); await storage.put(`job:${job.id}`, job);
  const snapshot = await repair.snapshot(new OperationTrace());
  const result = await repair.control('cancel', { expected_version: snapshot.publication.version, expected_recovery_token: snapshot.recovery!.recovery_token }, new OperationTrace());
  expect(result.recovery).toBeNull(); expect(await storage.get(record.key)).toMatchObject({ state: 'conflict', conflict_status: 'not_committed' });
  if (status === 'queued') expect(await storage.getAlarm()).toBeGreaterThan(Date.now()); else expect(await storage.getAlarm()).toBeNull();
}));
it('refuses cancellation of an unresolved write and rejects stale recovery controls', async () => inStorage(async storage => {
  await journal(storage, 'writing'); const repair = coordinator(storage); const snapshot = await repair.snapshot(new OperationTrace());
  const control = { expected_version: snapshot.publication.version, expected_recovery_token: snapshot.recovery!.recovery_token };
  await expect(repair.control('cancel', control, new OperationTrace())).rejects.toMatchObject({ code: 'unsafe_repair_cancellation', publication_status: 'unknown' });
  await expect(repair.control('resume', { ...control, expected_version: 'stale' }, new OperationTrace())).rejects.toMatchObject({ code: 'repair_recovery_changed' });
  await expect(repair.control('cancel', {}, new OperationTrace())).rejects.toMatchObject({ status: 400 });
}));
it('acknowledges a proven repair receipt during cancellation instead of declaring non-commit', async () => inStorage(async storage => {
  const { record, index } = await journal(storage, 'writing');
  const object = (await bucket.get('pages/index.html'))!;
  await bucket.put('pages/index.html', await object.arrayBuffer(), { httpMetadata: index.httpMetadata, customMetadata: { ...index.customMetadata, ...record.input, [REPAIR_MARKER]: record.id } });
  const repair = coordinator(storage); const snapshot = await repair.snapshot(new OperationTrace());
  expect(await repair.control('cancel', { expected_version: snapshot.publication.version, expected_recovery_token: snapshot.recovery!.recovery_token }, new OperationTrace())).toMatchObject({ recovery: null });
  expect(await storage.get(record.key)).toMatchObject({ state: 'committed' });
}));
it.each([false, true])('reconciles an uncertain conditional rejection when bytes changed=%s', async changed => inStorage(async storage => {
  const { record, index } = await journal(storage, 'writing'); let heads = 0;
  const store = bucketWith(bucket, {
    head: key => key === 'pages/index.html' && ++heads >= 2 && changed ? Promise.resolve({ ...index, etag: 'new-bytes' } as R2Object) : bucket.head(key),
    put: (key, body, opts) => key === 'pages/index.html' ? Promise.resolve(null) : bucket.put(key, body, opts),
  });
  const repair = coordinator(storage, store);
  if (changed) {
    await repair.recover(new OperationTrace(), false); expect(await storage.get(record.key)).toMatchObject({ state: 'conflict', conflict_status: 'unknown' });
  } else {
    await expect(repair.recover(new OperationTrace(), false)).rejects.toMatchObject({ code: 'repair_pending', publication_status: 'unknown' });
    expect(await storage.get(record.key)).toMatchObject({ state: 'pending', attempts: 1 });
  }
}));
it('reads legacy version-based acknowledgement receipts without creating a new repair', async () => inStorage(async storage => {
  await publishDigest(bucket, digest(), origin, at, true);
  const index = (await bucket.head('pages/index.html'))!; const job: RebuildJob = { ...newRebuild(crypto.randomUUID(), origin, { complete: true, processed: 1 }), status: 'completed' };
  await storage.put(`repair:${index.version}`, job.id); await storage.put(`job:${job.id}`, job);
  const result = await coordinator(storage).submit({ expected_version: index.version, manifest: index.customMetadata!.manifest, rss: index.customMetadata!.rss, archives: index.customMetadata!.archives ?? null }, origin, new OperationTrace());
  expect(result).toMatchObject({ unchanged: true, job: { id: job.id, status: 'completed' } });
  expect(await storage.get('publication_repair_pending')).toBeUndefined();
}));

it.each(['invalid-target', 'publication-changed', 'journal-rollback', 'unreadable-ack'] as const)('does not report reserved identifiers after %s', async fault => inStorage(async storage => {
  const { record, index, input } = await journal(storage);
  await storage.delete([record.key, 'publication_repair_pending']);
  if (fault === 'invalid-target') await bucket.delete(input.manifest);
  const store = bucketWith(bucket, fault === 'publication-changed' ? {
    get: async key => key === 'pages/index.html' ? null : bucket.get(key),
  } : {});
  if (fault === 'journal-rollback' || fault === 'unreadable-ack') {
    vi.spyOn(storage, 'transaction').mockRejectedValueOnce(new Error('Journal unavailable'));
    if (fault === 'unreadable-ack') {
      const get = storage.get.bind(storage) as any; let reads = 0;
      vi.spyOn(storage, 'get').mockImplementation((key: any) => key === record.key && ++reads >= 3 ? Promise.reject(new Error('Readback unavailable')) : get(key));
    }
  }
  const prior = { ...record.job, status: 'failed' as const, error_code: 'source_damaged' };
  await storage.put(`job:${prior.id}`, prior);
  const repair = new RepairCoordinator(store, storage, async () => ({ job: prior }));
  const failure = await repair.submit(input, origin, new OperationTrace()).catch(error => error);
  expect(failure).toMatchObject({
    code: fault === 'invalid-target' ? 'invalid_repair_target' : fault === 'publication-changed' ? 'publication_changed' : 'storage_error',
    publication_status: 'not_committed',
  });
  expect(failure.details).not.toHaveProperty('repair_id'); expect(failure.details).not.toHaveProperty('job_id');
  expect(await storage.get(`job:${prior.id}`)).toEqual(prior);
  expect((await bucket.head('pages/index.html'))!.version).toBe(index.version);
}));

it.each([false, true])('acknowledges durable terminal cancellation, retrying a failed cancellation write=%s', async failCancellation => inside(bindings.PUBLISHER.getByName('site'), async (instance, state) => {
  const storage = state.storage; const { record } = await journal(storage);
  const prior = record.job;
  const planned = { ...prior, generation_id: crypto.randomUUID(), scheduling: 'manual', manual_resume: true };
  await storage.put(record.key, { ...record, job: planned, handoff: {
    version: 1, job_id: planned.id, generation_id: planned.generation_id, repair_id: record.id, prior_job: prior,
    prior_checkpoint: null, prior_archive_checkpoint: null, prior_committed: false, repairable_code: 'unscheduled',
  } });
  await storage.put('jobs', [prior.id]); await storage.put(`job:${prior.id}`, prior);
  const head = vi.spyOn(instance.env.SITE_BUCKET, 'head').mockRejectedValue(new HttpError(400, 'Prepared representation rejected'));
  const writes = vi.spyOn(instance.env.SITE_BUCKET, 'put');
  if (failCancellation) {
    const transaction = vi.spyOn(storage, 'transaction').mockRejectedValueOnce(new Error('Cancellation unavailable'));
    await expect(instance.alarm()).rejects.toBeDefined(); transaction.mockRestore();
    expect(await storage.get('publication_repair_pending')).toBe(record.key);
  }
  await expect(instance.alarm()).resolves.toBeUndefined(); head.mockRestore();
  expect(writes).not.toHaveBeenCalled();
  expect(await storage.get(`job:${prior.id}`)).toEqual(prior);
  expect(await storage.get(record.key)).toMatchObject({ state: 'conflict', conflict_status: 'not_committed' });
  expect(await storage.get('publication_repair_pending')).toBeUndefined();
  expect(await storage.getAlarm()).toBeNull();
}));

it('surfaces a durably cancelled recovery rejection to API callers', async () => inStorage(async storage => {
  const { input, record } = await journal(storage);
  const original = new HttpError(400, 'Prepared representation rejected');
  const repair = coordinator(storage, bucketWith(bucket, { head: async () => { throw original; } }));
  await expect(repair.submit(input, origin, new OperationTrace())).rejects.toMatchObject({ status: 400, cause: original });
  expect(await storage.get(record.key)).toMatchObject({ state: 'conflict' });
}));
