import { describe, expect, it } from 'vitest';
import { htmlResponse } from '../src/html-response';

const origin = 'https://lakearrowhead.town';
const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, must-revalidate', ETag: 'W/"story"' };

describe('HTML revalidation at the edge', () => {
  it.each([
    [undefined, false], ['gzip', true], ['GZip', true], ['br, gzip;q=0.5', true], ['*;q=1', true],
    ['gzip;q=0', false], ['gzip;q=0, *;q=1', false], ['br', false], ['gzip;q=invalid', false], ['gzip;q=2', false],
  ])('negotiates runtime compression for Accept-Encoding=%s', async (encoding, compressed) => {
    const request = new Request(origin, { headers: encoding === undefined ? {} : { 'Accept-Encoding': encoding as string } });
    const response = htmlResponse(request, new Response('A story', { headers }));
    expect(response.headers.get('ETag')).toBe(headers.ETag);
    expect(response.headers.get('Cache-Control')).toBe(headers['Cache-Control'] + ', no-transform');
    expect(response.headers.get('Vary')).toBe('Accept-Encoding');
    expect(response.headers.get('Content-Encoding')).toBe(compressed ? 'gzip' : null);
    expect(await response.text()).toBe('A story');
  });

  it.each([['identity', false], ['gzip;q=0, br', false], ['gzip', true]])('uses the original visitor encoding %s over Cloudflare normalization', (original, compressed) => {
    const request = new Request(origin, { headers: { 'Accept-Encoding': 'br, gzip' } });
    Object.defineProperty(request, 'cf', { value: { clientAcceptEncoding: original } });
    const response = htmlResponse(request, new Response(null, { headers }));
    expect(response.headers.get('Content-Encoding')).toBe(compressed ? 'gzip' : null);
  });

  it.each([200, 304])('preserves validators and empty HEAD/conditional bodies for %s', async status => {
    const request = new Request(origin, { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip' } });
    const response = htmlResponse(request, new Response(null, { status, headers: { ...headers, Vary: 'Cookie' } }));
    expect(response.status).toBe(status);
    expect(response.headers.get('ETag')).toBe(headers.ETag);
    expect(response.headers.get('Vary')).toBe('Cookie, Accept-Encoding');
    expect(response.headers.get('Content-Encoding')).toBe('gzip');
    expect(await response.text()).toBe('');
  });

  it('leaves feeds, images, errors, and responses without validators unchanged', () => {
    const request = new Request(origin, { headers: { 'Accept-Encoding': 'gzip' } });
    for (const response of [
      new Response(null, { headers: { ...headers, 'Content-Type': 'application/rss+xml' } }),
      new Response(null, { headers: { ...headers, 'Content-Type': 'image/png' } }),
      new Response(null, { status: 404, headers }),
      new Response(null, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } }),
    ]) expect(htmlResponse(request, response)).toBe(response);
  });
});
