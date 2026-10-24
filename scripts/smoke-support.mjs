import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readPublishingCredential, validateCredential } from './credentials.mjs';
import { maintenanceTarget } from './maintenance.mjs';

export async function withCleanup(task, cleanup) {
  let result; let failure;
  try { result = await task(); } catch (error) { failure = error; }
  try { await cleanup(); } catch (error) { if (failure) throw new AggregateError([failure, error], 'Smoke failed and fixture cleanup also failed'); throw error; }
  if (failure) throw failure;
  return result;
}

export function createSmokeContext(origin, options = {}) {
  origin = maintenanceTarget('preview', origin);
  const secret = validateCredential((options.credential ?? readPublishingCredential)('preview'));
  const headers = { Authorization: `Bearer ${secret}` };
  const references = new Set(); const alertReferences = new Set(); const events = []; let dropped = 0; let version = options.expectedVersion;
  const record = event => { if (events.length < 500) events.push(event); else dropped++; };
  const now = options.now ?? (() => new Date());
  const request = async (url, init = {}, cleanup = false) => {
    const target = new URL(url);
    assert.equal(target.origin, origin, 'Smoke requests must remain on the validated preview origin');
    const timeout = AbortSignal.timeout(options.requestTimeoutMs ?? 30000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response;
    try { response = await (cleanup ? options.cleanupRequest ?? options.request ?? globalThis.fetch : options.request ?? globalThis.fetch)(url, { ...init, signal }); }
    catch { record({ path: target.pathname, method: init.method ?? 'GET', transport: 'failed' }); throw new Error(`Smoke transport failed: ${init.method ?? 'GET'} ${target.pathname}`); }
    const received = response.headers.get('X-Worker-Version');
    record({ path: target.pathname, method: init.method ?? 'GET', status: response.status, request_id: response.headers.get('X-Request-ID'), worker_version: received });
    if (target.pathname.startsWith('/api/') && !cleanup) {
      assert(received, 'API must expose its Worker version');
      version ??= received; assert.equal(received, version, 'Preview deployment changed during validation');
    }
    return response;
  };
  const cleanup = async () => {
    const deadline = performance.now() + (options.cleanupTimeoutMs ?? 120000); const failures = [];
    for (const reference of references) {
      try {
        const remaining = Math.floor(deadline - performance.now()); assert(remaining > 0, 'Fixture cleanup deadline exceeded');
        const init = { headers, signal: AbortSignal.timeout(remaining) };
        const lookup = await request(`${origin}/api/digests?client_ref=${encodeURIComponent(reference)}`, init, true);
        if (lookup.status === 404) continue;
        assert.equal(lookup.status, 200, 'Cleanup reference lookup failed');
        const found = await lookup.json(); assert(found.ok && found.post?.id, 'Cleanup lookup was malformed');
        if (found.status === 'retracted') continue;
        const response = await request(`${origin}/api/posts/${found.post.id}/retract`, { ...init, method: 'POST' }, true);
        assert.equal(response.status, 200, 'Fixture retraction failed');
        const result = await response.json(); assert(['retracted', 'already_retracted'].includes(result.status));
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Fixture cleanup failed');
  };
  const persist = async () => {
    if (!options.artifactsDirectory) return;
    await mkdir(options.artifactsDirectory, { recursive: true });
    await writeFile(join(options.artifactsDirectory, `${options.artifactName ?? 'smoke'}.json`), JSON.stringify({ candidate_sha: options.candidateSha, worker_version: version, fixture_references: [...references], alert_references: [...alertReferences], events, events_dropped: dropped }, null, 2));
  };
  return { secret, headers, request, cleanupRequest: (url, init) => request(url, init, true), now, registerDigest: reference => { assert(reference); references.add(reference); },
    registerAlert: reference => { assert(reference); alertReferences.add(reference); },
    run: task => withCleanup(() => withCleanup(task, cleanup), persist) };
}

export async function verifyHtmlRevalidation(origin, request, edge = false) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request(origin, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(response.status, 200); const tag = response.headers.get('ETag');
    assert(tag?.startsWith('W/'), 'Public HTML requires a weak ETag');
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate, no-transform');
    if (edge) assert.match(response.headers.get('Content-Encoding') ?? '', /gzip|br|zstd/, 'Edge HTML requires negotiated compression');
    await response.arrayBuffer();
    const head = await request(origin, { method: 'HEAD' }); assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const conditional = await request(origin, { headers: { 'If-None-Match': tag } });
    if (head.headers.get('ETag') !== tag || conditional.status === 200 && conditional.headers.get('ETag') !== tag) { await conditional.arrayBuffer(); continue; }
    assert.equal(conditional.status, 304, 'A stable public HTML validator must return 304');
    assert.equal(conditional.headers.get('ETag'), tag); assert.equal((await conditional.arrayBuffer()).byteLength, 0);
    const conditionalHead = await request(origin, { method: 'HEAD', headers: { 'If-None-Match': tag } });
    if (conditionalHead.status === 200 && conditionalHead.headers.get('ETag') !== tag) continue;
    assert.equal(conditionalHead.status, 304); assert.equal((await conditionalHead.arrayBuffer()).byteLength, 0); return;
  }
  throw new Error('No stable HTML validator sequence after three attempts');
}
