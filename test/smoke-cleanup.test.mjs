import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smokeAlerts } from '../scripts/smoke-alerts.mjs';
import { smokeThumbnails } from '../scripts/smoke-thumbnails.mjs';
import { readSmokeNews } from '../scripts/smoke-preview.mjs';
test('news smoke reads reject failed HTTP and application responses', async () => {
  for (const response of [Response.json({ error: 'offline' }, { status: 503 }), Response.json({ ok: false, posts: [] })]) {
    await assert.rejects(readSmokeNews(async () => response, 'http://localhost:8787', {}));
  }
});
test('thumbnail acceptance rejects localhost before credential or network access', async () => {
  await assert.rejects(smokeThumbnails(['http://localhost:8787']), /requires the deployed preview/);
});
test('alert smoke reconciles and retracts a commit whose response fails header validation', async () => {
  const origin = 'http://localhost:8788'; let saved; let retractions = 0; const references = [];
  const reply = (value, status = 200, version = '3') => Response.json({ ok: true, request_id: 'test', ...value }, { status, headers: { 'X-API-Version': version, 'X-Request-ID': 'test', 'Cache-Control': 'no-store' } });
  const request = async (url, init = {}) => {
    const path = new URL(url).pathname; const query = new URL(url).searchParams;
    if (path === '/') return new Response(null, { headers: { ETag: '"page"' } });
    if (query.has('client_ref')) return saved ? reply(saved) : reply({ ok: false }, 404);
    if (path.endsWith('/retract')) { retractions++; saved.state = 'retracted'; return reply({ ...saved, status: retractions === 1 ? 'retracted' : 'already_retracted', expires_at: null }); }
    if (init.method === 'POST') {
      const input = JSON.parse(init.body);
      if (query.get('dry_run') === 'true') return reply({ dry_run: true, committed: false, expires_at: new Date(Date.parse(input.observed_at) + 86400000).toISOString() });
      assert(references.includes(input.client_ref), 'Register the recovery reference before publishing');
      saved = { client_ref: input.client_ref, alert_id: 'a', entry_id: 'e', state: 'open' };
      return reply(saved, 200, 'incorrect');
    }
    return reply({ alerts: [] });
  };
  await assert.rejects(smokeAlerts(origin, request, {}, { registerAlert: reference => references.push(reference) }));
  assert.equal(saved.state, 'retracted'); assert.equal(retractions, 2);
});
test('alert cleanup shares one deadline and preserves a post-commit assertion failure', async () => {
  const reply = value => Response.json({ ok: true, request_id: 'test', ...value }, { headers: { 'X-API-Version': '3', 'X-Request-ID': 'test', 'Cache-Control': 'no-store' } });
  const request = async (url, init = {}) => {
    const query = new URL(url).searchParams;
    if (new URL(url).pathname === '/') return new Response(null);
    if (query.has('client_ref')) return new Response(null, { status: 404 });
    if (init.method === 'POST') {
      const input = JSON.parse(init.body);
      if (query.has('dry_run')) return reply({ dry_run: true, committed: false, expires_at: new Date(Date.parse(input.observed_at) + 86400000).toISOString() });
      return reply({ request_id: 'incorrect-after-commit' });
    }
    return reply({ alerts: [] });
  };
  let aborted = false;
  await assert.rejects(smokeAlerts('http://localhost:8788', request, {}, { cleanupTimeoutMs: 1,
    cleanupRequest: async (_url, { signal }) => new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Cleanup did not abort')), 1000);
      signal.addEventListener('abort', () => { aborted = true; clearTimeout(timer); reject(signal.reason); }, { once: true });
    }) }), error => error instanceof AggregateError && error.errors[0].name === 'AssertionError' && error.errors[1].message === 'Alert cleanup failed');
  assert.equal(aborted, true);
});
