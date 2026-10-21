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

test('repair retries a transient commit conflict with the identical payload and a retry delay', async () => {
  const bodies = []; const waits = [];
  const result = await repairAndFollow('preview', undefined, { ...options, payload, sleep: async ms => waits.push(ms),
    request: async (_url, init) => {
      bodies.push(init.body);
      return bodies.length === 1 ? Response.json({ code: 'publication_conflict', error: 'Changed', retry_at: new Date(Date.now() + 1000).toISOString() }, { status: 503 })
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
