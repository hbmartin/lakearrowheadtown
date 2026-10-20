import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { HttpError } from '../src/errors';
import { noStoreHeaders } from '../src/responses';
import { SITE } from '../src/site';
import { renderPage } from '../src/render';
import type { Env } from '../src/types';

const bindings = env as unknown as Env;
const request = (path: string, init: RequestInit = {}, origin: string = SITE.origin, overrides: Partial<Env> = {}) =>
  worker.fetch(new Request(origin + path, init), { ...bindings, SITE_ORIGIN: SITE.origin, ...overrides });
const entries = [
  ['allow', 'GET, HEAD'], ['retry-after', '60'], ['x-extra', 'preserved'],
  ['content-type', 'text/plain'], ['cache-control', 'public, max-age=86400'],
  ['cloudflare-cdn-cache-control', 'public'], ['x-content-type-options', 'wrong'],
  ['cDn-CaChE-CoNtRoL', 'public, max-age=86400'], ['Surrogate-Control', 'max-age=86400, stale-if-error=3600'],
  ['set-cookie', 'intentional=value; Path=/; SameSite=Lax'],
  ['www-authenticate', 'Bearer'], ['x-test-diagnostic', 'preserved'],
];
const formats: Array<[string, () => HeadersInit]> = [
  ['record', () => Object.fromEntries(entries)],
  ['Headers', () => new Headers(entries)],
  ['pairs', () => entries.map(([name, value]) => [name.toUpperCase(), value])],
];
function safeHeaders(response: Response, type: string) {
  expect(response.headers.get('Content-Type')).toBe(type);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store');
  expect(response.headers.get('CDN-Cache-Control')).toBe('no-store');
  expect(response.headers.get('Surrogate-Control')).toBe('no-store');
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
});

describe('error headers', () => {
  it.each(formats)('normalizes %s headers without mutating the caller', (_name, make) => {
    const input = make();
    const before = [...new Headers(input)];
    const headers = noStoreHeaders('application/json', input);
    safeHeaders(new Response(null, { headers }), 'application/json');
    expect(headers.get('ALLOW')).toBe('GET, HEAD');
    expect(headers.get('Retry-After')).toBe('60');
    expect(headers.get('X-Extra')).toBe('preserved');
    expect(headers.get('Set-Cookie')).toBe('intentional=value; Path=/; SameSite=Lax');
    expect(headers.get('WWW-Authenticate')).toBe('Bearer');
    expect(headers.get('X-Test-Diagnostic')).toBe('preserved');
    expect([...new Headers(input)]).toEqual(before);
  });

  it.each(formats)('preserves %s failure headers through both error representations', async (_name, make) => {
    for (const status of [404, 503]) for (const method of ['GET', 'HEAD']) {
      const fail = async () => { throw new HttpError(status, 'Public message', make()); };
      const SITE_BUCKET = { get: fail, head: fail } as unknown as R2Bucket;
      const response = await request('/', { method }, SITE.origin, { SITE_BUCKET });
      expect(response.status).toBe(status);
      safeHeaders(response, status === 404 ? 'text/html; charset=utf-8' : 'application/json');
      expect(response.headers.get('Allow')).toBe('GET, HEAD');
      expect(response.headers.get('Retry-After')).toBe('60');
      expect(response.headers.get('X-Extra')).toBe('preserved');
      expect(response.headers.get('Set-Cookie')).toBe('intentional=value; Path=/; SameSite=Lax');
      expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
      expect(response.headers.get('X-Test-Diagnostic')).toBe('preserved');
      if (method === 'HEAD') expect(await response.text()).toBe('');
      else if (status === 503) expect(await response.json()).toEqual({ ok: false, error: 'Public message' });
      else expect(await response.text()).toContain('<h1>Page not found</h1>');
    }
  });
});

describe('public errors', () => {
  it.each([
    { name: 'production', origin: SITE.origin, SITE_ORIGIN: SITE.origin, ENVIRONMENT: 'production' },
    { name: 'alternate production hostname', origin: 'https://alternate.example.test', SITE_ORIGIN: SITE.origin, ENVIRONMENT: 'production' },
    { name: 'preview', origin: 'https://preview.example.test', SITE_ORIGIN: '', ENVIRONMENT: 'preview' },
  ])('serves safe HTML 404s with $name configuration, including missing images and conditional requests', async ({ origin, SITE_ORIGIN, ENVIRONMENT }) => {
    for (const path of ['/missing', `/images/${'a'.repeat(64)}.png`, '/2026/02/30/', '/2026/10/19/']) {
      for (const init of [{}, { method: 'HEAD' }, { headers: { 'If-None-Match': '*' } }]) {
        const response = await request(path, init, origin, { SITE_ORIGIN, ENVIRONMENT });
        expect(response.status).toBe(404);
        safeHeaders(response, 'text/html; charset=utf-8');
        expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
        expect(response.headers.get('X-Request-ID')).toBeNull();
        const body = await response.text();
        if (init.method === 'HEAD') expect(body).toBe('');
        else {
          expect(body).toContain('<h1>Page not found</h1>');
          expect(body).toContain('<a href="/">');
          expect(body).toContain('<meta name="robots" content="noindex">');
        }
      }
    }
  });

  it('shares theme initialization and SITE branding without exposing request text', async () => {
    const html = await (await request('/missing/%3Cscript%3Eprivate-path%3C/script%3E')).text();
    const homepage = renderPage([], { origin: SITE.origin });
    for (const id of ['theme-fonts', 'theme-color']) {
      const script = new RegExp(`<script id="${id}">[\\s\\S]*?</script>`);
      expect(html.match(script)?.[0]).toBe(homepage.match(script)?.[0]);
      expect(html.match(new RegExp(`id="${id}"`, 'g'))).toHaveLength(1);
    }
    expect(html).toContain(`<title>Page not found | ${SITE.name}</title>`);
    expect(html).toContain(`--page-bg: ${SITE.background};`);
    expect(html).toContain(`--text: ${SITE.foreground};`);
    expect(html).toContain('background: var(--page-bg)');
    expect(html).toContain('var(--display-font)');
    expect(html).not.toMatch(/private-path|\{\{site\.|theme-picker|page-meta|theme-head/);
  });

  it('keeps public 405, 500 and 503 responses minimal and strips HEAD bodies', async () => {
    const broken = { get: async () => { throw new Error('private storage exception'); }, head: async () => { throw new Error('private storage exception'); } } as unknown as R2Bucket;
    for (const method of ['GET', 'HEAD']) {
      for (const [overrides, status, error] of [
        [{ SITE_BUCKET: broken }, 500, 'Storage operation failed. Retry the request.'],
        [{ SITE_ORIGIN: 'invalid origin' }, 503, 'Site origin is not configured correctly'],
      ] as const) {
        const response = await request('/', { method }, SITE.origin, overrides);
        expect(response.status).toBe(status);
        safeHeaders(response, 'application/json');
        if (method === 'HEAD') expect(await response.text()).toBe('');
        else expect(await response.json()).toEqual({ ok: false, error });
      }
    }
    const response = await request('/missing', { method: 'POST' });
    expect(response.status).toBe(405);
    safeHeaders(response, 'application/json');
    expect(response.headers.get('Allow')).toBe('GET, HEAD');
    expect(await response.json()).toEqual({ ok: false, error: 'Method not allowed' });
  });

  it('keeps API diagnostics and provenance case-sensitive', async () => {
    for (const method of ['GET', 'HEAD']) {
      const response = await request('/api/missing', { method });
      expect(response.status).toBe(404);
      safeHeaders(response, 'application/json');
      const id = response.headers.get('X-Request-ID');
      expect(id).toMatch(/^[a-f0-9-]{36}$/);
      expect(response.headers.get('X-Worker-Version')).toBeTruthy();
      expect(response.headers.get('X-API-Version')).toBe('2');
      if (method === 'HEAD') expect(await response.text()).toBe('');
      else expect(await response.json()).toMatchObject({ code: 'not_found', request_id: id, diagnostics: { stage: 'public_read' } });
      const wrongCase = await request('/API/missing', { method });
      expect(wrongCase.status).toBe(404);
      safeHeaders(wrongCase, 'text/html; charset=utf-8');
      expect(wrongCase.headers.get('X-Request-ID')).toBeNull();
      if (method === 'HEAD') expect(await wrongCase.text()).toBe('');
    }
  });
});
