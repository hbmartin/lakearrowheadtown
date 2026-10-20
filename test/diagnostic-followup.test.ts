import { env } from 'cloudflare:workers';
import { reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { currentPublication } from '../src/publishing';
import type { Digest, Env, OperationContext, RebuildJob } from '../src/types';

const bindings = env as unknown as Env;
const inPublisher = runInDurableObject as unknown as <T>(stub: unknown, callback: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
const origin = 'https://lakearrowhead.town';
const secret = 'test-secret-at-least-thirty-two-characters-long';
const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
const context: OperationContext = { request_id: 'followup-request', worker_version: 'test-release', environment: 'preview', operation: 'rebuild' };
const id = '00000000-0000-0000-0000-000000000001';
const headId = '00000000-0000-0000-0000-000000000002';
const digest = (): Digest => ({ title: 'Batch', source: 'preview', items: [{ group: 'Group', group_url: 'https://example.com/', headline: 'Story', body: 'Private story body', post_url: 'https://example.com/story', category: '', posted_at: new Date().toISOString() }] });
const request = (path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) => worker.fetch(new Request(origin + path, init), { ...bindings, CF_VERSION_METADATA: { id: 'test-release' }, ENVIRONMENT: 'preview', ...overrides });
const submit = (overrides: Partial<Env> = {}) => request('/api/digests', { method: 'POST', headers, body: JSON.stringify(digest()) }, overrides);
let events: any[];
beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  events = [];
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(value => { events.push(value); });
});

describe('API v2 configuration and transport classification', () => {
  const routes = [
    { path: '/api/digests', method: 'POST' }, { path: '/api/rebuild', method: 'POST' },
    { path: `/api/rebuild/${id}`, method: 'GET' }, { path: `/api/rebuild/${id}/resume`, method: 'POST' },
  ];
  it.each(routes)('rejects unusable publisher bindings before invocation on $path', async ({ path, method }) => {
    for (const PUBLISHER of [undefined, {}, { getByName: 1 }, { getByName: () => null }]) {
      const response = await request(path, { method, headers, ...(path.endsWith('digests') ? { body: JSON.stringify(digest()) } : {}) }, { PUBLISHER: PUBLISHER as unknown as Env['PUBLISHER'] });
      expect(response.status).toBe(503);
      expect(response.headers.get('X-API-Version')).toBe('3');
      const result = await response.json<any>();
      expect(result).toMatchObject({ code: 'configuration_error', retryable: false, diagnostics: { stage: 'publisher_lookup' } });
      if (path.endsWith('digests')) expect(result.publication_status).toBe('not_attempted');
    }
  });
  it.each(routes)('classifies lookup exceptions consistently on $path', async ({ path, method }) => {
    const PUBLISHER = { getByName: () => { throw new Error('private lookup detail'); } } as unknown as Env['PUBLISHER'];
    const response = await request(path, { method, headers, ...(path.endsWith('digests') ? { body: JSON.stringify(digest()) } : {}) }, { PUBLISHER });
    expect(response.status).toBe(503);
    const result = await response.json<any>();
    expect(result).toMatchObject({ code: 'service_unavailable', retryable: true, diagnostics: { stage: 'publisher_lookup' } });
    if (path.endsWith('digests')) expect(result.publication_status).toBe('not_attempted');
    expect(JSON.stringify(events)).not.toContain('private lookup detail');
  });
  it.each(['/api/digests', '/api/rebuild'])('attributes invalid site origins to configuration on %s', async path => {
    const lookup = vi.fn();
    const response = await request(path, { method: 'POST', headers, ...(path.endsWith('digests') ? { body: JSON.stringify(digest()) } : {}) }, { SITE_ORIGIN: 'https://example.com/private-path', PUBLISHER: { getByName: lookup } as unknown as Env['PUBLISHER'] });
    expect(response.status).toBe(503);
    const result = await response.json<any>();
    expect(result).toMatchObject({ code: 'configuration_error', retryable: false, diagnostics: { stage: 'configuration' } });
    expect(lookup).not.toHaveBeenCalled();
    if (path.endsWith('digests')) expect(result.publication_status).toBe('not_attempted');
  });
});

describe('rebuild storage diagnostics', () => {
  it.each([
    ['enqueue_state', 'enqueueRebuild', 'rebuild_enqueue_state'], ['enqueue_write', 'enqueueRebuild', 'rebuild_enqueue'],
    ['status_job', 'jobStatus', 'rebuild_status_read'], ['status_queue', 'jobStatus', 'rebuild_status_read'], ['status_head', 'jobStatus', 'rebuild_status_read'],
    ['resume_read', 'resumeRebuild', 'rebuild_resume_read'], ['resume_write', 'resumeRebuild', 'rebuild_resume_write'],
  ])('classifies and correlates %s failures', async (fault, operation, stage) => {
    const publisher = bindings.PUBLISHER.getByName('site');
    await inPublisher(publisher, async (instance, state) => {
      const job: RebuildJob = { id, origin, status: 'failed', phase: 'render', processed: 0, created_at: new Date().toISOString() };
      const head = { ...job, id: headId };
      const ids = operation === 'resumeRebuild' ? [id, headId] : [headId, id];
      await state.storage.put({ [`job:${id}`]: job, [`job:${headId}`]: head, jobs: ids });
      const get = state.storage.get.bind(state.storage) as (key: any) => Promise<any>;
      const getSpy = vi.spyOn(state.storage, 'get').mockImplementation(async (key: any) => {
        if ((fault === 'enqueue_state' && key === 'migration') || (fault === 'status_job' && key === `job:${id}`)
          || (fault === 'status_queue' && key === 'jobs') || (fault === 'status_head' && key === `job:${headId}`)
          || (fault === 'resume_read' && key === `job:${id}`)) throw new Error('private storage detail');
        return get(key);
      });
      const transactionSpy = fault.endsWith('write') ? vi.spyOn(state.storage, 'transaction').mockRejectedValue(new Error('private transaction detail')) : undefined;
      try {
        const args = operation === 'enqueueRebuild' ? [origin, context] : [id, context];
        await expect(instance[operation](...args)).rejects.toMatchObject({ kind: 'storage' });
      } finally { getSpy.mockRestore(); transactionSpy?.mockRestore(); }
      expect(await state.storage.get(`job:${id}`)).toEqual(job);
      expect(await state.storage.get('jobs')).toEqual(ids);
    });
    const failure = events.find(event => event.event === 'rebuild_request_failed');
    expect(failure).toMatchObject({ request_id: context.request_id, stage, error_code: 'storage_error', failure_kind: 'storage' });
    expect(operation === 'enqueueRebuild' ? failure.candidate_job_id : failure.job_id).toBeTruthy();
    expect(failure.publication_status).toBeUndefined();
    if (operation === 'enqueueRebuild') expect(failure.job_id).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({ event: 'operation_stage', stage, outcome: 'error' }));
    expect(JSON.stringify(events)).not.toMatch(/private storage detail|private transaction detail/);
  });
  it.each(['jobs', `job:${id}`])('keeps state after a scheduled %s read failure and completes on simulated redelivery', async failedKey => {
    const publisher = bindings.PUBLISHER.getByName('site');
    const job: RebuildJob = { id, origin, status: 'queued', phase: 'render', processed: 0, created_at: new Date().toISOString(), context };
    let restore!: () => void;
    await inPublisher(publisher, async (_instance, state) => {
      await state.storage.put({ jobs: [id], [`job:${id}`]: job, migration: { complete: true, processed: 0 } });
      await state.storage.setAlarm(Date.now() + 1000);
      const get = state.storage.get.bind(state.storage) as (key: any) => Promise<any>;
      const spy = vi.spyOn(state.storage, 'get').mockImplementation(async (key: any) => {
        if (key === failedKey) throw new Error('private bootstrap detail');
        return get(key);
      });
      restore = () => spy.mockRestore();
    });
    try { await expect(runDurableObjectAlarm(publisher)).rejects.toMatchObject({ kind: 'storage' }); }
    finally { restore(); }
    await inPublisher(publisher, async (_instance, state) => {
      expect(await state.storage.get('jobs')).toEqual([id]);
      expect(await state.storage.get(`job:${id}`)).toEqual(job);
      // The helper consumed the scheduled alarm. It does not model platform retries.
      expect(await state.storage.getAlarm()).toBeNull();
      expect(await bindings.SITE_BUCKET.head('pages/index.html')).toBeNull();
      // Explicitly simulate the platform scheduling another delivery.
      await state.storage.setAlarm(Date.now() + 1000);
    });
    const failed = events.find(event => event.event === 'rebuild_alarm_failed');
    expect(failed).toMatchObject({ error_code: 'storage_error', stage: failedKey === 'jobs' ? 'rebuild_queue_read' : 'rebuild_job_read', operation: 'rebuild' });
    expect(failed.publication_status).toBeUndefined();
    expect(failed.request_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(failed.worker_version).toBeTruthy();
    expect(failed.environment).toBeTruthy();
    expect(failed).not.toHaveProperty('job_id');
    if (failedKey !== 'jobs') expect(events).toContainEqual(expect.objectContaining({ event: 'operation_stage', stage: 'rebuild_job_read', queue_entry_id: id, outcome: 'error' }));
    expect(await runDurableObjectAlarm(publisher)).toBe(true);
    expect(await publisher.jobStatus(id)).toMatchObject({ status: 'completed' });
    expect(events).toContainEqual(expect.objectContaining({ event: 'rebuild_completed', job_id: id, request_id: context.request_id }));
    expect(JSON.stringify(events)).not.toContain('private bootstrap detail');
  });
  it('passes the status request context into publisher logging', async () => {
    const response = await request(`/api/rebuild/${id}`, { headers });
    const result = await response.json<any>();
    expect(response.status).toBe(404);
    expect(events).toContainEqual(expect.objectContaining({ event: 'operation_stage', stage: 'rebuild_status_read', request_id: result.request_id, job_id: id }));
  });
  it('returns a service error over real RPC while logging the originating storage failure', async () => {
    const publisher = bindings.PUBLISHER.getByName('site');
    let restore!: () => void;
    await inPublisher(publisher, async (_instance, state) => {
      const spy = vi.spyOn(state.storage, 'get').mockRejectedValue(new Error('private storage RPC detail'));
      restore = () => spy.mockRestore();
    });
    let response: Response;
    try { response = await request(`/api/rebuild/${id}`, { headers }); }
    finally { restore(); }
    expect(response.status).toBe(503);
    const result = await response.json<any>();
    expect(result).toMatchObject({ code: 'service_unavailable', retryable: true, diagnostics: { stage: 'rebuild_status' } });
    expect(events).toContainEqual(expect.objectContaining({ event: 'rebuild_request_failed', error_code: 'storage_error', stage: 'rebuild_status_read', job_id: id, request_id: result.request_id }));
    expect(JSON.stringify(events)).not.toContain('private storage RPC detail');
  });
  it.each(['missing', 'invalid_json', 'invalid_digest'] as const)('identifies a %s source without logging its contents and resumes after restoration', async reason => {
    await submit();
    const ref = (await currentPublication(bindings.SITE_BUCKET)).posts[0];
    const source = await (await bindings.SITE_BUCKET.get(ref.key))!.text();
    if (reason === 'missing') await bindings.SITE_BUCKET.delete(ref.key);
    else await bindings.SITE_BUCKET.put(ref.key, reason === 'invalid_json' ? '{"private-source-value":' : '{"items":"private-source-value"}');
    const queued = await (await request('/api/rebuild', { method: 'POST', headers })).json<any>();
    const before = await bindings.SITE_BUCKET.head('pages/index.html');
    const publisher = bindings.PUBLISHER.getByName('site');
    await runDurableObjectAlarm(publisher);
    expect(await publisher.jobStatus(queued.job.id)).toMatchObject({ status: 'failed', error_code: 'source_damaged', failed_stage: 'source_loading' });
    expect(events).toContainEqual(expect.objectContaining({ event: 'rebuild_failed', job_id: queued.job.id, request_id: queued.request_id, error_code: 'source_damaged', source_key: ref.key, post_id: ref.id, reason }));
    expect((await bindings.SITE_BUCKET.head('pages/index.html'))?.etag).toBe(before?.etag);
    expect(JSON.stringify(events)).not.toMatch(/private-source-value|Private story body/);
    await bindings.SITE_BUCKET.put(ref.key, source);
    await publisher.resumeRebuild(queued.job.id, context);
    await runDurableObjectAlarm(publisher);
    expect(await publisher.jobStatus(queued.job.id)).toMatchObject({ status: 'completed' });
  });
});

describe('parser locations and timing semantics', () => {
  it.each(['\r', '\n', '\r\n'])('reports syntax locations with %j line endings', async newline => {
    const body = `{${newline}"a":1,${newline}}`;
    const response = await request('/api/digests', { method: 'POST', headers, body });
    expect(await response.json()).toMatchObject({ code: 'invalid_json', details: { position: body.length - 1, line: 3, column: 1, position_unit: 'utf16_code_units' } });
  });
  it('handles mixed line endings and unexpected strings', async () => {
    for (const [body, line, column, position] of [['{\r\n"a":1,\r"b":2,\n}', 4, 1, 17], ['tru"x"', 1, 4, 3]] as const) {
      const response = await request('/api/digests', { method: 'POST', headers, body });
      expect(await response.json()).toMatchObject({ code: 'invalid_json', details: { line, column, position } });
    }
  });
  it('does not accept a location suffix embedded in quoted parser input', async () => {
    const response = await request('/api/digests', { method: 'POST', headers, body: 'position 12 at position 12 (line 1 column 13)' });
    expect(await response.json()).toMatchObject({ code: 'invalid_json', details: {} });
  });
  it('retains rejected digest request logs with explicit not-attempted publication status', async () => {
    const rejected = [await request('/api/digests', { method: 'POST' }), await submit({ API_SECRET: '' }), await request('/api/digests', { method: 'PATCH' }), await request('/api/digests', { method: 'POST', headers, body: '{}' })];
    for (const response of rejected) {
      const result = await response.json<any>();
      expect(events).toContainEqual(expect.objectContaining({ event: 'request_completed', request_id: result.request_id, publication_outcome: 'failed', publication_status: 'not_attempted' }));
      expect(events).toContainEqual(expect.objectContaining({ event: 'request_error', request_id: result.request_id }));
    }
  });
  it('logs slot occupancy through storage completion while retaining validation and write stages', async () => {
    let release!: () => void;
    let writing!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { writing = resolve; });
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const form = new FormData(); form.append('file', new File([png], 'image.png', { type: 'image/png' }));
    const pending = request('/api/images', { method: 'POST', headers: { Authorization: headers.Authorization }, body: form }, { SITE_BUCKET: { put: async () => { writing(); await blocked; } } as unknown as R2Bucket });
    await started;
    expect(events.some(event => event.stage === 'upload_slot_held')).toBe(false);
    release();
    const result = await (await pending).json<any>();
    for (const stage of ['upload_slot_held', 'image_validation', 'image_write']) expect(events).toContainEqual(expect.objectContaining({ event: 'operation_stage', stage, outcome: 'ok', request_id: result.request_id }));
  });
});
