import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import type { Env } from '../src/types';
import { secret } from './helpers/fixtures';

const logs: Array<Record<string, any>> = [];
beforeEach(() => { vi.restoreAllMocks(); logs.length = 0; for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(event => { logs.push(event); }); });
const id = '00000000-0000-0000-0000-000000000001';
const methodsFirst = ['/api/digests', '/api/events', '/api/images', `/api/posts/${id}/retract`, `/api/posts/${id}/items/0/updates`];
const authFirst = ['/api/posts', '/api/changes', '/api/alerts', '/api/alerts/confirmations', `/api/alerts/${id}`, `/api/alerts/${id}/entries/${id}/retract`, '/api/rebuild', `/api/rebuild/${id}`, `/api/rebuild/${id}/resume`, '/api/publication/repair', '/api/publication/repair/resume', '/api/publication/repair/cancel'];

it('preserves method/auth precedence without accessing bindings', async () => {
  const lookup = vi.fn(() => { throw new Error('Must not access publisher'); });
  const bindings = { ...env, API_SECRET: secret, PUBLISHER: { getByName: lookup } } as unknown as Env;
  for (const method of ['PUT', 'OPTIONS', 'DELETE']) for (const path of [...methodsFirst, ...authFirst]) {
    const response = await worker.fetch(new Request('https://lakearrowhead.town' + path, { method }), bindings);
    expect(response.status, `${method} ${path}`).toBe(methodsFirst.includes(path) ? 405 : 401);
    const body: any = await response.json();
    expect(body.request_id).toBe(response.headers.get('X-Request-ID'));
    expect(response.headers.get('X-API-Version')).toBe('3');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  }
  expect(lookup).not.toHaveBeenCalled();
});

it('keeps strict raw paths, unknown API fallbacks, repeated queries and HEAD restrictions', async () => {
  const lookup = vi.fn(() => { throw new Error('Must not access publisher'); });
  const storage = vi.fn(() => { throw new Error('Must not access storage'); });
  const bindings = { ...env, API_SECRET: secret, PUBLISHER: { getByName: lookup }, SITE_BUCKET: { get: storage, head: storage } } as unknown as Env;
  for (const path of ['/api', '/api/', '/api/unknown', '/api/posts/', '/api/%70osts', '/api//posts', '/api/rebuild/invalid', `/api/rebuild/${id}/`]) {
    for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS']) {
      const response = await worker.fetch(new Request('https://lakearrowhead.town' + path, { method }), bindings);
      expect(response.status, `${method} ${path}`).toBe(['GET', 'HEAD'].includes(method) ? 404 : 405);
      if (method === 'HEAD') expect(await response.text()).toBe('');
      else expect((await response.json<any>()).diagnostics.stage).toBe(method === 'GET' ? 'public_read' : 'request_processing');
    }
  }
  const head = await worker.fetch(new Request(`https://lakearrowhead.town/api/rebuild/${id}`, { method: 'HEAD', headers: { Authorization: `Bearer ${secret}` } }), bindings);
  expect(head.status).toBe(405); expect(head.headers.get('Allow')).toBe('GET'); expect(await head.text()).toBe('');
  for (const path of ['/api/digests?client_ref=a&client_ref=b', '/api/digests?dry_run=true&dry_run=false', '/api/alerts?history=full&history=full']) {
    const response = await worker.fetch(new Request('https://lakearrowhead.town' + path, { method: path.includes('client_ref') ? 'GET' : 'POST', headers: { Authorization: `Bearer ${secret}` } }), bindings);
    expect(response.status, path).toBe(400);
  }
  expect(lookup).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
});

it('passes percent-encoded identity segments to RPC unchanged', async () => {
  const read = vi.fn(async () => ({ ok: false, failure: { status: 404, code: 'not_found', error: 'Not found', retryable: false, publication_status: 'not_attempted', stage: 'alerts_read' } }));
  const bindings = { ...env, API_SECRET: secret, PUBLISHER: { getByName: () => ({ readAlertsV1: read }) } } as unknown as Env;
  await worker.fetch(new Request('https://lakearrowhead.town/api/alerts/%61%2Fb', { headers: { Authorization: `Bearer ${secret}` } }), bindings);
  expect(read).toHaveBeenCalledWith('', expect.any(Object), '%61%2Fb');
});

