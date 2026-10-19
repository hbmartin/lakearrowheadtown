import { env } from 'cloudflare:workers';
import { reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { currentPublication } from '../src/publishing';
import type { Env, OperationContext, Publication, RebuildJob } from '../src/types';

const bindings = env as unknown as Env;
const inPublisher = runInDurableObject as unknown as <T>(stub: unknown, callback: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
const origin = 'https://lakearrowhead.town';
const headers = { Authorization: 'Bearer test-secret-at-least-thirty-two-characters-long', 'Content-Type': 'application/json' };
const id = '00000000-0000-0000-0000-000000000001';
const other = '00000000-0000-0000-0000-000000000002';
const missing = '00000000-0000-0000-0000-000000000003';
const context: OperationContext = { request_id: 'recovery-test', worker_version: 'test', environment: 'preview', operation: 'rebuild' };
const publisher = () => bindings.PUBLISHER.getByName('site');
const request = (path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) => worker.fetch(new Request(origin + path, init), { ...bindings, CF_VERSION_METADATA: { id: 'test-release' }, ENVIRONMENT: 'preview', ...overrides });
const resume = (job = id) => request(`/api/rebuild/${job}/resume`, { method: 'POST', headers });
const job = (status: RebuildJob['status'], jobId = id): RebuildJob => ({ id: jobId, origin, status, phase: 'render', processed: 0, created_at: new Date().toISOString(), context });
const digest = () => ({ title: 'Private title', source: 'Private source', items: [{ group: 'Group', group_url: origin, headline: 'Private headline', body: 'Private body', category: '', post_url: `${origin}/story`, posted_at: new Date().toISOString() }] });
const submit = () => request('/api/digests', { method: 'POST', headers, body: JSON.stringify(digest()) });
async function seed(status: RebuildJob['status'], ids = [id], alarm = false) {
  await inPublisher(publisher(), async (_instance, state) => {
    await state.storage.put({ jobs: ids, [`job:${id}`]: job(status), migration: { complete: true, processed: 0 } });
    if (alarm) await state.storage.setAlarm(Date.now() + 60_000);
  });
}
let events: any[];
beforeEach(async () => {
  vi.restoreAllMocks(); await reset(); events = [];
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(value => { events.push(value); });
});

describe('manual rebuild recovery', () => {
  it.each(['queued', 'running', 'failed'] as const)('resumes a %s head without an alarm and completes it', async status => {
    await seed(status);
    const response = await resume();
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: true, job: { id, status: 'queued' } });
    expect(await runDurableObjectAlarm(publisher())).toBe(true);
    expect(await publisher().jobStatus(id)).toMatchObject({ status: 'completed' });
    expect(await publisher().jobStatus(id)).not.toHaveProperty('recovery_required');
  });
  it.each(['queued', 'running'] as const)('rejects a %s head with an alarm', async status => {
    await seed(status, [id], true);
    const response = await resume();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'job_not_resumable', retryable: false });
    expect(await publisher().jobStatus(id)).toMatchObject({ status });
  });
  it.each(['queued', 'running', 'failed', 'completed'] as const)('rejects a %s job behind another valid job', async status => {
    await seed(status, [other, id]);
    await inPublisher(publisher(), async (_instance, state) => { await state.storage.put(`job:${other}`, job('failed', other)); });
    expect((await resume()).status).toBe(409);
    expect(await publisher().jobStatus(id)).toMatchObject({ status });
  });
  it('rejects completed heads and preserves missing-job responses', async () => {
    await seed('completed');
    expect((await resume()).status).toBe(409);
    const response = await resume(other);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'job_not_found' });
  });
  it('allows only one concurrent resume to acquire an alarm', async () => {
    await seed('running');
    const responses = await Promise.all([resume(), resume()]);
    expect(responses.map(response => response.status).sort()).toEqual([202, 409]);
    await runDurableObjectAlarm(publisher());
    expect(events.filter(event => event.event === 'rebuild_completed' && event.job_id === id)).toHaveLength(1);
  });
  it('serializes alarm delivery with manual resume without running a job twice', async () => {
    await seed('queued', [id], true);
    const [ran, response] = await Promise.all([runDurableObjectAlarm(publisher()), resume()]);
    expect(ran).toBe(true);
    expect([202, 409]).toContain(response.status);
    await runDurableObjectAlarm(publisher());
    expect(await publisher().jobStatus(id)).toMatchObject({ status: 'completed' });
    expect(events.filter(event => event.event === 'rebuild_completed' && event.job_id === id)).toHaveLength(1);
  });
  it('recovers manually after a scheduled attempt and six explicitly simulated retries exhaust', async () => {
    await seed('queued');
    let restore!: () => void;
    await inPublisher(publisher(), async (_instance, state) => {
      const get = state.storage.get.bind(state.storage) as (key: any) => Promise<any>;
      const spy = vi.spyOn(state.storage, 'get').mockImplementation(async (key: any) => {
        if (key === 'jobs') throw new Error('private outage');
        return get(key);
      });
      restore = () => spy.mockRestore();
    });
    try {
      // The helper consumes alarms without scheduling retries. Model each delivery explicitly.
      for (let attempt = 0; attempt <= 6; attempt++) {
        await inPublisher(publisher(), async (_instance, state) => { await state.storage.setAlarm(Date.now() + 1000); });
        await expect(runDurableObjectAlarm(publisher())).rejects.toMatchObject({ kind: 'storage' });
      }
    } finally { restore(); }
    expect(await runDurableObjectAlarm(publisher())).toBe(false);
    expect(await publisher().jobStatus(id)).toMatchObject({ status: 'queued' });
    expect(events.filter(event => event.event === 'rebuild_alarm_failed')).toHaveLength(7);
    expect(events.some(event => event.event === 'rebuild_failed')).toBe(false);
    expect((await resume()).status).toBe(202);
    await runDurableObjectAlarm(publisher());
    expect(await publisher().jobStatus(id)).toMatchObject({ status: 'completed' });
    expect(JSON.stringify(events)).not.toContain('private outage');
  });
});

describe('missing queue entries and storage faults', () => {
  it('skips multiple missing heads and processes every valid job in order', async () => {
    await seed('queued', [missing, 'another-missing-id', id, other], true);
    await inPublisher(publisher(), async (_instance, state) => { await state.storage.put(`job:${other}`, job('queued', other)); });
    await runDurableObjectAlarm(publisher());
    expect(await publisher().jobStatus(id)).toMatchObject({ status: 'completed' });
    expect(await publisher().jobStatus(other)).toMatchObject({ status: 'queued' });
    await runDurableObjectAlarm(publisher());
    expect(await publisher().jobStatus(other)).toMatchObject({ status: 'completed' });
    expect(events.filter(event => event.event === 'rebuild_queue_entry_missing').map(event => event.job_id)).toEqual([missing, 'another-missing-id']);
    expect(events.filter(event => event.event === 'rebuild_completed').map(event => event.job_id)).toEqual([id, other]);
  });
  it('clears an entirely missing queue without rebuilding HTML', async () => {
    await inPublisher(publisher(), async (_instance, state) => {
      await state.storage.put('jobs', [missing, other]); await state.storage.setAlarm(Date.now() + 1000);
    });
    await runDurableObjectAlarm(publisher());
    await inPublisher(publisher(), async (_instance, state) => { expect(await state.storage.get('jobs')).toEqual([]); });
    expect(await bindings.SITE_BUCKET.head('pages/index.html')).toBeNull();
    expect(events.filter(event => event.event === 'rebuild_queue_entry_missing')).toHaveLength(2);
    expect(events.some(event => event.event === 'rebuild_completed')).toBe(false);
  });
  it('preserves a failed valid head and later jobs after pruning missing entries', async () => {
    await seed('failed', [missing, id, other], true);
    await inPublisher(publisher(), async (_instance, state) => { await state.storage.put(`job:${other}`, job('queued', other)); });
    await runDurableObjectAlarm(publisher());
    await inPublisher(publisher(), async (_instance, state) => { expect(await state.storage.get('jobs')).toEqual([id, other]); });
    expect(await publisher().jobStatus(other)).toMatchObject({ status: 'queued', blocked_by: id });
    expect(await bindings.SITE_BUCKET.head('pages/index.html')).toBeNull();
    expect(await runDurableObjectAlarm(publisher())).toBe(false);
  });
  it('prunes missing leading entries during manual recovery', async () => {
    await seed('running', [missing, other, id]);
    expect((await resume()).status).toBe(202);
    await inPublisher(publisher(), async (_instance, state) => { expect(await state.storage.get('jobs')).toEqual([id]); });
    await runDurableObjectAlarm(publisher());
    expect(await publisher().jobStatus(id)).toMatchObject({ status: 'completed' });
  });
  it.each(['alarm', 'resume'] as const)('does not discard missing references when a %s queue-repair transaction fails', async action => {
    await seed('queued', [missing, id], action === 'alarm');
    await inPublisher(publisher(), async (instance, state) => {
      const spy = vi.spyOn(state.storage, 'transaction').mockRejectedValue(new Error('private repair error'));
      try {
        if (action === 'alarm') {
          // Consume the scheduled alarm just as the test helper does.
          await state.storage.deleteAlarm();
          await expect(instance.alarm()).rejects.toMatchObject({ kind: 'storage' });
        } else await expect(instance.resumeRebuild(id, context)).rejects.toMatchObject({ kind: 'storage' });
      } finally { spy.mockRestore(); }
      expect(await state.storage.get('jobs')).toEqual([missing, id]);
      expect(await state.storage.get(`job:${id}`)).toMatchObject({ status: 'queued' });
    });
    expect(events).toContainEqual(expect.objectContaining({ event: action === 'alarm' ? 'rebuild_alarm_failed' : 'rebuild_request_failed', error_code: 'storage_error', stage: action === 'alarm' ? 'rebuild_queue_repair' : 'rebuild_resume_write' }));
    expect(events).toContainEqual(expect.objectContaining({ event: 'operation_stage', stage: action === 'alarm' ? 'rebuild_queue_repair' : 'rebuild_resume_queue_repair', outcome: 'error' }));
    expect(await bindings.SITE_BUCKET.head('pages/index.html')).toBeNull();
  });
  it.each(['jobs', `job:${missing}`, 'alarm'] as const)('does not treat a failed %s lookup as a missing record', async failed => {
    await seed('queued', [missing, id]);
    await inPublisher(publisher(), async (instance, state) => {
      const get = state.storage.get.bind(state.storage) as (key: any) => Promise<any>;
      const spy = vi.spyOn(state.storage, 'get').mockImplementation(async (key: any) => {
        if (key === failed) throw new Error('private lookup error'); return get(key);
      });
      const alarmSpy = failed === 'alarm' ? vi.spyOn(state.storage, 'getAlarm').mockRejectedValue(new Error('private alarm error')) : undefined;
      try { await expect(instance.resumeRebuild(id, context)).rejects.toMatchObject({ kind: 'storage' }); }
      finally { spy.mockRestore(); alarmSpy?.mockRestore(); }
      expect(await state.storage.get(`job:${id}`)).toMatchObject({ status: 'queued' });
      expect(await state.storage.get('jobs')).toEqual([missing, id]);
    });
    if (failed !== 'alarm') expect(events.some(event => event.event === 'rebuild_queue_entry_missing')).toBe(false);
  });
});

async function durableSnapshot() {
  return inPublisher(publisher(), async (_instance, state) => ({ records: await state.storage.list(), alarm: await state.storage.getAlarm() }));
}

describe('consistent queue inspection and atomic resume', () => {
  it('reports and preserves the effective failed head across status, enqueue, resume, and alarm', async () => {
    await seed('failed', [missing, 'second-missing', id, other]);
    await inPublisher(publisher(), async (_instance, state) => { await state.storage.put(`job:${other}`, job('queued', other)); });
    const before = await durableSnapshot();
    expect(await publisher().jobStatus(other, context)).toMatchObject({ status: 'queued', blocked_by: id });
    expect(await durableSnapshot()).toEqual(before);
    const queued = await publisher().enqueueRebuild(origin, context);
    await inPublisher(publisher(), async (_instance, state) => {
      expect(await state.storage.get('jobs')).toEqual([missing, 'second-missing', id, other, queued.id]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(await publisher().jobStatus(queued.id)).toMatchObject({ blocked_by: id });
    const rejected = await durableSnapshot();
    expect((await resume(other)).status).toBe(409);
    expect(await durableSnapshot()).toEqual(rejected);
    await inPublisher(publisher(), async (_instance, state) => { await state.storage.setAlarm(Date.now() + 1000); });
    await runDurableObjectAlarm(publisher());
    await inPublisher(publisher(), async (_instance, state) => {
      expect(await state.storage.get('jobs')).toEqual([id, other, queued.id]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(await publisher().jobStatus(other)).toMatchObject({ blocked_by: id });
  });

  it('enqueues and runs a new head when every old reference is missing', async () => {
    await inPublisher(publisher(), async (_instance, state) => { await state.storage.put('jobs', [missing, other]); });
    const queued = await publisher().enqueueRebuild(origin, context);
    expect(await publisher().jobStatus(queued.id)).not.toHaveProperty('blocked_by');
    await inPublisher(publisher(), async (_instance, state) => { expect(await state.storage.get('jobs')).toEqual([missing, other, queued.id]); });
    await runDurableObjectAlarm(publisher());
    expect(await publisher().jobStatus(queued.id)).toMatchObject({ status: 'completed' });
  });

  it.each([
    ['completed', 'head', false], ['queued', 'head', true], ['running', 'head', true],
    ['queued', 'blocked', false], ['running', 'blocked', false], ['failed', 'blocked', false], ['completed', 'blocked', true],
  ] as const)('rejects a %s %s (alarm: %s) without any durable mutation', async (status, position, alarm) => {
    await seed(status, [missing, ...(position === 'blocked' ? [other] : []), id], alarm);
    if (position === 'blocked') await inPublisher(publisher(), async (_instance, state) => { await state.storage.put(`job:${other}`, job('failed', other)); });
    const before = await durableSnapshot();
    const response = await resume();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'job_not_resumable' });
    expect(await durableSnapshot()).toEqual(before);
    expect(events.some(event => event.stage === 'rebuild_resume_queue_repair')).toBe(false);
  });

  it('does not repair the queue or change its alarm when the requested job is missing', async () => {
    await seed('failed', [missing, id], true);
    const before = await durableSnapshot();
    expect((await resume(other)).status).toBe(404);
    expect(await durableSnapshot()).toEqual(before);
  });

  it('commits queue repair, queued state, and alarm in one transaction', async () => {
    await seed('failed', [missing, 'second-missing', id, other]);
    await inPublisher(publisher(), async (instance, state) => {
      const transaction = vi.spyOn(state.storage, 'transaction');
      try { expect(await instance.resumeRebuild(id, context)).toMatchObject({ status: 'queued' }); }
      finally { expect(transaction).toHaveBeenCalledTimes(1); transaction.mockRestore(); }
      expect(await state.storage.get('jobs')).toEqual([id, other]);
      expect(await state.storage.get(`job:${id}`)).toMatchObject({ status: 'queued' });
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect(events).toContainEqual(expect.objectContaining({ stage: 'rebuild_resume_queue_repair', outcome: 'ok' }));
  });

  it('rolls back queue, job, and alarm together when accepted recovery cannot commit', async () => {
    await seed('failed', [missing, id]);
    const before = await durableSnapshot();
    await inPublisher(publisher(), async (instance, state) => {
      const transaction = state.storage.transaction.bind(state.storage);
      const spy = vi.spyOn(state.storage, 'transaction').mockImplementation((callback: any) => transaction(async storage => {
        await callback(storage);
        throw new Error('private commit failure');
      }));
      try { await expect(instance.resumeRebuild(id, context)).rejects.toMatchObject({ kind: 'storage' }); }
      finally { spy.mockRestore(); }
    });
    expect(await durableSnapshot()).toEqual(before);
    expect(events).toContainEqual(expect.objectContaining({ event: 'rebuild_queue_entry_missing', job_id: missing }));
    expect(events).toContainEqual(expect.objectContaining({ stage: 'rebuild_resume_queue_repair', outcome: 'error' }));
    expect(JSON.stringify(events)).not.toContain('private commit failure');
  });

  it.each(['status', 'enqueue', 'resume', 'alarm'] as const)('does not skip an unreadable effective head during %s', async operation => {
    await seed('failed', [missing, id, other]);
    await inPublisher(publisher(), async (_instance, state) => { await state.storage.put(`job:${other}`, job('queued', other)); });
    const before = await durableSnapshot();
    await inPublisher(publisher(), async (instance, state) => {
      const get = state.storage.get.bind(state.storage) as (key: any) => Promise<any>;
      const spy = vi.spyOn(state.storage, 'get').mockImplementation((key: any) => {
        if (key === `job:${id}`) throw new Error('private head read failure');
        return get(key);
      });
      const transaction = state.storage.transaction.bind(state.storage);
      const transactionSpy = operation === 'enqueue' ? vi.spyOn(state.storage, 'transaction').mockImplementation((callback: any) => transaction(storage => callback(new Proxy(storage, {
        get(target, property) {
          if (property === 'get') return (key: string) => {
            if (key === `job:${id}`) throw new Error('private head read failure');
            return target.get(key);
          };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      })))) : undefined;
      try {
        const action = operation === 'status' ? () => instance.jobStatus(other, context)
          : operation === 'enqueue' ? () => instance.enqueueRebuild(origin, context)
          : operation === 'resume' ? () => instance.resumeRebuild(other, context) : () => instance.alarm();
        await expect(action()).rejects.toMatchObject({ kind: 'storage' });
      } finally { spy.mockRestore(); transactionSpy?.mockRestore(); }
    });
    expect(await durableSnapshot()).toEqual(before);
    expect(events.some(event => event.event === 'rebuild_queue_entry_missing' && event.job_id === id)).toBe(false);
    expect(JSON.stringify(events)).not.toContain('private head read failure');
  });
});

describe('execution failure versus failure-state persistence', () => {
  it('retains attempt logs through explicitly simulated retry exhaustion and then resumes manually', async () => {
    await seed('queued');
    let restore!: () => void;
    await inPublisher(publisher(), async (_instance, state) => {
      const start = vi.spyOn(state.storage, 'put').mockRejectedValue(new Error('private start failure'));
      const record = vi.spyOn(state.storage, 'transaction').mockRejectedValue(new Error('private record failure'));
      restore = () => { start.mockRestore(); record.mockRestore(); };
    });
    try {
      for (let attempt = 0; attempt <= 6; attempt++) {
        // Each helper delivery consumes its alarm; schedule the modeled redelivery explicitly.
        await inPublisher(publisher(), async (_instance, state) => { await state.storage.setAlarm(Date.now() + 1000); });
        await expect(runDurableObjectAlarm(publisher())).rejects.toMatchObject({ kind: 'storage' });
      }
    } finally { restore(); }
    expect(events.filter(event => event.event === 'rebuild_failed')).toHaveLength(7);
    expect(events.filter(event => event.event === 'rebuild_failure_record_failed')).toHaveLength(7);
    expect(events.some(event => event.event === 'rebuild_alarm_failed')).toBe(false);
    expect(await runDurableObjectAlarm(publisher())).toBe(false);
    expect(await publisher().jobStatus(id)).toMatchObject({ status: 'queued' });
    expect((await resume()).status).toBe(202);
    await runDurableObjectAlarm(publisher());
    expect(await publisher().jobStatus(id)).toMatchObject({ status: 'completed' });
    expect(JSON.stringify(events)).not.toMatch(/private start failure|private record failure/);
  });

  it.each(['rebuild_start', 'source_loading', 'rebuild_finalize'] as const)('logs both failures and recovers after %s plus failed state persistence', async stage => {
    await seed('queued', [id], true);
    const manifest = 'publications/private-damaged.json';
    if (stage === 'source_loading') {
      await bindings.SITE_BUCKET.put(manifest, 'private malformed manifest');
      await bindings.SITE_BUCKET.put('pages/index.html', 'old homepage', { customMetadata: { manifest } });
    }
    let restore!: () => void;
    await inPublisher(publisher(), async (_instance, state) => {
      const transaction = state.storage.transaction.bind(state.storage);
      let calls = 0;
      const persistenceCall = stage === 'rebuild_start' ? 1 : stage === 'source_loading' ? 2 : 3;
      const transactionSpy = vi.spyOn(state.storage, 'transaction').mockImplementation((callback: any) => {
        calls++;
        if (calls === persistenceCall || (stage === 'rebuild_finalize' && calls === 2)) throw new Error('private transaction error');
        return transaction(callback);
      });
      const putSpy = stage === 'rebuild_start' ? vi.spyOn(state.storage, 'put').mockRejectedValue(new Error('private start error')) : undefined;
      restore = () => { transactionSpy.mockRestore(); putSpy?.mockRestore(); };
    });
    try { await expect(runDurableObjectAlarm(publisher())).rejects.toMatchObject({ kind: 'storage' }); }
    finally { restore(); }
    const certainty = stage === 'rebuild_finalize' ? 'committed' : 'not_committed';
    const originalCode = stage === 'source_loading' ? 'manifest_damaged' : 'storage_error';
    expect(events).toContainEqual(expect.objectContaining({ event: 'rebuild_failed', job_id: id, request_id: context.request_id, stage, error_code: originalCode, publication_status: certainty }));
    expect(events).toContainEqual(expect.objectContaining({ event: 'rebuild_failure_record_failed', job_id: id, request_id: context.request_id,
      worker_version: expect.any(String), environment: expect.any(String), stage: 'rebuild_failure_record', error_code: 'storage_error', failure_kind: 'storage',
      original_failed_stage: stage, original_error_code: originalCode, publication_status: certainty }));
    expect(events).toContainEqual(expect.objectContaining({ stage: 'rebuild_failure_record', outcome: 'error' }));
    expect(events.some(event => event.event === 'rebuild_alarm_failed')).toBe(false);
    expect(await publisher().jobStatus(id)).toMatchObject({ status: stage === 'rebuild_start' ? 'queued' : 'running' });
    expect(await runDurableObjectAlarm(publisher())).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/private transaction error|private start error|private malformed manifest/);
    if (stage === 'source_loading') {
      // Explicitly simulate platform redelivery: the helper does not schedule retries.
      await inPublisher(publisher(), async (_instance, state) => { await state.storage.setAlarm(Date.now() + 1000); });
      await runDurableObjectAlarm(publisher());
      expect(await publisher().jobStatus(id)).toMatchObject({ status: 'failed', error_code: 'manifest_damaged' });
      await bindings.SITE_BUCKET.put(manifest, JSON.stringify({ version: 1, posts: [], snapshot_date: null, published_at: null }));
    }
    expect((await resume()).status).toBe(202);
    await runDurableObjectAlarm(publisher());
    expect(await publisher().jobStatus(id)).toMatchObject({ status: 'completed' });
  });
});

describe('maintenance methods, manifest damage, and upload admission', () => {
  it.each(['/api/rebuild', `/api/rebuild/${id}`, `/api/rebuild/${id}/resume`])('checks authentication and methods before configuration/lookup on %s', async path => {
    const lookup = vi.fn(() => { throw new Error('should not run'); });
    const overrides = { SITE_ORIGIN: 'invalid', PUBLISHER: { getByName: lookup } as unknown as Env['PUBLISHER'] };
    expect((await request(path, { method: 'DELETE' }, overrides)).status).toBe(401);
    const response = await request(path, { method: 'DELETE', headers }, overrides);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe(path.endsWith(id) ? 'GET' : 'POST');
    expect(lookup).not.toHaveBeenCalled();
    expect(events.some(event => ['publisher_lookup', 'configuration'].includes(event.stage))).toBe(false);
  });
  it.each(['missing', 'invalid_json', 'invalid_manifest'] as const)('classifies %s committed manifests and retains identifying logs without contents', async reason => {
    await submit();
    const before = await bindings.SITE_BUCKET.get('pages/index.html');
    const html = await before!.text();
    const key = before!.customMetadata!.manifest;
    const source = await (await bindings.SITE_BUCKET.get(key))!.text();
    if (reason === 'missing') await bindings.SITE_BUCKET.delete(key);
    else await bindings.SITE_BUCKET.put(key, reason === 'invalid_json' ? '{"private-manifest-value":' : '{"version":1,"posts":"private-manifest-value"}');
    const response = await submit();
    expect(response.status).toBe(500);
    expect(response.headers.get('X-API-Version')).toBe('2');
    const reply = await response.json<any>();
    expect(reply).toMatchObject({ code: 'manifest_damaged', retryable: false, publication_status: 'not_committed' });
    expect(JSON.stringify(reply)).not.toContain(key);
    expect(events).toContainEqual(expect.objectContaining({ event: 'publish_failed', request_id: reply.request_id, error_code: 'manifest_damaged', manifest_key: key, reason }));
    const queued = await (await request('/api/rebuild', { method: 'POST', headers })).json<any>();
    await runDurableObjectAlarm(publisher());
    expect(await publisher().jobStatus(queued.job.id)).toMatchObject({ status: 'failed', error_code: 'manifest_damaged' });
    expect(events).toContainEqual(expect.objectContaining({ event: 'rebuild_failed', job_id: queued.job.id, manifest_key: key, reason, publication_status: 'not_committed' }));
    const after = await bindings.SITE_BUCKET.get('pages/index.html');
    expect(after!.etag).toBe(before!.etag); expect(await after!.text()).toBe(html);
    expect((await bindings.SITE_BUCKET.list({ prefix: 'posts/' })).objects).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/private-manifest-value|Private title|Private source|Private headline|Private body/);
    await bindings.SITE_BUCKET.put(key, source);
    expect((await resume(queued.job.id)).status).toBe(202);
    await runDurableObjectAlarm(publisher());
    expect(await publisher().jobStatus(queued.job.id)).toMatchObject({ status: 'completed' });
  });
  it.each([null, [], {}, { version: 2, posts: [] }, { version: 1, posts: [null], snapshot_date: null, published_at: null }, { version: 1, posts: [], omitted_posts: {}, snapshot_date: null, published_at: null }, { version: 1, posts: [], snapshot_date: '2026-02-30', published_at: null }])('rejects invalid manifest structure %j', async value => {
    await bindings.SITE_BUCKET.put('publications/invalid.json', JSON.stringify(value));
    await bindings.SITE_BUCKET.put('pages/index.html', 'private page', { customMetadata: { manifest: 'publications/invalid.json' } });
    await expect(currentPublication(bindings.SITE_BUCKET)).rejects.toMatchObject({ code: 'manifest_damaged', reason: 'invalid_manifest' });
  });
  it('accepts older valid version-1 manifests without omitted_posts and ignores extra fields', async () => {
    const value: Publication = { version: 1, posts: [], snapshot_date: null, published_at: null };
    await bindings.SITE_BUCKET.put('publications/valid.json', JSON.stringify({ ...value, future_field: true }));
    await bindings.SITE_BUCKET.put('pages/index.html', 'page', { customMetadata: { manifest: 'publications/valid.json' } });
    expect(await currentPublication(bindings.SITE_BUCKET)).toMatchObject(value);
  });
  it('logs busy admission without consuming the body or claiming slot occupancy', async () => {
    let release!: () => void; let ready!: () => void; let count = 0;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { ready = resolve; });
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), char => char.charCodeAt(0));
    const upload = () => {
      const form = new FormData(); form.append('file', new File([png], 'image.png', { type: 'image/png' }));
      return request('/api/images', { method: 'POST', headers: { Authorization: headers.Authorization }, body: form }, { SITE_BUCKET: { put: async () => { if (++count === 2) ready(); await blocked; } } as unknown as R2Bucket });
    };
    const pending = [upload(), upload()];
    try {
      await started;
      let consumed = false;
      const body = new ReadableStream({ pull() { consumed = true; throw new Error('private unread body'); } }, { highWaterMark: 0 });
      const response = await request('/api/images', { method: 'POST', headers: { Authorization: headers.Authorization }, body });
      expect(response.status).toBe(503); expect(response.headers.get('Retry-After')).toBe('1');
      const reply = await response.json<any>();
      expect(reply).toMatchObject({ code: 'uploads_busy', retryable: true, diagnostics: { stage: 'upload_admission', bytes_received: 0, body_complete: false } });
      expect(consumed).toBe(false);
      const correlated = events.filter(event => event.request_id === reply.request_id);
      expect(correlated).toContainEqual(expect.objectContaining({ event: 'operation_stage', stage: 'upload_admission', outcome: 'error' }));
      expect(correlated.some(event => event.stage === 'upload_slot_held')).toBe(false);
      expect(correlated).toContainEqual(expect.objectContaining({ event: 'request_completed', error_code: 'uploads_busy' }));
    } finally { release(); await Promise.all(pending); }
  });
});
