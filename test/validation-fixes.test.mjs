import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeFailure, reportFailure, ValidationError, TransportError } from '../scripts/validation-errors.mjs';
import { createSmokeContext } from '../scripts/smoke-support.mjs';
import { maintenance, waitForRebuild } from '../scripts/maintenance.mjs';
import { previewCI } from '../scripts/preview-ci.mjs';
import { smokeThumbnails, thumbnailBytes, THUMBNAIL_ARTIFACT_LIMIT } from '../scripts/smoke-thumbnails.mjs';
import { fakeClock } from './helpers/clock.mjs';

const origin = 'https://lakearrowheadtown-preview.harold-martin.workers.dev';
const secret = 'test-secret-at-least-thirty-two-characters-long';
const version = '00000000-0000-0000-0000-000000000001';
const reply = (value = {}, worker = version) => Response.json({ ok: true, ...value }, { headers: { 'X-Worker-Version': worker } });
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'validation-fixes-')); t.after(() => rm(path, { recursive: true, force: true })); return path;
}
function candidateOptions(artifactsDirectory) {
  let tag;
  return { artifactsDirectory, sha: 'a'.repeat(40), variables: {}, credential: () => secret,
    command: async args => args[0] === 'git' ? 'b'.repeat(40) + '\n' : JSON.stringify([{ id: version, annotations: { 'workers/tag': tag } }]),
    deploy: async (_environment, options) => { tag = options.tag; return { id: version, status: 'queued' }; },
    config: { vars: { ALERT_CONFIRMATIONS_ENABLED: 'false' } }, wait: async () => {}, smoke: async () => {}, thumbnails: async () => {}, request: async () => reply() };
}

test('version drift fails on the first rebuild read, including the final grace read', async () => {
  for (const timeoutMs of [1000, 300000]) {
    const clock = fakeClock(); let requests = 0;
    const context = createSmokeContext(origin, { credential: () => secret, expectedVersion: version, request: async () => { requests++; return reply({}, 'changed'); } });
    await assert.rejects(waitForRebuild({ id: version, status: 'queued' }, 'preview', { secret, origin, timeoutMs, ...clock, request: context.request }), error => error.code === 'version_drift');
    assert.equal(requests, 1); assert.equal(clock.now(), 1000);
  }
  const assertion = new assert.AssertionError({ message: 'Explicit adapter validation failed' });
  await assert.rejects(maintenance('status', 'preview', version, { secret, origin, request: async () => { throw assertion; } }), error => error === assertion);
});

test('nested fixture scopes share one request owner and clean only their own references', async t => {
  const artifactsDirectory = await directory(t); const retracted = []; let calls = 0;
  const root = createSmokeContext(origin, { credential: () => secret, expectedVersion: version, artifactsDirectory, request: async url => {
    calls++; const parsed = new URL(url); const reference = parsed.searchParams.get('client_ref');
    if (reference) return reply({ client_ref: reference, post: { id: reference }, status: 'published' });
    if (parsed.pathname.endsWith('/retract')) { retracted.push(parsed.pathname.split('/')[3]); return reply({ status: 'retracted' }); }
    return reply();
  } });
  const child = createSmokeContext(origin, { context: root, artifactName: 'child' });
  assert.equal(child.request, root.request);
  root.registerDigest('root'); child.registerDigest('child');
  await child.run(() => child.request(origin + '/api/posts'));
  assert.deepEqual(retracted, ['child']);
  await root.run(async () => {}); assert.deepEqual(retracted, ['child', 'root']);
  const rootReport = JSON.parse(await readFile(join(artifactsDirectory, 'smoke.json')));
  assert.equal(rootReport.events.length, calls); assert.equal(calls, 5);
  assert.equal(JSON.parse(await readFile(join(artifactsDirectory, 'child.json'))).events, undefined);
  await assert.rejects(root.request(origin + '/api/posts', {}, false).then(() => {
    throw new ValidationError('test_failure', 'Validation is terminal');
  }), /Validation is terminal/);
  assert.throws(() => createSmokeContext('http://localhost:8787', { context: root }), /same origin/);
});

test('nested assertion and version failures retain their original classification', async () => {
  const root = createSmokeContext(origin, { credential: () => secret, expectedVersion: version, request: async () => reply({}, 'drift') });
  const child = createSmokeContext(origin, { context: root });
  await assert.rejects(child.run(() => child.request(origin + '/api/posts')), error => error instanceof ValidationError && error.code === 'version_drift' && !error.transport);
  const cause = Error('private response body');
  const broken = createSmokeContext(origin, { credential: () => secret, request: async () => { throw cause; } });
  await assert.rejects(maintenance('status', 'preview', version, { origin, secret, request: broken.request }), error => error instanceof TransportError && error.cause === cause);
});

test('diagnostics expose fixed reasons and bounded causes without generated diffs or child-process output', t => {
  let generated;
  try { assert.equal(secret, 'expected'); } catch (error) { generated = error; }
  const processFailure = Object.assign(Error(secret), { stderr: Buffer.from(secret), stdout: secret });
  let explicitlyMessaged;
  try { assert.equal(secret, 'expected', 'Safe explicit reason'); } catch (error) { explicitlyMessaged = error; }
  assert.equal(safeFailure(explicitlyMessaged).message, 'Safe explicit reason');
  assert(!JSON.stringify(safeFailure(explicitlyMessaged)).includes(secret));
  const original = new ValidationError('candidate_superseded', `Candidate changed ${secret}`, { cause: processFailure });
  const summary = safeFailure(new AggregateError([original, generated]), [secret]);
  assert.equal(summary.errors[0].code, 'candidate_superseded');
  assert.match(summary.errors[0].message, /Candidate changed \[redacted\]/);
  assert(!JSON.stringify(summary).includes(secret));
  const huge = new ValidationError('long', 'x'.repeat(1000)); assert.equal(safeFailure(huge).message.length, 300);
  huge.cause = huge; assert.equal(safeFailure(huge).cause.code, 'truncated');
  assert.equal(safeFailure(new AggregateError(Array(20).fill(generated))).errors.length, 8);
  assert.match(safeFailure(new TransportError('Request failed', processFailure)).message, /Request failed/);
  const bounded = new ValidationError('rebuild_incomplete', secret, { safeMessage: 'Rebuild remains blocked' });
  assert.equal(safeFailure(bounded).message, 'Rebuild remains blocked');
  assert.equal(safeFailure(Object.assign(Error(secret), { status: 503 })).http_status, 503);
  const logs = []; t.mock.method(console, 'error', value => logs.push(value));
  reportFailure('Validation failed', generated); assert(!logs[0].includes(secret)); assert.match(logs[0], /assertion_failed/);
});

test('every orchestration preflight failure persists a safe reason before deployment', async t => {
  const path = await directory(t); const options = candidateOptions(path);
  const cases = [
    [{ variables: { GITHUB_ACTIONS: 'true' } }, 'Missing CI configuration'],
    [{ credential: () => 'short' }, 'Publishing credential'],
    [{ sha: 'bad' }, 'Candidate SHA'],
    [{ variables: { CANDIDATE_PR: '1', CANDIDATE_BASE_SHA: 'base', CANDIDATE_HEAD_SHA: 'head' }, command: async () => JSON.stringify({ state: 'OPEN', isCrossRepository: false, headRefOid: 'head', baseRefOid: 'stale' }) }, 'Candidate base changed'],
    [{ sha: '', command: async () => { throw Error(secret); } }, 'Command failed'],
  ];
  for (const [patch, message] of cases) {
    let deployments = 0;
    await assert.rejects(previewCI({ ...options, ...patch, deploy: async () => { deployments++; } }), new RegExp(message));
    assert.equal(deployments, 0);
    const report = JSON.parse(await readFile(join(path, 'result.json')));
    assert.equal(report.status, 'failed'); assert.match(report.failure.message, new RegExp(message));
    assert(!JSON.stringify(report).includes(secret));
  }
});

test('SHA fallback awaits asynchronous git and diagnostics preserve persistence failures', async t => {
  const path = await directory(t); const options = candidateOptions(path);
  for (const patch of [{ sha: undefined }, { sha: '', variables: { CANDIDATE_SHA: '  ' } }]) {
    const result = await previewCI({ ...options, ...patch }); assert.equal(result.candidate_sha, 'b'.repeat(40));
  }
  assert.equal((await previewCI({ ...options, sha: '', variables: { CANDIDATE_SHA: 'c'.repeat(40) } })).candidate_sha, 'c'.repeat(40));
  const file = join(path, 'file'); await writeFile(file, 'not a directory');
  await assert.rejects(previewCI({ ...options, artifactsDirectory: file, sha: 'invalid' }), error => error instanceof AggregateError && error.errors[0].name === 'AssertionError' && error.errors[1].code === 'EEXIST');
});

test('thumbnail body limits cancel oversized streams and reject invalid artifacts before writing', async t => {
  assert.equal((await thumbnailBytes(new Response('small'))).toString(), 'small');
  await assert.rejects(thumbnailBytes(new Response(null)), /no image body/);
  let cancelled = false;
  await assert.rejects(thumbnailBytes(new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(THUMBNAIL_ARTIFACT_LIMIT)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  }))), /exceeds 1 MiB/); assert(cancelled);
  for (const oversized of [false, true]) {
    const path = join(await directory(t), 'new-artifacts'); const logs = [];
    await assert.rejects(smokeThumbnails([origin], { credential: () => secret, artifactsDirectory: path, log: value => logs.push(value), request: async url => {
      if (url.endsWith('/api/images')) return reply({ url: origin + '/images/test.jpg', width: 1920, height: 1280 });
      return new Response(oversized ? new Uint8Array(THUMBNAIL_ARTIFACT_LIMIT + 1) : 'not an image', { headers: { 'Content-Type': 'image/webp' } });
    } }));
    assert(!(await readdir(path)).some(name => name.endsWith('.webp')));
    assert(!logs.some(value => value.includes('passed')));
  }
});
