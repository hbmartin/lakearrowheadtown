import { env } from 'cloudflare:workers';
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { currentPublication, publishDigest } from '../src/publishing';
import { failureError, OperationFailure } from '../src/errors';
import { REPAIR_MARKER } from '../src/repair-coordinator';
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
        publication_status: ['preparation_ack', 'index_ack'].includes(fault) ? 'unknown' : 'committed',
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
  for (const [i, seconds] of [1, 2, 4, 8, 16, 30, 30].entries()) {
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
