import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smokeAlerts } from '../scripts/smoke-alerts.mjs';
import { smokeThumbnails } from '../scripts/smoke-thumbnails.mjs';
test('thumbnail acceptance rejects localhost before credential or network access', async () => {
  await assert.rejects(smokeThumbnails(['http://localhost:8787']), /requires the deployed preview/);
});
test('alert smoke reconciles and retracts a commit whose response fails header validation', async () => {
  const origin = 'http://localhost:8788'; let saved; let retractions = 0;
  const reply = (value, status = 200, version = '3') => Response.json({ ok: true, request_id: 'test', ...value }, { status, headers: { 'X-API-Version': version, 'X-Request-ID': 'test', 'Cache-Control': 'no-store' } });
  const request = async (url, init = {}) => {
    const path = new URL(url).pathname; const query = new URL(url).searchParams;
    if (path === '/') return new Response(null, { headers: { ETag: '"page"' } });
    if (query.has('client_ref')) return saved ? reply(saved) : reply({ ok: false }, 404);
    if (path.endsWith('/retract')) { retractions++; saved.state = 'retracted'; return reply({ ...saved, status: retractions === 1 ? 'retracted' : 'already_retracted', expires_at: null }); }
    if (init.method === 'POST') {
      const input = JSON.parse(init.body);
      if (query.get('dry_run') === 'true') return reply({ dry_run: true, committed: false, expires_at: new Date(Date.parse(input.observed_at) + 86400000).toISOString() });
      saved = { client_ref: input.client_ref, alert_id: 'a', entry_id: 'e', state: 'open' };
      return reply(saved, 200, 'incorrect');
    }
    return reply({ alerts: [] });
  };
  await assert.rejects(smokeAlerts(origin, request, {}));
  assert.equal(saved.state, 'retracted'); assert.equal(retractions, 2);
});
