import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness } from 'wrangler';
import { createSmokeContext, withCleanup } from '../scripts/smoke-support.mjs';
import { smoke } from '../scripts/smoke-preview.mjs';
import { smokeChanges } from '../scripts/smoke-changes.mjs';
import { previewCI, validateCandidate, versionForTag } from '../scripts/preview-ci.mjs';
const secret = 'test-secret-at-least-thirty-two-characters-long';
const remote = 'https://lakearrowheadtown-preview.harold-martin.workers.dev';
const version = '00000000-0000-0000-0000-000000000001';
const api = (body = {}, status = 200, workerVersion = version) => Response.json({ ok: true, ...body }, { status, headers: { 'X-Worker-Version': workerVersion } });
test('cleanup preserves original and cleanup failures instead of masking either', async () => {
  const primary = Error('primary'); const secondary = Error('cleanup');
  assert.equal(await withCleanup(async () => 42, async () => {}), 42);
  await assert.rejects(withCleanup(async () => { throw primary; }, async () => {}), error => error === primary);
  await assert.rejects(withCleanup(async () => {}, async () => { throw secondary; }), error => error === secondary);
  await assert.rejects(withCleanup(async () => { throw primary; }, async () => { throw secondary; }), error => { assert.deepEqual(error.errors, [primary, secondary]); return true; });
});
test('version and transport failures retain registered references for cleanup and bounded diagnostics', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'smoke-lifecycle-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let retracted = false;
  const request = async (url, init = {}) => {
    if (url.includes('client_ref=')) return api({ post: { id: 'fixture' }, status: retracted ? 'retracted' : 'published' });
    if (url.endsWith('/retract')) { retracted = true; return api({ status: 'retracted' }); }
    return api({}, 200, 'another-version');
  };
  const context = createSmokeContext(remote, { credential: () => secret, request, expectedVersion: version, artifactsDirectory: directory });
  await assert.rejects(context.run(async () => { context.registerDigest('persisted-reference'); await context.request(remote + '/api/digests', { method: 'POST' }); }), /deployment changed/);
  assert.equal(retracted, true);
  const artifact = await readFile(join(directory, 'smoke.json'), 'utf8'); assert(!artifact.includes(secret)); assert(!artifact.includes('Authorization'));
  for (const failure of [() => { throw Error('private transport payload'); }, async () => { throw Error('private transport payload'); }]) {
    const broken = createSmokeContext(remote, { credential: () => secret, request: failure });
    await assert.rejects(broken.request(remote + '/api/posts'), error => !error.message.includes('private transport payload'));
  }
  await assert.rejects(context.request('https://evil.example/api/posts'), /validated preview origin/);
});
test('cleanup handles absent and already retracted references and rejects malformed or failed lookups', async () => {
  for (const response of [api({}, 404), api({ post: { id: 'fixture' }, status: 'retracted' })]) {
    const context = createSmokeContext(remote, { credential: () => secret, request: async () => response });
    context.registerDigest('test'); await context.run(async () => {});
  }
  for (const response of [api({}, 503), api({}), new Response('malformed')]) {
    const context = createSmokeContext(remote, { credential: () => secret, request: async () => response });
    context.registerDigest('test'); await assert.rejects(context.run(async () => {}), /cleanup failed/);
  }
  const context = createSmokeContext(remote, { credential: () => secret, cleanupTimeoutMs: 0 });
  context.registerDigest('test'); await assert.rejects(context.run(async () => {}), /cleanup failed/);
});
test('preview orchestration pins a reviewed candidate, waits for rebuild and requires every validation stage', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'preview-ci-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const candidate = { state: 'OPEN', isCrossRepository: false, headRefOid: 'head', baseRefOid: 'base' };
  for (const patch of [{ state: 'CLOSED' }, { isCrossRepository: true }, { headRefOid: 'new' }, { baseRefOid: 'new' }]) assert.throws(() => validateCandidate({ ...candidate, ...patch }, { head: 'head', base: 'base' }));
  assert.throws(() => versionForTag([], 'missing')); assert.throws(() => versionForTag({}, 'missing'));
  const calls = []; let tag;
  const options = { sha: 'a'.repeat(40), variables: { CANDIDATE_PR: '42', CANDIDATE_HEAD_SHA: 'head', CANDIDATE_BASE_SHA: 'base', GITHUB_RUN_ID: '1' }, artifactsDirectory: directory,
    credential: () => secret, config: { vars: { ALERT_CONFIRMATIONS_ENABLED: 'false' } },
    command: async args => args[0] === 'gh' ? JSON.stringify(candidate) : JSON.stringify([{ id: version, annotations: { 'workers/tag': tag } }]),
    deploy: async (environment, options) => { assert.equal(environment, 'preview'); tag = options.tag; calls.push('deploy'); return { id: 'job' }; },
    wait: async (_job, _env, options) => { assert.equal(options.timeoutMs, 300000); calls.push('wait'); },
    smoke: async (_args, options) => { assert.equal(options.expectedVersion, version); assert.equal(options.expectedConfirmations, false); calls.push('smoke'); },
    thumbnails: async () => { calls.push('thumbnails'); }, request: async () => api() };
  assert.equal((await previewCI(options)).status, 'passed'); assert.deepEqual(calls, ['deploy', 'wait', 'smoke', 'thumbnails']);
  for (const stage of ['deploy', 'wait', 'smoke', 'thumbnails']) {
    await assert.rejects(previewCI({ ...options, [stage]: async () => { throw Error('injected failure'); } }));
    assert.equal(JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')).status, 'failed');
  }
  await assert.rejects(previewCI({ ...options, credential: () => 'short' }), /Publishing credential/);
  await assert.rejects(previewCI({ variables: { GITHUB_ACTIONS: 'true' } }), /Missing CI configuration/);
});
test('the full smoke and daily calendar reuse succeed twice over a built local Worker and clean their stories', { timeout: 60000 }, async t => {
  const server = createTestHarness({ workers: [{ configPath: './wrangler.jsonc', env: 'preview', vars: { SITE_ORIGIN: '', ALERT_CONFIRMATIONS_ENABLED: 'false' }, secrets: { API_SECRET: secret } }] });
  t.after(() => server.close()); const { url } = await server.listen();
  const origin = url.origin.replace('127.0.0.1', 'localhost'); const headers = { Authorization: `Bearer ${secret}` };
  const options = { credential: () => secret, expectedConfirmations: false, log: () => {} };
  for (let i = 0; i < 2; i++) {
    await smoke([origin], options);
    const news = await (await fetch(origin + '/api/posts', { headers })).json(); assert.equal(news.posts.length, 0);
    const calendar = await (await fetch(origin + '/api/events', { headers })).json(); assert.equal(calendar.events.length, 1);
  }
  // Losing the first publishing response still leaves cleanup able to recover the reference.
  let lost = false;
  await assert.rejects(smokeChanges(origin, async (url, init) => {
    const response = await fetch(url, init);
    if (!lost && new URL(url).pathname === '/api/digests' && init?.method === 'POST') { lost = true; throw Error('lost acknowledgement'); }
    return response;
  }, headers, options));
  assert.equal(lost, true); assert.equal((await (await fetch(origin + '/api/posts', { headers })).json()).posts.length, 0);
});
test('conditional HTML verification retries only an intervening publication and fails broken stable validators', async () => {
  const { verifyHtmlRevalidation } = await import('../scripts/smoke-support.mjs');
  const headers = tag => ({ ETag: tag, 'Cache-Control': 'public, max-age=0, must-revalidate, no-transform', 'Content-Encoding': 'gzip' });
  let calls = 0;
  await verifyHtmlRevalidation(remote, async (_url, init = {}) => {
    calls++;
    const tag = calls === 1 ? 'W/"first"' : 'W/"next"';
    return new Response(null, { status: init.headers?.['If-None-Match'] === tag ? 304 : 200, headers: headers(tag) });
  }, true);
  assert.equal(calls, 7);
  await assert.rejects(verifyHtmlRevalidation(remote, async () => new Response(null, { headers: headers('W/"stable"') })), /must return 304/);
  let sequence = 0;
  await assert.rejects(verifyHtmlRevalidation(remote, async () => new Response(null, { headers: headers(`W/"${sequence++}"`) })), /three attempts/);
});
test('diagnostics cap stored requests and injected timeouts abort pending transport', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bounded-smoke-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = new Date('2026-10-24T18:00:00Z');
  const context = createSmokeContext(remote, { credential: () => secret, request: async () => api(), now: () => clock, artifactsDirectory: directory });
  assert.equal(context.now(), clock);
  await context.run(async () => { for (let i = 0; i < 503; i++) await context.request(remote + '/api/posts'); });
  const saved = JSON.parse(await readFile(join(directory, 'smoke.json'), 'utf8'));
  assert.equal(saved.events.length, 500); assert.equal(saved.events_dropped, 3);
  let aborted = false;
  const hanging = createSmokeContext(remote, { credential: () => secret, requestTimeoutMs: 1,
    request: async (_url, { signal }) => new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Unexpected timer expiry')), 1000);
      signal.addEventListener('abort', () => { aborted = true; clearTimeout(timer); reject(signal.reason); }, { once: true });
    }) });
  await assert.rejects(hanging.request(remote + '/api/posts'), /Smoke transport failed/); assert.equal(aborted, true);
});
