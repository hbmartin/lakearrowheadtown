import assert from 'node:assert/strict';
import test from 'node:test';
import { maintenance, repairAndFollow } from '../scripts/maintenance.mjs';
const id = '00000000-0000-0000-0000-000000000001';
const secret = 'a'.repeat(64);
const publication = { version: 'version-one', manifest: `publications/${id}.json`, rss: `publications/${id}.rss.xml`, archives: null };
const payload = { expected_version: publication.version, manifest: publication.manifest, rss: publication.rss, archives: null };
const options = { secret, origin: 'http://localhost:8787' };

test('snapshot uses authenticated GET and repair submits the reviewed JSON without altering its expected version', async () => {
  for (const operation of ['snapshot', 'repair']) {
    const result = await maintenance(operation, 'preview', undefined, { ...options, payload: operation === 'repair' ? payload : undefined,
      request: async (url, init) => {
        assert.equal(url, 'http://localhost:8787/api/publication/repair');
        assert.equal(init.method, operation === 'snapshot' ? 'GET' : 'POST');
        assert.equal(init.headers.Authorization, `Bearer ${secret}`);
        if (operation === 'repair') { assert.equal(init.headers['Content-Type'], 'application/json'); assert.deepEqual(JSON.parse(init.body), payload); }
        return Response.json({ ok: true, publication, unchanged: operation === 'snapshot' });
      } });
    assert.deepEqual(result.publication, publication);
  }
});

test('repair refuses unsafe destinations, credentials, and invalid payloads before making requests', async () => {
  let calls = 0;
  for (const patch of [{ origin: 'https://evil.example' }, { secret: 'short' }, { payload: { ...payload, rss: 'private/anything' } }]) {
    await assert.rejects(maintenance('repair', 'preview', undefined, { ...options, payload, ...patch, request: async () => { calls++; } }));
  }
  assert.equal(calls, 0);
});

test('repair follows persisted rebuild retry timing to completion without a resume call', async () => {
  const calls = []; const waits = []; const progress = [];
  const result = await repairAndFollow('preview', undefined, { ...options, payload, sleep: async ms => { waits.push(ms); }, onProgress: value => progress.push(value.job?.status),
    request: async (url, init) => {
      calls.push({ url, method: init.method });
      if (calls.length === 1) return Response.json({ publication, unchanged: false, job: { id, status: 'queued' } });
      return Response.json({ job: { id, status: calls.length === 2 ? 'running' : 'completed', ...(calls.length === 2 ? { next_retry_at: new Date(Date.now() + 5000).toISOString() } : {}) } });
    } });
  assert.equal(result.job.status, 'completed'); assert.deepEqual(progress, ['queued', 'running', 'completed']);
  assert.equal(calls[0].method, 'POST'); assert(calls.slice(1).every(call => call.method === 'GET' && call.url.endsWith(`/api/rebuild/${id}`)));
  assert.equal(waits[0], 1000); assert(waits[1] >= 4000 && waits[1] <= 5000);
});

test('repair retries pending reconciliation with the identical payload and a retry delay', async () => {
  const bodies = []; const waits = [];
  const result = await repairAndFollow('preview', undefined, { ...options, payload, sleep: async ms => waits.push(ms),
    request: async (_url, init) => {
      bodies.push(init.body);
      return bodies.length === 1 ? Response.json({ code: 'repair_pending', retryable: true, error: 'Reconciling', retry_at: new Date(Date.now() + 1000).toISOString() }, { status: 503 })
        : Response.json({ publication, unchanged: true });
    } });
  assert.equal(result.unchanged, true); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]); assert.equal(waits[0], 1000);
});

test('stale-version repairs fail without silently refreshing their reviewed version', async () => {
  let calls = 0;
  await assert.rejects(repairAndFollow('preview', undefined, { ...options, payload, request: async () => { calls++; return Response.json({ code: 'publication_changed', error: 'Read current version' }, { status: 409 }); } }), /409/);
  assert.equal(calls, 1);
});

test('a failed or blocked rebuild is reported rather than automatically resumed', async () => {
  for (const job of [{ id, status: 'failed' }, { id, status: 'queued', blocked_by: id }]) {
    await assert.rejects(repairAndFollow('preview', undefined, { ...options, payload, request: async () => Response.json({ publication, unchanged: false, job }) }), /failed or is blocked/);
  }
});

test('the overall deadline bounds stalled polling and retains the committed job identity', async () => {
  let clock = 0; let calls = 0;
  await assert.rejects(repairAndFollow('preview', undefined, { ...options, payload, timeoutMs: 2500, now: () => clock,
    sleep: async ms => { clock += ms; }, request: async (_url, init) => {
      calls++; assert(init.signal); assert(clock < 2500);
      return init.method === 'POST' ? Response.json({ publication, job: { id, status: 'queued' } }) : Response.json({ job: { id, status: 'queued' } });
    } }), error => error.message.includes(`Repair committed; rebuild ${id}`) && error.message.includes('timeout'));
  assert.equal(clock, 2500); assert(calls >= 2);
});

test('the same deadline bounds submission transport uncertainty without changing the payload', async () => {
  let clock = 0; const bodies = [];
  await assert.rejects(repairAndFollow('preview', undefined, { ...options, payload, timeoutMs: 2500, now: () => clock,
    sleep: async ms => { clock += ms; }, request: async (_url, init) => { bodies.push(init.body); throw new TypeError('network failure'); } }), /outcome may be unknown.*timeout/);
  assert.equal(clock, 2500); assert.equal(bodies.length, 2); assert.equal(new Set(bodies).size, 1);
});

test('a committed pending response is reconciled by identical POST and follows the recovered job', async () => {
  const bodies = []; const progress = [];
  const result = await repairAndFollow('preview', undefined, { ...options, payload, sleep: async () => {}, onProgress: value => progress.push(value),
    request: async (_url, init) => {
      bodies.push(init.body);
      return bodies.length === 1 ? Response.json({ code: 'repair_pending', retryable: true, publication_status: 'committed', details: { job_id: id, repair_id: id } }, { status: 503 })
        : Response.json({ publication, unchanged: true, job: { id, status: 'completed' } });
    } });
  assert.equal(result.job.id, id); assert.equal(bodies[0], bodies[1]); assert.equal(progress[0].publication_status, 'committed');
});

test('transient status errors retry while permanent status errors retain committed context', async () => {
  let calls = 0; const progress = [];
  const result = await repairAndFollow('preview', undefined, { ...options, payload, sleep: async () => {}, onProgress: value => progress.push(value),
    request: async () => {
      calls++;
      if (calls === 1) return Response.json({ publication, job: { id, status: 'queued' } });
      if (calls === 2) throw new TypeError('temporary network error');
      return Response.json({ job: { id, status: 'completed' } });
    } });
  assert.equal(result.job.status, 'completed'); assert.equal(progress[1].job_id, id);
  calls = 0;
  await assert.rejects(repairAndFollow('preview', undefined, { ...options, payload, sleep: async () => {}, request: async () => ++calls === 1
    ? Response.json({ publication, job: { id, status: 'queued' } }) : Response.json({ error: 'Job unavailable' }, { status: 404 }) }),
    error => error.message.includes(`Repair committed; rebuild ${id}`) && error.message.includes('404'));
});

test('repairAndFollow refuses invalid configuration before sleeping or retrying', async () => {
  let calls = 0; let waits = 0;
  for (const patch of [{ origin: 'https://evil.example' }, { secret: 'short' }, { payload: { ...payload, rss: 'private/anything' } }]) {
    await assert.rejects(repairAndFollow('preview', undefined, { ...options, payload, ...patch, sleep: async () => { waits++; }, request: async () => { calls++; } }));
  }
  assert.equal(calls, 0); assert.equal(waits, 0);
});
