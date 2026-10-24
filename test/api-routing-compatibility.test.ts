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

it('isolates request services, credentials and diagnostics across concurrent requests', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const contexts: Array<{ request_id: string; environment: string }> = [];
  const read = (wait: boolean) => async (_query: string, context: typeof contexts[number]) => {
    contexts.push(context);
    if (wait) await pending;
    return { ok: true, result: { days: 30, as_of: '2026-10-24T12:00:00Z', published_at: null, events: [] } };
  };
  const bindings = (name: string, wait: boolean) => ({ ...env, API_SECRET: secret + name, ENVIRONMENT: name, CF_VERSION_METADATA: { id: name }, PUBLISHER: { getByName: () => ({ readEventsV1: read(wait) }) } }) as unknown as Env;
  const request = (name: string) => new Request('https://lakearrowhead.town/api/events', { headers: { Authorization: `Bearer ${secret}${name}` } });
  const first = worker.fetch(request('first'), bindings('first', true));
  const second = await worker.fetch(request('second'), bindings('second', false));
  release();
  const responses = [await first, second];
  for (const [i, name] of ['first', 'second'].entries()) {
    expect(responses[i].status).toBe(200);
    const id = responses[i].headers.get('X-Request-ID');
    expect(responses[i].headers.get('X-Worker-Version')).toBe(name);
    expect((await responses[i].json<any>()).request_id).toBe(id);
    expect(contexts.find(context => context.request_id === id)?.environment).toBe(name);
    expect(logs.filter(log => log.event === 'request_completed' && log.request_id === id)).toHaveLength(1);
  }
  expect(contexts[0].request_id).not.toBe(contexts[1].request_id);
});

it('normalizes non-Error failures without losing finalization or leaking the thrown value', async () => {
  const bindings = { ...env, get API_SECRET(): string { throw 'sensitive unexpected value'; } } as unknown as Env;
  const response = await worker.fetch(new Request('https://lakearrowhead.town/api/posts'), bindings);
  expect(response.status).toBe(500);
  const body: any = await response.json();
  expect(body.request_id).toBe(response.headers.get('X-Request-ID'));
  expect(logs.filter(log => log.event === 'request_completed')).toHaveLength(1);
  expect(logs.filter(log => log.event === 'request_error')).toHaveLength(1);
  expect(JSON.stringify([body, logs])).not.toContain('sensitive unexpected value');
});
