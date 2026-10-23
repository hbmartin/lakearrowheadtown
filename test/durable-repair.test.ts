import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { currentPublication, publishDigest } from '../src/publishing';
import { failureError, OperationFailure } from '../src/errors';
import { OperationTrace } from '../src/diagnostics';
import { REPAIR_MARKER } from '../src/repair-coordinator';
import { REBUILD_MARKER } from '../src/index-metadata';
import type { Digest, Env, RebuildJob } from '../src/types';

const bindings = env as unknown as Env;
const origin = 'https://lakearrowhead.town';
const secret = 'test-secret-at-least-thirty-two-characters-long';
const publisher = () => bindings.PUBLISHER.getByName('site');
const inside = runInDurableObject as unknown as <T>(stub: unknown, callback: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
const request = (body?: unknown, query = '') => worker.fetch(new Request(origin + '/api/publication/repair' + query, {
  method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), bindings);
async function seed() {
  const digest: Digest = { title: 'Test', source: 'Test', items: [{ group: 'Test', group_url: origin, headline: 'Story', body: 'Body', category: '', post_url: origin + '/source', posted_at: new Date().toISOString() }] };
  await publishDigest(bindings.SITE_BUCKET, digest, origin, new Date(), true);
  await inside(publisher(), async (_instance, state) => state.storage.put('migration', { processed: 1, complete: true }));
  const index = (await bindings.SITE_BUCKET.head('pages/index.html'))!;
  const publication = await currentPublication(bindings.SITE_BUCKET);
  const manifest = `publications/${crypto.randomUUID()}.json`;
  await bindings.SITE_BUCKET.put(manifest, JSON.stringify(publication));
  return { input: { expected_version: index.version, manifest, rss: index.customMetadata!.rss, archives: index.customMetadata!.archives ?? null }, publication };
}
let events: any[];
beforeEach(async () => {
  vi.restoreAllMocks(); await reset(); events = [];
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(value => events.push({ ...value, level }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const advanceRecovery = async () => {
  await inside(publisher(), async (_instance, state) => {
    const key = await state.storage.get<string>('publication_repair_pending');
    const record = key ? await state.storage.get<any>(key) : undefined;
    if (record?.next_retry_at) vi.setSystemTime(new Date(record.next_retry_at));
  });
  await evictDurableObject(publisher());
  await runDurableObjectAlarm(publisher());
};

it('a real conditional rejection leaves the damaged head failed, with no extra job or automatic stale retry', async () => {
  const { input } = await seed();
  const index = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
  await bindings.SITE_BUCKET.put('pages/index.html', await index.text(), { customMetadata: { ...index.customMetadata, manifest: `publications/${crypto.randomUUID()}.json` } });
  const head = await publisher().enqueueRebuild(origin);
  await runDurableObjectAlarm(publisher());
  input.expected_version = (await bindings.SITE_BUCKET.head('pages/index.html'))!.version;
  await inside(publisher(), async instance => {
    const bucket = instance.env.SITE_BUCKET; const put = bucket.put.bind(bucket);
    const spy = vi.spyOn(bucket, 'put').mockImplementation(async (key: any, body: any, options: any) => {
      if (key === 'pages/index.html') {
        const before = (await bindings.SITE_BUCKET.get(key))!;
        await put(key, (await before.text()) + '<!-- contention -->', { customMetadata: before.customMetadata });
      }
      return put(key, body, options);
    });
    try {
      const response = await request(input); expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'publication_changed', retryable: false, publication_status: 'not_committed' });
    } finally { spy.mockRestore(); }
  });
  expect((await request(input)).status).toBe(409);
  await runDurableObjectAlarm(publisher());
  expect(await publisher().jobStatus(head.id)).toMatchObject({ status: 'failed', error_code: 'manifest_damaged' });
  await inside(publisher(), async (_instance, state) => {
    expect(await state.storage.get('jobs')).toEqual([head.id]);
    expect(await state.storage.getAlarm()).toBeNull();
  });
  input.expected_version = (await bindings.SITE_BUCKET.head('pages/index.html'))!.version;
  const repaired = await (await request(input)).json<any>();
  expect(repaired.job.id).toBe(head.id);
  await runDurableObjectAlarm(publisher());
  expect(await publisher().jobStatus(head.id)).toMatchObject({ status: 'completed' });
});

it.each(['preparation_ack', 'index_ack', 'activation', 'activation_ack', 'result_read'] as const)('recovers %s failure across eviction using one durable job and receipt', async fault => {
  const { input } = await seed(); let injected = false;
  let failed: any;
  await inside(publisher(), async (instance, state) => {
    const spies: { mockRestore(): void }[] = [];
    if (fault === 'index_ack') {
      const put = instance.env.SITE_BUCKET.put.bind(instance.env.SITE_BUCKET);
      spies.push(vi.spyOn(instance.env.SITE_BUCKET, 'put').mockImplementation(async (...args: any[]) => {
        const result = await put(...args);
        if (args[0] === 'pages/index.html' && !injected) { injected = true; throw new Error('lost acknowledgement'); }
        return result;
      }));
    } else if (fault === 'result_read') {
      const get = state.storage.get.bind(state.storage);
      spies.push(vi.spyOn(state.storage, 'get').mockImplementation(async (...args: any[]) => {
        const result = await (get as any)(...args);
        if (args[0]?.startsWith('repair-request:') && result?.state === 'committed' && !injected) { injected = true; throw new Error('result unavailable'); }
        return result;
      }));
    } else {
      const transaction = state.storage.transaction.bind(state.storage);
      spies.push(vi.spyOn(state.storage, 'transaction').mockImplementation(async callback => {
        let preparation = false; let activation = false;
        const result = await transaction(async storage => callback(new Proxy(storage, { get(target, property) {
          if (property === 'put') return async (key: any, value: any) => {
            preparation ||= key === 'publication_repair_pending';
            activation ||= typeof key === 'string' && key.startsWith('repair:');
            if (fault === 'activation' && activation && !injected) { injected = true; throw new Error('receipt unavailable'); }
            return target.put(key, value);
          };
          const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
        } })));
        if (!injected && (fault === 'preparation_ack' && preparation || fault === 'activation_ack' && activation)) {
          injected = true; throw new Error('lost transaction acknowledgement');
        }
        return result;
      }));
    }
    try {
      const response = await request(input); expect(response.status).toBe(503);
      failed = await response.json<any>();
      expect(failed).toMatchObject({ code: 'repair_pending', retryable: true,
        publication_status: fault === 'preparation_ack' ? 'not_committed' : fault === 'index_ack' ? 'unknown' : 'committed',
        details: { repair_id: expect.any(String), job_id: expect.any(String) }, retry_at: expect.any(String) });
    } finally { spies.forEach(spy => spy.mockRestore()); }
  });
  expect(injected).toBe(true);
  await advanceRecovery();
  for (let i = 0; i < 3; i++) {
    const status = await publisher().jobStatus(failed.details.job_id);
    if (status?.status === 'completed') break;
    await runDurableObjectAlarm(publisher());
  }
  expect(await publisher().jobStatus(failed.details.job_id)).toMatchObject({ status: 'completed' });
  const retry = await (await request(input)).json<any>();
  expect(retry).toMatchObject({ ok: true, unchanged: true, repair_id: failed.details.repair_id, job: { id: failed.details.job_id, status: 'completed' } });
  const jobs = await inside(publisher(), async (_instance, state) => [...(await state.storage.list<RebuildJob>({ prefix: 'job:' })).keys()]);
  expect(jobs).toEqual([`job:${failed.details.job_id}`]);
});

it.each([true, false])('validates the canonical rebuild source when raw legacy data exists=%s', async rawExists => {
  const { input, publication } = await seed(); const ref = publication.posts[0];
  const raw = `digests/${ref.date}.json`;
  if (rawExists) {
    await bindings.SITE_BUCKET.put(raw, await (await bindings.SITE_BUCKET.get(ref.key))!.text());
    await bindings.SITE_BUCKET.delete(ref.key);
  }
  await bindings.SITE_BUCKET.put(input.manifest, JSON.stringify({ ...publication, posts: [{ ...ref, key: raw }] }));
  const response = await request(input);
  if (rawExists) {
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_repair_target', details: { key: ref.key, reason: 'missing' } });
  } else {
    expect(response.status).toBe(200); const result = await response.json<any>();
    await runDurableObjectAlarm(publisher());
    expect(await publisher().jobStatus(result.job.id)).toMatchObject({ status: 'completed' });
  }
});

it('reads body-free snapshots while the publication queue is held', async () => {
  await seed();
  await inside(publisher(), async instance => {
    let release!: () => void; let entered!: () => void;
    const admission = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const busy = instance.serialize(async () => { entered(); await gate; });
    await admission;
    const get = vi.spyOn(instance.env.SITE_BUCKET, 'get');
    const head = vi.spyOn(instance.env.SITE_BUCKET, 'head');
    try {
      expect(await instance.publicationRepairV1(undefined, origin)).toMatchObject({ ok: true, result: { unchanged: true } });
      expect(get).not.toHaveBeenCalled(); expect(head).toHaveBeenCalledTimes(1);
    } finally { release(); await busy; get.mockRestore(); head.mockRestore(); }
  });
});

it('rejects an unrelated failed head before any candidate content reads', async () => {
  const { input } = await seed(); const job = await publisher().enqueueRebuild(origin);
  await inside(publisher(), async (instance, state) => {
    await state.storage.put(`job:${job.id}`, { ...job, status: 'failed', error_code: 'render_failed' });
    const get = vi.spyOn(instance.env.SITE_BUCKET, 'get');
    try { expect(await instance.publicationRepairV1(input, origin)).toMatchObject({ ok: false, failure: { code: 'rebuild_blocked' } }); expect(get).not.toHaveBeenCalled(); }
    finally { get.mockRestore(); }
  });
});

it('preserves storage failures as server errors and clears explicit-recovery backoff', async () => {
  const { input } = await seed();
  await inside(publisher(), async instance => {
    const spy = vi.spyOn(instance.env.SITE_BUCKET, 'get').mockRejectedValue(new Error('storage down'));
    try { expect(await instance.publicationRepairV1(input, origin)).toMatchObject({ ok: false, failure: { status: 500, code: 'storage_error', retryable: true } }); }
    finally { spy.mockRestore(); }
  });
  const job = await publisher().enqueueRebuild(origin);
  await inside(publisher(), async (_instance, state) => state.storage.put(`job:${job.id}`, { ...job, status: 'failed', error_code: 'source_damaged', conflict_count: 9, next_retry_at: new Date(Date.now() + 30000).toISOString() }));
  const result = await (await request(input)).json<any>();
  expect(result.job.id).toBe(job.id); expect(result.job.conflict_count).toBeUndefined(); expect(result.job.next_retry_at).toBeUndefined();
  await inside(publisher(), async (_instance, state) => state.storage.put(`job:${job.id}`, { ...result.job, status: 'failed', error_code: 'render_failed', conflict_count: 9, next_retry_at: new Date(Date.now() + 30000).toISOString() }));
  const resumed = await publisher().resumeRebuild(job.id);
  expect(resumed).toMatchObject({ status: 'queued' }); expect((resumed as RebuildJob).conflict_count).toBeUndefined(); expect((resumed as RebuildJob).next_retry_at).toBeUndefined();
});

it('reports repair success/no-op certainty, warns for expected rejections, and corrects dry_run advice', async () => {
  const { input } = await seed(); expect((await request(input)).status).toBe(200);
  expect(events).toContainEqual(expect.objectContaining({ event: 'request_completed', operation: 'publication_repair', publication_status: 'committed', publication_outcome: 'repaired' }));
  expect(events).toContainEqual(expect.objectContaining({ event: 'repair_result', publication_status: 'committed', job_id: expect.any(String) }));
  await request(input);
  expect(events).toContainEqual(expect.objectContaining({ event: 'request_completed', operation: 'publication_repair', publication_status: 'not_attempted', publication_outcome: 'unchanged' }));
  const response = await request(input, '?dry_run=true');
  expect(await response.json()).toMatchObject({ suggestion: { action: 'remove_dry_run' } });
  await request({ ...input, expected_version: 'stale', manifest: `publications/${crypto.randomUUID()}.json` });
  expect(events).toContainEqual(expect.objectContaining({ event: 'repair_failed', error_code: 'publication_changed', level: 'warn' }));
});

it('preserves RPC failure stage, issue details, truncation, certainty and retry timing', () => {
  const details = [{ path: 'field', code: 'invalid', message: 'Invalid field' }];
  const failure = failureError({ status: 503, code: 'repair_pending', error: 'Pending', stage: 'repair_activation', details,
    details_truncated: true, publication_status: 'committed', retryable: true, retry_at: new Date(Date.now() + 1000).toISOString() });
  expect(failure).toMatchObject({ stage: 'repair_activation', details, details_truncated: true, publication_status: 'committed', retryable: true });
  expect(new Headers(failure.headers).get('Retry-After')).toBe('1');
  expect(failure).not.toBeInstanceOf(OperationFailure);
});

it('persists reconciliation backoff, honors premature alarms, and gates other index writers across eviction', async () => {
  const { input } = await seed(); let clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  let response: any;
  for (const [i, seconds] of [5, 10, 20, 40, 80, 160, 300].entries()) {
    await inside(publisher(), async instance => {
      const put = instance.env.SITE_BUCKET.put.bind(instance.env.SITE_BUCKET);
      const spy = vi.spyOn(instance.env.SITE_BUCKET, 'put').mockImplementation((key: any, ...args: any[]) => {
        if (key === 'pages/index.html') throw new Error('transport down');
        return put(key, ...args);
      });
      try {
        if (i === 0) response = await (await request(input)).json<any>();
        else await instance.alarm();
      } finally { spy.mockRestore(); }
    });
    const deadline = new Date(clock + seconds * 1000).toISOString();
    await inside(publisher(), async (_instance, state) => {
      const key = (await state.storage.get<string>('publication_repair_pending'))!;
      expect(await state.storage.get(key)).toMatchObject({ attempts: i + 1, next_retry_at: deadline, state: 'pending' });
      expect(await state.storage.get('jobs')).toBeUndefined();
    });
    await evictDurableObject(publisher()); await runDurableObjectAlarm(publisher());
    expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.version).toBe(input.expected_version);
    clock = Date.parse(deadline);
  }
  // A normal publication must settle the pending replacement before pinning its
  // own snapshot. A duplicate digest suffices to exercise the mutation prelude.
  const publication = await currentPublication(bindings.SITE_BUCKET);
  const digest = JSON.parse(await (await bindings.SITE_BUCKET.get(publication.posts[0].key))!.text());
  expect(await publisher().publishV2(digest, origin)).toMatchObject({ ok: true, result: { duplicate: true } });
  expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.customMetadata![REPAIR_MARKER]).toBe(response.details.repair_id);
  await runDurableObjectAlarm(publisher());
  expect(await publisher().jobStatus(response.details.job_id)).toMatchObject({ status: 'completed' });
});

it('recovers a failed cancellation without ever activating its rejected repair', async () => {
  const { input } = await seed(); let cancelled = false;
  await inside(publisher(), async (instance, state) => {
    const put = instance.env.SITE_BUCKET.put.bind(instance.env.SITE_BUCKET);
    const write = vi.spyOn(instance.env.SITE_BUCKET, 'put').mockImplementation(async (key: any, body: any, options: any) => {
      if (key === 'pages/index.html') {
        const index = (await bindings.SITE_BUCKET.get(key))!;
        await put(key, await index.text() + '<!-- contention -->', { customMetadata: index.customMetadata });
      }
      return put(key, body, options);
    });
    const transaction = state.storage.transaction.bind(state.storage);
    const cancel = vi.spyOn(state.storage, 'transaction').mockImplementation(callback => transaction(async storage => callback(new Proxy(storage, {
      get(target, property) {
        if (property === 'put') return (key: any, value: any) => {
          if (value?.state === 'conflict' && !cancelled) { cancelled = true; throw new Error('cancellation unavailable'); }
          return target.put(key, value);
        };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      },
    }))));
    try {
      const response = await request(input); expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'repair_pending', publication_status: 'unknown' });
    } finally { write.mockRestore(); cancel.mockRestore(); }
  });
  expect(cancelled).toBe(true); await advanceRecovery();
  expect((await request(input)).status).toBe(409);
  await inside(publisher(), async (_instance, state) => {
    expect(await state.storage.get('jobs')).toBeUndefined();
    expect(await state.storage.get('publication_repair_pending')).toBeUndefined();
    expect(await state.storage.getAlarm()).toBeNull();
  });
  expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.customMetadata!.manifest).not.toBe(input.manifest);
});

it('rejects deletion between snapshot selection and repair write without recreating the index', async () => {
  const { input } = await seed();
  await inside(publisher(), async instance => {
    const get = instance.env.SITE_BUCKET.get.bind(instance.env.SITE_BUCKET);
    const spy = vi.spyOn(instance.env.SITE_BUCKET, 'get').mockImplementation(async (key: any) => {
      if (key === 'pages/index.html') await bindings.SITE_BUCKET.delete(key);
      return get(key);
    });
    try {
      const response = await request(input); expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ publication_status: 'not_committed' });
    } finally { spy.mockRestore(); }
  });
  expect((await request()).status).toBe(404);
  await runDurableObjectAlarm(publisher());
  expect(await bindings.SITE_BUCKET.head('pages/index.html')).toBeNull();
});

it('stalls after ten failures, keeps status reads pure, and requires guarded explicit recovery', async () => {
  const { input } = await seed(); let result: any; let cycleStart = 0;
  await inside(publisher(), async (instance, state) => {
    const put = instance.env.SITE_BUCKET.put.bind(instance.env.SITE_BUCKET);
    const fail = vi.spyOn(instance.env.SITE_BUCKET, 'put').mockImplementation((key: any, ...args: any[]) => { if (key === 'pages/index.html') throw new Error('offline'); return put(key, ...args); });
    try { for (let i = 0; i < 10; i++) {
      result = await instance.publicationRepairV1(input, origin);
      const key = (await state.storage.get<string>('publication_repair_pending'))!;
      const saved = await state.storage.get<any>(key);
      if (i === 0) cycleStart = Date.parse(saved.next_retry_at) - 5000;
      if (i < 9) vi.setSystemTime(new Date(saved.next_retry_at));
    } }
    finally { fail.mockRestore(); }
    expect(result).toMatchObject({ ok: false, failure: { code: 'repair_stalled', retryable: false } });
    expect(Date.now() - cycleStart).toBe(1_215_000);
    expect(await state.storage.getAlarm()).toBeNull();
    const recordKey = await state.storage.get<string>('publication_repair_pending');
    const saved = await state.storage.get<any>(recordKey!);
    const read = await instance.jobStatus(saved.job.id); expect(read).toBeNull();
    expect(await state.storage.get(recordKey!)).toEqual(saved);
  });
  const inspected = await (await request()).json<any>();
  expect(inspected.recovery).toMatchObject({ state: 'stalled', attempts: 10, publication_status: 'unknown' });
  const payload = { expected_version: inspected.publication.version, expected_recovery_token: inspected.recovery.recovery_token };
  expect((await request(payload, '/cancel')).status).toBe(409);
  const resumed = await request(payload, '/resume'); expect(resumed.status).toBe(200);
  expect((await resumed.json<any>()).recovery).toMatchObject({ state: 'pending', attempts: 0 });
  expect((await request(payload, '/resume')).status).toBe(409);
  await advanceRecovery();
  expect((await (await request()).json<any>()).recovery).toBeNull();
  expect(await publisher().jobStatus(inspected.recovery.job_id)).toMatchObject({ status: 'completed' });
});
it('inspects damaged journals without triggering writes and never force-cancels them', async () => {
  await seed();
  await inside(publisher(), async (_instance, state) => { await state.storage.put('publication_repair_pending', 'missing-journal'); await state.storage.deleteAlarm(); });
  const inspected = await (await request()).json<any>(); expect(inspected.recovery).toMatchObject({ state: 'damaged', publication_status: 'unknown' });
  const cancelled = await request({ expected_version: inspected.publication.version, expected_recovery_token: inspected.recovery.recovery_token }, '/cancel');
  expect(await cancelled.json()).toMatchObject({ code: 'repair_journal_damaged', retryable: false });
});
it('never attributes a blocking repair commit to a different request', async () => {
  const { input } = await seed();
  await inside(publisher(), async instance => {
    const put = instance.env.SITE_BUCKET.put.bind(instance.env.SITE_BUCKET);
    const fail = vi.spyOn(instance.env.SITE_BUCKET, 'put').mockImplementation((key: any, ...args: any[]) => { if (key === 'pages/index.html') throw new Error('offline'); return put(key, ...args); });
    try { await instance.publicationRepairV1(input, origin); } finally { fail.mockRestore(); }
  });
  const other = await request({ ...input, manifest: `publications/${crypto.randomUUID()}.json` });
  expect(await other.json()).toMatchObject({ code: 'repair_blocked', publication_status: 'not_committed', details: { blocking_repair: { repair_id: expect.any(String) } } });
});
it.each([undefined, 'automatic'] as const)('does not revive an unrelated unscheduled rebuild with scheduling=%s', async scheduling => {
  const { input } = await seed(); const id = crypto.randomUUID();
  await inside(publisher(), async (_, state) => {
    await state.storage.put('jobs', [id]); await state.storage.put(`job:${id}`, { id, origin, status: 'running', phase: 'render', processed: 0, ...(scheduling ? { scheduling } : {}), created_at: new Date().toISOString() }); await state.storage.deleteAlarm();
  });
  const repaired = await (await request(input)).json<any>(); expect(repaired.ok).toBe(true);
  expect(await publisher().jobStatus(repaired.job.id)).toMatchObject({ status: 'queued', blocked_by: id });
  await inside(publisher(), async (_, state) => { expect(await state.storage.getAlarm()).toBeNull(); expect(await state.storage.get(`job:${id}`)).toMatchObject({ manual_resume: true }); });
});
it('propagates a failed recovery backoff write instead of acknowledging alarm delivery', async () => {
  const { input } = await seed();
  await inside(publisher(), async (instance, state) => {
    const put = instance.env.SITE_BUCKET.put.bind(instance.env.SITE_BUCKET);
    const failedPut = vi.spyOn(instance.env.SITE_BUCKET, 'put').mockImplementation((key: any, ...args: any[]) => { if (key === 'pages/index.html') throw new Error('offline'); return put(key, ...args); });
    try {
      await instance.publicationRepairV1(input, origin);
      const key = (await state.storage.get<string>('publication_repair_pending'))!;
      const saved = await state.storage.get<any>(key); vi.setSystemTime(new Date(saved.next_retry_at));
      const transaction = state.storage.transaction.bind(state.storage);
      const failedSchedule = vi.spyOn(state.storage, 'transaction').mockImplementation(callback => transaction(async storage => callback(new Proxy(storage, { get(target, property) {
        if (property === 'put') return (name: any, value: any) => { if (value?.attempts === 2) throw new Error('schedule unavailable'); return target.put(name, value); };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } }))));
      try { await expect(instance.alarm()).rejects.toBeInstanceOf(OperationFailure); }
      finally { failedSchedule.mockRestore(); }
    } finally { failedPut.mockRestore(); }
  });
});

it.each([0, 1])('validates the complete repair metadata before journaling at limit + %s bytes', async excess => {
  const { input } = await seed();
  const index = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
  const metadata = { ...index.customMetadata, padding: '' };
  const size = Object.entries(metadata).reduce((n, [key, value]) => n + new TextEncoder().encode(key + value).length, 0);
  metadata.padding = 'x'.repeat(8192 - REPAIR_MARKER.length - 36 - size + excess);
  await bindings.SITE_BUCKET.put('pages/index.html', await index.text(), { customMetadata: metadata });
  input.expected_version = (await bindings.SITE_BUCKET.head('pages/index.html'))!.version;
  const response = await request(input);
  expect(response.status).toBe(excess ? 400 : 200);
  if (excess) {
    expect(await response.json()).toMatchObject({ code: 'invalid_repair_target' });
    expect(events.some(event => event.event === 'operation_stage' && ['repair_validation', 'repair_queue_read'].includes(event.stage))).toBe(false);
    await inside(publisher(), async (_, state) => {
      expect(await state.storage.get('publication_repair_pending')).toBeUndefined();
      expect(await state.storage.get('jobs')).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  }
});

it('identical early retries cannot consume the repair budget or dispatch another write', async () => {
  const { input } = await seed();
  await inside(publisher(), async (instance, state) => {
    const store = instance.env.SITE_BUCKET; const put = store.put.bind(store); let writes = 0;
    const spy = vi.spyOn(store, 'put').mockImplementation((key: any, ...args: any[]) => { if (key === 'pages/index.html') { writes++; throw new Error('offline'); } return put(key, ...args); });
    try { for (let i = 0; i < 12; i++) expect(await instance.publicationRepairV1(input, origin)).toMatchObject({ ok: false, failure: { code: 'repair_pending' } }); }
    finally { spy.mockRestore(); }
    const key = (await state.storage.get<string>('publication_repair_pending'))!;
    expect(await state.storage.get(key)).toMatchObject({ attempts: 1, stalled: false }); expect(writes).toBe(1);
  });
});

it.each(['own', 'other'] as const)('reconciles a late %s metadata write between HEAD and GET without false certainty', async who => {
  const { input } = await seed();
  await inside(publisher(), async (instance, state) => {
    const store = instance.env.SITE_BUCKET; const put = store.put.bind(store); const get = store.get.bind(store);
    const fail = vi.spyOn(store, 'put').mockImplementation((key: any, ...args: any[]) => { if (key === 'pages/index.html') throw new Error('lost response'); return put(key, ...args); });
    try { await instance.publicationRepairV1(input, origin); } finally { fail.mockRestore(); }
    const key = (await state.storage.get<string>('publication_repair_pending'))!;
    const saved = await state.storage.get<any>(key); vi.setSystemTime(new Date(saved.next_retry_at)); let landed = false;
    const race = vi.spyOn(store, 'get').mockImplementation(async (name: any) => {
      if (name === 'pages/index.html' && !landed) {
        landed = true; const before = (await get(name))!;
        await put(name, await before.text(), { customMetadata: { ...before.customMetadata, ...(who === 'own' ? { manifest: input.manifest, [REPAIR_MARKER]: saved.id } : { operator_note: 'unrelated' }) } });
      }
      return get(name);
    });
    try {
      const result = await instance.publicationRepairV1(input, origin);
      expect(result).toMatchObject(who === 'own' ? { ok: true, result: { repair_id: saved.id, job: { id: saved.job.id } } }
        : { ok: false, failure: { code: 'repair_pending', publication_status: 'unknown' } });
    } finally { race.mockRestore(); }
    expect(await state.storage.get(key)).toMatchObject({ state: who === 'own' ? 'committed' : 'pending' });
    if (who === 'other') {
      const inspected = await instance.publicationRepairV1(undefined, origin);
      expect(await instance.publicationRepairControlV1('cancel', { expected_version: inspected.result.publication.version, expected_recovery_token: inspected.result.recovery.recovery_token })).toMatchObject({ ok: false, failure: { code: 'unsafe_repair_cancellation' } });
    }
  });
});

it('does not pause a legacy head whose consumed alarm is waiting behind repair preparation', async () => {
  const { input } = await seed(); const queued = await publisher().enqueueRebuild(origin);
  await inside(publisher(), async (instance, state) => {
    const legacy = await state.storage.get<RebuildJob>(`job:${queued.id}`); delete legacy!.scheduling;
    await state.storage.put(`job:${queued.id}`, legacy!);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(r => { entered = r; }); const held = new Promise<void>(r => { release = r; });
    const store = instance.env.SITE_BUCKET; const get = store.get.bind(store); let paused = false;
    const spy = vi.spyOn(store, 'get').mockImplementation(async (key: any) => { if (key === input.manifest && !paused) { paused = true; entered(); await held; } return get(key); });
    try {
      const repairing = instance.publicationRepairV1(input, origin); await started;
      await state.storage.deleteAlarm(); const delivered = instance.alarm(); release();
      expect(await repairing).toMatchObject({ ok: true }); await delivered;
      expect(await state.storage.get(`job:${queued.id}`)).toMatchObject({ status: 'completed' });
      expect((await state.storage.get<RebuildJob>(`job:${queued.id}`))?.manual_resume).toBeUndefined();
      expect(await state.storage.getAlarm()).not.toBeNull();
    } finally { release(); spy.mockRestore(); }
  });
});

it('exposes self-paused, unscheduled, and repair-blocked status without changing storage', async () => {
  const { input } = await seed(); const queued = await publisher().enqueueRebuild(origin);
  await inside(publisher(), async (instance, state) => {
    await state.storage.deleteAlarm();
    expect(await instance.jobStatus(queued.id)).toMatchObject({ blocked: { reason: 'unscheduled', job_id: queued.id } });
    const job = (await state.storage.get<RebuildJob>(`job:${queued.id}`))!;
    await state.storage.put(`job:${queued.id}`, { ...job, manual_resume: true });
    expect(await instance.jobStatus(queued.id)).toMatchObject({ blocked: { reason: 'manual_resume', job_id: queued.id } });
    const put = instance.env.SITE_BUCKET.put.bind(instance.env.SITE_BUCKET);
    const fail = vi.spyOn(instance.env.SITE_BUCKET, 'put').mockImplementation((key: any, ...args: any[]) => { if (key === 'pages/index.html') throw new Error('offline'); return put(key, ...args); });
    try { await instance.publicationRepairV1(input, origin); } finally { fail.mockRestore(); }
    const before = await state.storage.list(); const alarm = await state.storage.getAlarm();
    expect(await instance.jobStatus(queued.id)).toMatchObject({ blocked: { reason: 'repair_pending', repair_id: expect.any(String), retry_at: expect.any(String) } });
    expect(await state.storage.list()).toEqual(before); expect(await state.storage.getAlarm()).toBe(alarm);
  });
});

it('finalizes a committed rebuild across eviction without a second index write, even after a newer publication', async () => {
  await seed(); const queued = await publisher().enqueueRebuild(origin); let indexWrites = 0;
  await inside(publisher(), async (instance, state) => {
    const put = instance.env.SITE_BUCKET.put.bind(instance.env.SITE_BUCKET);
    const writes = vi.spyOn(instance.env.SITE_BUCKET, 'put').mockImplementation(async (...args: any[]) => { const result = await put(...args); if (args[0] === 'pages/index.html') indexWrites++; return result; });
    const transaction = state.storage.transaction.bind(state.storage);
    const failure = vi.spyOn(state.storage, 'transaction').mockImplementation(callback => transaction(async storage => callback(new Proxy(storage, { get(target, prop) {
      if (prop === 'put') return (key: any, value: any) => { if (value?.status === 'completed') throw new Error('finalization unavailable'); return target.put(key, value); };
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    } }))));
    try { await expect(instance.alarm()).rejects.toBeInstanceOf(OperationFailure); }
    finally { writes.mockRestore(); failure.mockRestore(); }
    expect(await state.storage.get(`job:${queued.id}`)).toMatchObject({ status: 'running', recovery: { code: 'storage_error', stage: 'rebuild_finalize', publication_status: 'committed' } });
  });
  expect(indexWrites).toBe(1);
  const publication = await currentPublication(bindings.SITE_BUCKET);
  const digest = JSON.parse(await (await bindings.SITE_BUCKET.get(publication.posts[0].key))!.text());
  digest.items[0].post_url += '/newer'; await publisher().publishV2(digest, origin);
  const index = (await bindings.SITE_BUCKET.head('pages/index.html'))!;
  expect(index.customMetadata?.[REBUILD_MARKER]).toBe(queued.id);
  await evictDurableObject(publisher()); await runDurableObjectAlarm(publisher());
  expect(await publisher().jobStatus(queued.id)).toMatchObject({ status: 'completed' });
  expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.version).toBe(index.version);
  await inside(publisher(), async (_, state) => expect(await state.storage.get('conditions:pending')).toBe(true));
});

it('finishes a successful rebuild without reading the index again after commit', async () => {
  await seed(); const job = await publisher().enqueueRebuild(origin);
  await inside(publisher(), async instance => {
    const store = instance.env.SITE_BUCKET; const put = store.put.bind(store); const head = store.head.bind(store); let committed = false;
    const writes = vi.spyOn(store, 'put').mockImplementation(async (...args: any[]) => { const result = await put(...args); if (args[0] === 'pages/index.html') committed = true; return result; });
    const reads = vi.spyOn(store, 'head').mockImplementation((key: any) => { if (committed && key === 'pages/index.html') throw new Error('post-commit reads are unavailable'); return head(key); });
    try { await instance.alarm(); } finally { writes.mockRestore(); reads.mockRestore(); }
    expect(committed).toBe(true);
  });
  expect(await publisher().jobStatus(job.id)).toMatchObject({ status: 'completed' });
});

it.each(['damaged', {}, { version: 1, migration: { complete: true, processed: -1 } }])('fails closed on a damaged finalization checkpoint %j', async checkpoint => {
  await seed(); const job = await publisher().enqueueRebuild(origin);
  const before = (await bindings.SITE_BUCKET.head('pages/index.html'))!.version;
  await inside(publisher(), async (instance, state) => {
    await state.storage.put(`rebuild-finalization:${job.id}`, checkpoint);
    await instance.alarm();
    expect(await instance.jobStatus(job.id)).toMatchObject({ status: 'queued', manual_resume: true, scheduling: 'manual', blocked: { reason: 'rebuild_checkpoint_damaged' }, recovery: { code: 'rebuild_checkpoint_damaged', retryable: false, publication_status: 'unknown' } });
    expect(await state.storage.getAlarm()).toBeNull();
    await instance.alarm();
  });
  expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.version).toBe(before);
});

it.each([{ manual_resume: true }, { scheduling: 'manual' }])('resumes a paused head with queued delivery %j exactly once', async pause => {
  await seed(); const queued = await publisher().enqueueRebuild(origin);
  await inside(publisher(), async (instance, state) => {
    const job = await state.storage.get<RebuildJob>(`job:${queued.id}`);
    await state.storage.put(`job:${queued.id}`, { ...job, ...pause }); await state.storage.deleteAlarm();
    const resuming = instance.resumeRebuild(queued.id); const delivered = instance.alarm();
    expect(await resuming).toMatchObject({ id: queued.id, status: 'queued' }); await delivered;
    expect(await instance.jobStatus(queued.id)).toMatchObject({ status: 'completed' });
    await instance.alarm();
    expect(events.filter(event => event.event === 'rebuild_completed' && event.job_id === queued.id)).toHaveLength(1);
  });
});

it('restores a damaged checkpoint, resumes explicitly and clears recovery diagnostics', async () => {
  await seed(); const job = await publisher().enqueueRebuild(origin);
  await inside(publisher(), async (instance, state) => {
    await state.storage.put(`rebuild-finalization:${job.id}`, 'bad'); await instance.alarm();
    await state.storage.put(`rebuild-finalization:${job.id}`, { version: 1 });
    expect(await instance.resumeRebuild(job.id)).toMatchObject({ status: 'queued' });
    expect(await instance.jobStatus(job.id)).not.toHaveProperty('blocked');
    await instance.alarm();
    const completed = await instance.jobStatus(job.id); expect(completed.status).toBe('completed');
    expect(completed.recovery).toBeUndefined(); expect(completed.manual_resume).toBeUndefined();
  });
});

it.each([false, true])('retains recovery diagnostics through retry exhaustion and eviction (known committed=%s)', async known => {
  await seed(); const queued = await publisher().enqueueRebuild(origin);
  const index = (await bindings.SITE_BUCKET.get('pages/index.html'))!;
  await bindings.SITE_BUCKET.put('pages/index.html', await index.text(), { customMetadata: { ...index.customMetadata, [REBUILD_MARKER]: queued.id }, httpMetadata: index.httpMetadata });
  const version = (await bindings.SITE_BUCKET.head('pages/index.html'))!.version;
  await inside(publisher(), async (instance, state) => {
    await state.storage.put(`rebuild-finalization:${queued.id}`, { version: 1 });
    await state.storage.put(`job:${queued.id}`, { ...queued, status: 'running', ...(known ? { recovery: { code: 'storage_error', stage: 'rebuild_finalize', retryable: true, publication_status: 'committed', failed_at: new Date().toISOString() } } : {}) });
    const head = instance.env.SITE_BUCKET.head.bind(instance.env.SITE_BUCKET);
    const fault = vi.spyOn(instance.env.SITE_BUCKET, 'head').mockImplementation((key: any) => { if (key === 'pages/index.html') throw new Error('Private receipt outage'); return head(key); });
    try { for (let attempt = 0; attempt <= 6; attempt++) { await state.storage.deleteAlarm(); await expect(instance.alarm()).rejects.toBeInstanceOf(OperationFailure); } }
    finally { fault.mockRestore(); }
  });
  await evictDurableObject(publisher());
  expect(await publisher().jobStatus(queued.id)).toMatchObject({ status: 'running', blocked: { reason: 'unscheduled' }, recovery: { code: 'storage_error', stage: 'rebuild_receipt_read', retryable: true, publication_status: known ? 'committed' : 'unknown' } });
  expect(await publisher().resumeRebuild(queued.id)).toMatchObject({ status: 'queued' }); await runDurableObjectAlarm(publisher());
  expect(await publisher().jobStatus(queued.id)).toMatchObject({ status: 'completed' });
  expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.version).toBe(version);
  expect(JSON.stringify(events)).not.toContain('Private receipt outage');
});

it('redelivers when damaged-checkpoint diagnostics cannot be persisted', async () => {
  await seed(); const job = await publisher().enqueueRebuild(origin);
  await inside(publisher(), async (instance, state) => {
    await state.storage.put(`rebuild-finalization:${job.id}`, 'bad');
    const transaction = state.storage.transaction.bind(state.storage);
    const fault = vi.spyOn(state.storage, 'transaction').mockImplementation(callback => transaction(async storage => callback(new Proxy(storage, { get(target, prop) {
      if (prop === 'put') return (key: any, value: any) => { if (value?.recovery) throw new Error('Private diagnostics outage'); return target.put(key, value); };
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    } }))));
    try { await expect(instance.alarm()).rejects.toBeInstanceOf(OperationFailure); } finally { fault.mockRestore(); }
    expect(await state.storage.get(`job:${job.id}`)).not.toHaveProperty('recovery');
    expect(events).toContainEqual(expect.objectContaining({ event: 'rebuild_recovery_record_failed', original_error_code: 'rebuild_checkpoint_damaged' }));
    await instance.alarm(); expect(await instance.jobStatus(job.id)).toMatchObject({ blocked: { reason: 'rebuild_checkpoint_damaged' } });
    expect(JSON.stringify(events)).not.toContain('Private diagnostics outage');
  });
});

it('reconciles a lost rebuild acknowledgement without publishing it again', async () => {
  await seed(); const job = await publisher().enqueueRebuild(origin); let writes = 0;
  await inside(publisher(), async instance => {
    const put = instance.env.SITE_BUCKET.put.bind(instance.env.SITE_BUCKET);
    const fault = vi.spyOn(instance.env.SITE_BUCKET, 'put').mockImplementation(async (...args: any[]) => {
      const saved = await put(...args); if (args[0] === 'pages/index.html') { writes++; throw new Error('Lost commit acknowledgement'); } return saved;
    });
    try { await expect(instance.alarm()).rejects.toBeDefined(); } finally { fault.mockRestore(); }
    expect(await instance.jobStatus(job.id)).toMatchObject({ status: 'running', recovery: { publication_status: 'unknown' } });
    await instance.alarm(); expect(await instance.jobStatus(job.id)).toMatchObject({ status: 'completed' });
  });
  expect(writes).toBe(1);
});

it.each(['digest', 'append', 'retract', 'resume'])('retains the blocking repair and deadline through HTTP %s', async operation => {
  const { input, publication } = await seed(); const queued = await publisher().enqueueRebuild(origin);
  await inside(publisher(), async instance => {
    const store = instance.env.SITE_BUCKET; const put = store.put.bind(store);
    const fault = vi.spyOn(store, 'put').mockImplementation((key: any, ...args: any[]) => { if (key === 'pages/index.html') throw new Error('offline'); return put(key, ...args); });
    try { await instance.publicationRepairV1(input, origin); } finally { fault.mockRestore(); }
  });
  const inspected = await (await request()).json<any>();
  const post = publication.posts[0];
  const path = operation === 'digest' ? '/api/digests' : operation === 'append' ? `/api/posts/${post.id}/items/0/updates`
    : operation === 'retract' ? `/api/posts/${post.id}/retract` : `/api/rebuild/${queued.id}/resume`;
  const body = operation === 'digest' ? { title: 'New', source: 'Test', items: [{ headline: 'New story', body: 'Details', group: 'Test', group_url: origin, post_url: origin + '/new', category: '', posted_at: new Date().toISOString() }] } : operation === 'append'
    ? { headline: 'Update', body: 'Updated details', group: 'Test', group_url: origin, post_url: origin + '/update', posted_at: new Date().toISOString(), category: '' } : {};
  const response = await worker.fetch(new Request(origin + path, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), bindings);
  expect(response.status).toBe(503); expect(response.headers.get('Retry-After')).not.toBeNull();
  expect(await response.json()).toMatchObject({ code: 'repair_blocked', retryable: true, retry_at: inspected.recovery.next_retry_at,
    details: { blocking_repair: { repair_id: inspected.recovery.repair_id, job_id: inspected.recovery.job_id } } });
});

it.each([false, true])('cleans a proven pre-dispatch checkpoint and stale summary (inherited uncertainty=%s)', async uncertain => {
  await seed(); const queued = await publisher().enqueueRebuild(origin);
  await inside(publisher(), async (instance, state) => {
    await state.storage.put(`job:${queued.id}`, { ...queued, recovery: { code: 'old', stage: 'old', retryable: true, publication_status: uncertain ? 'unknown' : 'not_committed', failed_at: new Date().toISOString() } });
    if (uncertain) await state.storage.put(`rebuild-finalization:${queued.id}`, { version: 1 });
    const put = instance.env.SITE_BUCKET.put.bind(instance.env.SITE_BUCKET); let checkpointSeen = false;
    const fault = vi.spyOn(instance.env.SITE_BUCKET, 'put').mockImplementation(async (key: any, ...args: any[]) => {
      if (key.startsWith('publications/')) {
        checkpointSeen = !!await state.storage.get(`rebuild-finalization:${queued.id}`); throw new Error('Private artifact outage');
      }
      return put(key, ...args);
    });
    try { if (uncertain) await expect(instance.alarm()).rejects.toBeDefined(); else await instance.alarm(); } finally { fault.mockRestore(); }
    expect(checkpointSeen).toBe(true);
    const saved = await instance.jobStatus(queued.id);
    if (uncertain) {
      expect(saved).toMatchObject({ status: 'running', recovery: { code: 'storage_error', publication_status: 'unknown' } });
      expect(await state.storage.get(`rebuild-finalization:${queued.id}`)).toMatchObject({ version: 1 });
    } else {
      expect(saved).toMatchObject({ status: 'failed', error_code: 'storage_error' }); expect(saved.recovery).toBeUndefined();
      expect(await state.storage.get(`rebuild-finalization:${queued.id}`)).toBeUndefined();
      expect(events).toContainEqual(expect.objectContaining({ event: 'rebuild_failed', publication_status: 'not_committed' }));
    }
  });
});

it('does not retain a checkpoint after a definite conditional rejection with no earlier dispatch', async () => {
  await seed(); const queued = await publisher().enqueueRebuild(origin);
  await inside(publisher(), async (instance, state) => {
    const store = instance.env.SITE_BUCKET; const put = store.put.bind(store);
    const fault = vi.spyOn(store, 'put').mockImplementation((key: any, ...args: any[]) => key === 'pages/index.html' ? null : put(key, ...args));
    try { await instance.alarm(); } finally { fault.mockRestore(); }
    expect(await instance.jobStatus(queued.id)).toMatchObject({ status: 'running', conflict_count: 1 });
    expect(await state.storage.get(`rebuild-finalization:${queued.id}`)).toBeUndefined();
  });
});

it('records the checkpoint damage signal even when persisting the pause fails', async () => {
  await seed(); const queued = await publisher().enqueueRebuild(origin);
  await inside(publisher(), async (instance, state) => {
    await state.storage.put(`rebuild-finalization:${queued.id}`, 'damaged');
    const fault = vi.spyOn(state.storage, 'transaction').mockRejectedValue(new Error('Private storage outage'));
    try { await expect(instance.alarm()).rejects.toBeDefined(); } finally { fault.mockRestore(); }
    const signal = events.find(event => event.event === 'rebuild_checkpoint_damaged');
    expect(signal).toMatchObject({ error_code: 'rebuild_checkpoint_damaged', publication_status: 'unknown' });
    expect(signal).not.toHaveProperty('code'); expect(events.some(event => event.event === 'rebuild_finalization_pending')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ event: 'rebuild_recovery_record_failed', original_error_code: 'rebuild_checkpoint_damaged' }));
  });
});

it('recovery routing survives renamed diagnostic stages and logs transient failures before persistence', async () => {
  await seed(); const queued = await publisher().enqueueRebuild(origin);
  await inside(publisher(), async (instance, state) => {
    const run = OperationTrace.prototype.run;
    const renamed = vi.spyOn(OperationTrace.prototype, 'run').mockImplementation(function (this: OperationTrace, stage: string, action: any, fields?: any) {
      return run.call(this, stage === 'rebuild_finalization_read' ? 'renamed_checkpoint_inspection' : stage, action, fields);
    });
    const get = state.storage.get.bind(state.storage) as any;
    const readFault = vi.spyOn(state.storage, 'get').mockImplementation((key: any) => { if (key === `rebuild-finalization:${queued.id}`) throw new Error('Private checkpoint outage'); return get(key); });
    const writeFault = vi.spyOn(state.storage, 'transaction').mockRejectedValue(new Error('Private diagnostics outage'));
    try { await expect(instance.alarm()).rejects.toBeDefined(); } finally { renamed.mockRestore(); readFault.mockRestore(); writeFault.mockRestore(); }
    expect(events).toContainEqual(expect.objectContaining({ event: 'rebuild_finalization_pending', stage: 'renamed_checkpoint_inspection', error_code: 'storage_error', publication_status: 'unknown' }));
    expect(events).toContainEqual(expect.objectContaining({ event: 'rebuild_recovery_record_failed' }));
    expect(events.some(event => event.event === 'rebuild_failed')).toBe(false);
  });
});

it.each(['unknown', 'committed'] as const)('preserves %s evidence across explicit resume and another receipt outage', async certainty => {
  await seed(); const queued = await publisher().enqueueRebuild(origin);
  await inside(publisher(), async (instance, state) => {
    await state.storage.put(`job:${queued.id}`, { ...queued, status: 'running', recovery: { code: 'storage_error', stage: 'rebuild_finalize', retryable: true, publication_status: certainty, failed_at: new Date().toISOString() } });
    await state.storage.put(`rebuild-finalization:${queued.id}`, { version: 1 }); await state.storage.deleteAlarm();
    const resumed = await instance.resumeRebuild(queued.id);
    expect(resumed).toMatchObject({ status: 'queued', recovery: { publication_status: certainty } });
    const head = instance.env.SITE_BUCKET.head.bind(instance.env.SITE_BUCKET);
    const fault = vi.spyOn(instance.env.SITE_BUCKET, 'head').mockImplementation((key: any) => { if (key === 'pages/index.html') throw new Error('Receipt outage after resume'); return head(key); });
    try { await expect(instance.alarm()).rejects.toBeDefined(); } finally { fault.mockRestore(); }
    expect(await instance.jobStatus(queued.id)).toMatchObject({ recovery: { publication_status: certainty } });
  });
});

it('clears inspection-only uncertainty across eviction and lets a related repair reuse the failed head', async () => {
  const { input, publication } = await seed(); const job = await publisher().enqueueRebuild(origin);
  const source = publication.posts[0].key; const savedSource = await (await bindings.SITE_BUCKET.get(source))!.text();
  await inside(publisher(), async (instance, state) => {
    const get = state.storage.get.bind(state.storage) as any;
    const fault = vi.spyOn(state.storage, 'get').mockImplementation((key: any) => {
      if (key === `rebuild-finalization:${job.id}`) throw new Error('Private checkpoint outage'); return get(key);
    });
    await state.storage.deleteAlarm();
    try { await expect(instance.alarm()).rejects.toBeDefined(); } finally { fault.mockRestore(); }
    expect(await state.storage.get(`rebuild-finalization:${job.id}`)).toBeUndefined();
  });
  await bindings.SITE_BUCKET.delete(source); await evictDurableObject(publisher());
  await inside(publisher(), async (instance, state) => {
    await instance.alarm();
    expect(await instance.jobStatus(job.id)).toMatchObject({ status: 'failed', error_code: 'source_damaged' });
    expect(await state.storage.get(`rebuild-finalization:${job.id}`)).toBeUndefined();
    expect((await state.storage.get<RebuildJob>(`job:${job.id}`))?.recovery).toBeUndefined();
    expect(await state.storage.getAlarm()).toBeNull();
  });
  await bindings.SITE_BUCKET.put(source, savedSource);
  const repaired = await (await request(input)).json<any>(); expect(repaired.job.id).toBe(job.id);
  await runDurableObjectAlarm(publisher()); expect(await publisher().jobStatus(job.id)).toMatchObject({ status: 'completed' });
  await inside(publisher(), async (_instance, state) => expect(await state.storage.get('jobs')).toEqual([]));
});

it.each(['source', 'manifest', 'render'] as const)('pauses permanent %s failures without discarding unresolved dispatch evidence', async fault => {
  const { publication } = await seed(); const job = await publisher().enqueueRebuild(origin);
  const before = (await bindings.SITE_BUCKET.head('pages/index.html'))!.version;
  await inside(publisher(), async (instance, state) => {
    await state.storage.put(`rebuild-finalization:${job.id}`, { version: 1 });
    if (fault === 'source') await bindings.SITE_BUCKET.delete(publication.posts[0].key);
    if (fault === 'manifest') await bindings.SITE_BUCKET.put((await bindings.SITE_BUCKET.head('pages/index.html'))!.customMetadata!.manifest, 'bad');
    const run = OperationTrace.prototype.run;
    const rendering = fault === 'render' ? vi.spyOn(OperationTrace.prototype, 'run').mockImplementation(function (this: OperationTrace, stage: string, action: any, fields?: any) {
      return run.call(this, stage, stage === 'rendering' ? () => { throw new OperationFailure('rendering', new Error('Private render fault')); } : action, fields);
    }) : undefined;
    await state.storage.deleteAlarm();
    try { await instance.alarm(); } finally { rendering?.mockRestore(); }
    expect(await instance.jobStatus(job.id)).toMatchObject({ status: 'running', manual_resume: true, scheduling: 'manual', pause_reason: 'manual_resume',
      blocked: { reason: 'manual_resume' }, recovery: { code: fault === 'source' ? 'source_damaged' : fault === 'manifest' ? 'manifest_damaged' : 'render_failed', retryable: false, publication_status: 'unknown' } });
    expect(await state.storage.get(`rebuild-finalization:${job.id}`)).toEqual({ version: 1 });
    expect(await state.storage.getAlarm()).toBeNull();
    await instance.alarm();
  });
  expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.version).toBe(before);
});

it('pauses known committed evidence with a missing checkpoint without republishing', async () => {
  await seed(); const job = await publisher().enqueueRebuild(origin);
  const before = (await bindings.SITE_BUCKET.head('pages/index.html'))!.version;
  await inside(publisher(), async (instance, state) => {
    await state.storage.put(`job:${job.id}`, { ...job, status: 'running', recovery: { code: 'storage_error', stage: 'rebuild_finalize', retryable: true, publication_status: 'committed', failed_at: new Date().toISOString() } });
    await instance.alarm();
    expect(await instance.jobStatus(job.id)).toMatchObject({ pause_reason: 'rebuild_checkpoint_damaged', blocked: { reason: 'rebuild_checkpoint_damaged' }, recovery: { publication_status: 'committed', retryable: false } });
  });
  expect((await bindings.SITE_BUCKET.head('pages/index.html'))!.version).toBe(before);
});

it('does not reuse historical checkpoint damage as the reason for an unrelated repair pause after resume', async () => {
  const { input } = await seed(); const job = await publisher().enqueueRebuild(origin);
  await inside(publisher(), async (instance, state) => {
    await state.storage.put(`rebuild-finalization:${job.id}`, 'bad'); await state.storage.deleteAlarm(); await instance.alarm();
    await state.storage.put(`rebuild-finalization:${job.id}`, { version: 1 });
    const resumed = await instance.resumeRebuild(job.id); expect(resumed.pause_reason).toBeUndefined();
    await state.storage.deleteAlarm();
    expect(await instance.publicationRepairV1(input, origin)).toMatchObject({ ok: true });
    expect(await instance.jobStatus(job.id)).toMatchObject({ pause_reason: 'manual_resume', blocked: { reason: 'manual_resume' }, recovery: { code: 'rebuild_checkpoint_damaged' } });
  });
});

it.each([undefined, 'manual_resume'] as const)('keeps legacy damage-pause fallback but honors an explicit current reason: %s', async pause_reason => {
  await seed(); const job = await publisher().enqueueRebuild(origin);
  await inside(publisher(), async (instance, state) => {
    await state.storage.put(`job:${job.id}`, { ...job, manual_resume: true, pause_reason,
      recovery: { code: 'rebuild_checkpoint_damaged', stage: 'old', retryable: false, publication_status: 'unknown', failed_at: new Date().toISOString() } });
    expect(await instance.jobStatus(job.id)).toMatchObject({ blocked: { reason: pause_reason ?? 'rebuild_checkpoint_damaged' } });
  });
});

it('retains stale evidence atomically if both non-commit cleanup and failure bookkeeping cannot persist', async () => {
  await seed(); const job = await publisher().enqueueRebuild(origin);
  await inside(publisher(), async (instance, state) => {
    const saved = { ...job, recovery: { code: 'old', stage: 'old', retryable: true, publication_status: 'unknown' as const, failed_at: new Date().toISOString() } };
    await state.storage.put(`job:${job.id}`, saved); await state.storage.deleteAlarm();
    const transaction = state.storage.transaction.bind(state.storage);
    const fault = vi.spyOn(state.storage, 'transaction').mockImplementation(callback => transaction(async storage => { await callback(storage); throw new Error('Private transaction rollback'); }));
    try { await expect(instance.alarm()).rejects.toBeDefined(); } finally { fault.mockRestore(); }
    expect(await state.storage.get(`job:${job.id}`)).toEqual(saved);
    expect(await state.storage.get(`rebuild-finalization:${job.id}`)).toBeUndefined();
    await instance.alarm(); expect(await instance.jobStatus(job.id)).toMatchObject({ status: 'completed' });
  });
});

it('reports the actual repair stage and this resume request certainty without copying the repair outcome', async () => {
  const { input } = await seed(); const job = await publisher().enqueueRebuild(origin);
  await inside(publisher(), async (instance, state) => {
    const store = instance.env.SITE_BUCKET; const put = store.put.bind(store);
    const fault = vi.spyOn(store, 'put').mockImplementation((key: any, ...args: any[]) => { if (key === 'pages/index.html') throw new Error('Private index outage'); return put(key, ...args); });
    try {
      await instance.publicationRepairV1(input, origin);
      const key = (await state.storage.get<string>('publication_repair_pending'))!;
      const pending = await state.storage.get<any>(key); vi.setSystemTime(new Date(pending.next_retry_at));
      const context = { request_id: 'resume-stage', operation: 'rebuild', environment: 'preview', worker_version: 'test' };
      expect(await instance.resumeRebuildV1(job.id, context)).toMatchObject({ ok: false, failure: { code: 'repair_blocked', stage: 'index_write', publication_status: 'not_committed', retryable: true } });
      expect(events).toContainEqual(expect.objectContaining({ event: 'rebuild_request_failed', request_id: context.request_id, stage: 'index_write', publication_status: 'not_committed' }));
      expect(events).toContainEqual(expect.objectContaining({ event: 'repair_recovery_failed', request_id: context.request_id, stage: 'index_write', error_code: 'storage_error' }));
    } finally { fault.mockRestore(); }
  });
});
