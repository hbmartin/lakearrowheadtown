import assert from 'node:assert/strict';
import test from 'node:test';
import { maintenance, repairAndFollow, waitForRebuild } from '../scripts/maintenance.mjs';
import { fakeClock } from './helpers/clock.mjs';
const id = '00000000-0000-0000-0000-000000000001';
const secret = 'a'.repeat(64);
const publication = { version: 'version-one', manifest: `publications/${id}.json`, rss: `publications/${id}.rss.xml`, archives: null };
const payload = { expected_version: publication.version, manifest: publication.manifest, rss: publication.rss, archives: null };
let clock = 0;
const advance = async ms => { clock += ms; };
const options = { secret, origin: 'http://localhost:8787', now: () => clock, sleep: advance };

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
  const result = await repairAndFollow('preview', undefined, { ...options, payload, sleep: async ms => { waits.push(ms); clock += ms; }, onProgress: value => progress.push(value.job?.status),
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
  const result = await repairAndFollow('preview', undefined, { ...options, payload, sleep: async ms => { waits.push(ms); clock += ms; },
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
      calls++; assert(init.signal); assert(clock <= 2500); if (clock === 2500) assert.equal(init.method, 'GET');
      return init.method === 'POST' ? Response.json({ publication, job: { id, status: 'queued' } }) : Response.json({ job: { id, status: 'queued' } });
    } }), error => error.message.includes(`Repair committed; rebuild ${id}`) && error.message.includes('deadline'));
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
  const result = await repairAndFollow('preview', undefined, { ...options, payload, sleep: advance, onProgress: value => progress.push(value),
    request: async (_url, init) => {
      bodies.push(init.body);
      return bodies.length === 1 ? Response.json({ code: 'repair_pending', retryable: true, publication_status: 'committed', details: { job_id: id, repair_id: id } }, { status: 503 })
        : Response.json({ publication, unchanged: true, job: { id, status: 'completed' } });
    } });
  assert.equal(result.job.id, id); assert.equal(bodies[0], bodies[1]); assert.equal(progress[0].publication_status, 'committed');
});

test('transient status errors retry while permanent status errors retain committed context', async () => {
  let calls = 0; const progress = [];
  const result = await repairAndFollow('preview', undefined, { ...options, payload, sleep: advance, onProgress: value => progress.push(value),
    request: async () => {
      calls++;
      if (calls === 1) return Response.json({ publication, job: { id, status: 'queued' } });
      if (calls === 2) throw new TypeError('temporary network error');
      return Response.json({ job: { id, status: 'completed' } });
    } });
  assert.equal(result.job.status, 'completed'); assert.equal(progress[1].job_id, id);
  calls = 0;
  await assert.rejects(repairAndFollow('preview', undefined, { ...options, payload, sleep: advance, request: async () => ++calls === 1
    ? Response.json({ publication, job: { id, status: 'queued' } }) : Response.json({ error: 'Job unavailable' }, { status: 404 }) }),
    error => error.message.includes(`Repair committed; rebuild ${id}`) && error.message.includes('404'));
});

test('permanent polling errors before the deadline retain the direct waiter job and last status', async () => {
  const timing = fakeClock(); let calls = 0;
  await assert.rejects(waitForRebuild({ id, status: 'running' }, 'preview', { ...options, ...timing, timeoutMs: 5000,
    request: async () => { calls++; return Response.json({ error: 'Correct the credential', code: 'unauthorized', retryable: false }, { status: 401 }); } }),
    error => error.status === 401 && error.code === 'unauthorized' && error.message.includes(id)
      && error.message.includes('last status: running') && error.cause?.message.includes('Correct the credential'));
  assert.equal(calls, 1); assert.equal(timing.now(), 1000);
});

test('repairAndFollow refuses invalid configuration before sleeping or retrying', async () => {
  let calls = 0; let waits = 0;
  for (const patch of [{ origin: 'https://evil.example' }, { secret: 'short' }, { payload: { ...payload, rss: 'private/anything' } }]) {
    await assert.rejects(repairAndFollow('preview', undefined, { ...options, payload, ...patch, sleep: async () => { waits++; }, request: async () => { calls++; } }));
  }
  assert.equal(calls, 0); assert.equal(waits, 0);
});

for (const reason of ['manual_resume', 'unscheduled', 'failed_rebuild', 'repair_stalled', 'repair_damaged']) {
  test(`waiting tools stop immediately with guidance for ${reason}`, async () => {
    const job = { id, status: 'running', blocked: { reason, job_id: id, ...(reason.startsWith('repair') ? { repair_id: id } : {}) } };
    let calls = 0; let sleeps = 0;
    const extra = { ...options, sleep: async () => { sleeps++; }, request: async () => { calls++; return Response.json({ publication, unchanged: false, job }); } };
    await assert.rejects(waitForRebuild(job, 'preview', extra), new RegExp(reason));
    assert.equal(calls, 0);
    await assert.rejects(repairAndFollow('preview', undefined, { ...extra, payload }), new RegExp(reason));
    assert.equal(calls, 1); assert.equal(sleeps, 0);
  });
}

test('a pending repair remains observable progress and its retry deadline is honored', async () => {
  let calls = 0; const waits = [];
  const result = await repairAndFollow('preview', undefined, { ...options, payload, sleep: async ms => { waits.push(ms); clock += ms; }, request: async () => {
    calls++; return Response.json(calls === 1 ? { publication, unchanged: false, job: { id, status: 'running', blocked: { reason: 'repair_pending', repair_id: id, retry_at: new Date(Date.now() + 120000).toISOString() } } }
      : { job: { id, status: 'completed' } });
  } });
  assert.equal(result.job.status, 'completed'); assert.equal(waits[0], 30000);
});

for (const skew of [-600000, 600000]) for (const timing of ['date', 'relative', 'missing']) {
  test(`bounds repair waits with ${skew}ms clock skew and ${timing} timing`, async () => {
    const server = Date.parse('2026-10-23T12:00:00Z'); const original = Date.now;
    let clock = 0; let calls = 0; const waits = [];
    Date.now = () => server + skew + clock;
    try {
      const headers = timing === 'missing' ? {} : { Date: new Date(server).toUTCString(), ...(timing === 'relative' ? { 'Retry-After': '3' } : {}) };
      await repairAndFollow('preview', undefined, { ...options, payload, now: () => clock, sleep: async ms => { waits.push(ms); clock += ms; }, request: async () => ++calls === 1
        ? Response.json({ error: 'Pending', retryable: true, retry_at: new Date(server + 5000).toISOString() }, { status: 503, headers })
        : Response.json({ publication, unchanged: true }) });
      assert.equal(waits[0], timing === 'date' ? 5000 : timing === 'relative' ? 3000 : skew < 0 ? 30000 : 1000);
    } finally { Date.now = original; }
  });
}

test('job timing uses server dates and remains private to the waiting tools', async () => {
  const server = Date.parse('2026-10-23T12:00:00Z'); let clock = 0; const waits = [];
  const job = await maintenance('status', 'preview', id, { ...options, now: () => clock, request: async () => Response.json({ job: { id, status: 'running', next_retry_at: new Date(server + 5000).toISOString() } }, { headers: { Date: new Date(server).toUTCString() } }) });
  assert.equal(JSON.stringify(job), JSON.stringify({ id, status: 'running', next_retry_at: new Date(server + 5000).toISOString() }));
  await waitForRebuild(job, 'preview', { ...options, now: () => clock, sleep: async ms => { waits.push(ms); clock += ms; }, request: async () => Response.json({ job: { id, status: 'completed' } }) });
  assert.deepEqual(waits, [5000]);
});

test('waiting tools explain durable checkpoint damage immediately', async () => {
  await assert.rejects(waitForRebuild({ id, status: 'running', blocked: { reason: 'rebuild_checkpoint_damaged' } }, 'preview', options), /verified backup.*explicitly resume/);
});

test('invalid Retry-After falls back to the JSON deadline against server time', async () => {
  const server = Date.parse('2026-10-23T12:00:00Z'); let clock = 0; let calls = 0; const waits = [];
  await repairAndFollow('preview', undefined, { ...options, payload, now: () => clock, sleep: async ms => { waits.push(ms); clock += ms; }, request: async () => ++calls === 1
    ? Response.json({ error: 'Pending', retryable: true, retry_at: new Date(server + 5000).toISOString() }, { status: 503, headers: { Date: new Date(server).toUTCString(), 'Retry-After': 'invalid' } })
    : Response.json({ publication, unchanged: true }) });
  assert.deepEqual(waits, [5000]);
});

test('repair POST honors a trusted two-minute deadline across four bounded sleeps', async () => {
  const timing = fakeClock(); const calls = []; const server = Date.parse('2026-10-23T12:00:00Z');
  await repairAndFollow('preview', undefined, { ...options, payload, ...timing, request: async (_url, init) => {
      calls.push({ at: timing.now(), body: init.body, method: init.method });
      return calls.length === 1 ? Response.json({ code: 'repair_pending', retryable: true, retry_at: new Date(server + 120000).toISOString() },
        { status: 503, headers: { Date: new Date(server).toUTCString(), 'Retry-After': '120' } }) : Response.json({ publication, unchanged: true });
    } });
  assert.deepEqual(timing.waits, [30000, 30000, 30000, 30000]); assert.deepEqual(calls.map(call => call.at), [0, 120000]);
  assert.equal(calls[0].body, calls[1].body);
});

for (const tool of ['wait', 'repair', 'pending-repair']) for (const [status, code] of [[401, 'unauthorized'], [404, 'job_not_found'], [503, 'repair_damaged']]) {
  test(`${tool} preserves permanent ${status} ${code} from the final check`, async () => {
    const timing = fakeClock(); const methods = [];
    const config = { ...options, ...timing, payload, timeoutMs: 1000, request: async (_url, init) => {
      methods.push(init.method);
      if (init.method === 'POST') return tool === 'pending-repair'
        ? Response.json({ code: 'repair_pending', retryable: true, publication_status: 'committed', details: { job_id: id } }, { status: 503 })
        : Response.json({ publication, job: { id, status: 'running' } });
      assert.equal(timing.now(), 1000);
      return Response.json({ error: 'Correct the credential or job identity', code, retryable: false }, { status });
    } };
    await assert.rejects(tool === 'wait' ? waitForRebuild({ id, status: 'running' }, 'preview', config) : repairAndFollow('preview', undefined, config),
      error => tool === 'pending-repair' && status === 404 ? error.message.includes('completion remains unconfirmed') && error.message.includes(id)
        : error.status === status && error.code === code && error.retryable === false && error.message.includes(`${status} ${code}`)
          && error.message.includes(id) && error.message.includes('last status:') && !error.message.includes('completion remains unconfirmed')
          && (tool === 'wait' || error.message.includes(`Repair committed; rebuild ${id}`)));
    assert.deepEqual(methods, tool === 'wait' ? ['GET'] : ['POST', 'GET']);
  });
}

for (const kind of ['retryable', 'malformed', 'late-permanent']) test(`final check retains uncertainty for a ${kind} response`, async () => {
  const timing = fakeClock(); let calls = 0;
  await assert.rejects(waitForRebuild({ id, status: 'running' }, 'preview', { ...options, ...timing, timeoutMs: 1000,
    request: async () => {
      calls++; if (kind === 'late-permanent') { timing.advance(30001); return Response.json({ code: 'job_not_found', retryable: false }, { status: 404 }); }
      return kind === 'retryable' ? Response.json({ code: 'storage_error', error: 'Storage unavailable', retryable: true }, { status: 503 }) : Response.json({ job: {} });
    } }), /completion remains unconfirmed/);
  assert.equal(calls, 1);
});

for (const kind of ['html-403', 'html-429', 'missing-retryable', 'missing-code', 'missing-error', 'nonboolean-retryable', 'array']) {
  test(`a final ${kind} reply cannot establish a permanent application failure`, async () => {
    const timing = fakeClock(); let calls = 0;
    await assert.rejects(waitForRebuild({ id, status: 'running' }, 'preview', { ...options, ...timing, timeoutMs: 1000, request: async () => {
      calls++;
      if (kind.startsWith('html')) return new Response('<html>Edge rejection</html>', { status: Number(kind.slice(-3)) });
      const body = { code: 'unauthorized', error: 'Correct the credential', retryable: false };
      if (kind === 'missing-retryable') delete body.retryable;
      if (kind === 'missing-code') delete body.code;
      if (kind === 'missing-error') delete body.error;
      if (kind === 'nonboolean-retryable') body.retryable = 'false';
      return Response.json(kind === 'array' ? [body] : body, { status: 401 });
    } }), error => error.message.includes('completion remains unconfirmed') && error.message.includes(id) && error.cause?.status >= 400);
    assert.equal(calls, 1);
  });
}

test('fails clearly for a nonadvancing injected clock instead of spinning or making another request', async () => {
  let calls = 0; let sleeps = 0;
  await assert.rejects(waitForRebuild({ id, status: 'running' }, 'preview', { ...options, now: () => 0, sleep: async () => { sleeps++; }, request: async () => { calls++; } }), /sleep must advance.*monotonic clock/);
  assert.equal(calls, 0); assert.equal(sleeps, 1);
});

test('partially advancing sleeps still wait until request eligibility without consuming retry attempts', async () => {
  const timing = fakeClock(); const calls = []; const waits = [];
  await repairAndFollow('preview', undefined, { ...options, ...timing, payload, sleep: async ms => { waits.push(ms); timing.advance(Math.min(ms, 250)); },
    request: async (_url, init) => {
      calls.push({ at: timing.now(), body: init.body }); return calls.length === 1
        ? Response.json({ code: 'repair_pending', retryable: true }, { status: 503, headers: { 'Retry-After': '1.2' } }) : Response.json({ publication, unchanged: true });
    } });
  assert.deepEqual(calls.map(call => call.at), [0, 1200]); assert.equal(calls[0].body, calls[1].body);
  assert.deepEqual(waits, [1200, 950, 700, 450, 200]);
});

for (const tool of ['wait', 'repair']) test(`${tool} observes completion in exactly one final read-only grace check`, async () => {
  let clock = 0; const calls = [];
  const config = { ...options, payload, timeoutMs: 1000, now: () => clock, sleep: async ms => { clock += ms; },
    request: async (_url, init) => { calls.push({ at: clock, method: init.method }); return init.method === 'POST'
      ? Response.json({ publication, job: { id, status: 'queued' } }) : Response.json({ job: { id, status: 'completed' } }); } };
  const result = tool === 'wait' ? await waitForRebuild({ id, status: 'running' }, 'preview', config) : (await repairAndFollow('preview', undefined, config)).job;
  assert.equal(result.status, 'completed'); assert.deepEqual(calls.filter(call => call.at >= 1000), [{ at: 1000, method: 'GET' }]);
});

for (const outcome of ['running', 'failed', 'blocked', 'transport', 'overrun']) test(`final grace check reports ${outcome} without retrying`, async () => {
  let clock = 0; let calls = 0;
  await assert.rejects(waitForRebuild({ id, status: 'running' }, 'preview', { ...options, timeoutMs: 1000, now: () => clock,
    sleep: async ms => { clock += ms; }, request: async (_url, init) => {
      calls++; assert.equal(clock, 1000); assert.equal(init.method, 'GET');
      if (outcome === 'transport') throw new TypeError('offline');
      if (outcome === 'overrun') clock += 30001;
      return Response.json({ job: { id, status: outcome === 'failed' ? 'failed' : outcome === 'overrun' ? 'completed' : 'running',
        ...(outcome === 'blocked' ? { blocked: { reason: 'manual_resume', job_id: id } } : {}) } });
    } }), outcome === 'failed' || outcome === 'blocked' ? /failed or is blocked/ : /completion remains unconfirmed/);
  assert.equal(calls, 1);
});

test('exhausted grace makes no further status request', async () => {
  let clock = 0; let calls = 0;
  await assert.rejects(waitForRebuild({ id, status: 'running' }, 'preview', { ...options, timeoutMs: 1000, now: () => clock,
    sleep: async () => { clock = 31001; }, request: async () => { calls++; } }), /completion remains unconfirmed/);
  assert.equal(calls, 0);
});

test('submission timeout with a committed job performs only a final GET and preserves the unconfirmed repair result', async () => {
  let clock = 0; const methods = [];
  await assert.rejects(repairAndFollow('preview', undefined, { ...options, payload, timeoutMs: 1000, now: () => clock,
    sleep: async ms => { clock += ms; }, request: async (_url, init) => {
      methods.push(init.method);
      return init.method === 'POST' ? Response.json({ code: 'repair_pending', retryable: true, publication_status: 'committed', details: { job_id: id } }, { status: 503 })
        : Response.json({ job: { id, status: 'completed' } });
    } }), /repair result remains unconfirmed.*Final rebuild status: completed/);
  assert.deepEqual(methods, ['POST', 'GET']);
});
