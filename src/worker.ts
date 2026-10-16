import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import emptyPage from '../index.html';
import favicon from '../favicon.svg';
import { hashBytes, IMAGE_CACHE, imageUpload } from './images';
import { HTML_CACHE, publishDigest } from './publishing';
import type { Digest, Env } from './types';
import { HttpError, isDate, readLimited, validateDigest } from './validation';

export class DigestPublisher extends DurableObject<Env> {
  private queue: Promise<void> = Promise.resolve();

  async publish(digest: Digest, origin: string): Promise<void> {
    const job = this.queue.then(() => publishDigest(this.env.SITE_BUCKET, digest, origin));
    // A rejected job must not poison the queue for the next correction.
    this.queue = job.then(() => {}, () => {});
    await job;
  }
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
}

async function authenticate(request: Request, secret?: string): Promise<void> {
  if (!secret || secret.length < 32) throw new HttpError(503, 'Publishing secret is not configured');
  const authorization = request.headers.get('authorization') ?? '';
  const [provided, expected] = await Promise.all([authorization, `Bearer ${secret}`].map(async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))));
  if (!timingSafeEqual(provided, expected)) throw new HttpError(401, 'Unauthorized');
}

function originFor(request: Request, env: Env): string {
  const url = new URL(env.SITE_ORIGIN || new URL(request.url).origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new HttpError(503, 'Site origin is not configured correctly');
  return url.origin;
}

function notModified(request: Request, etag: string): boolean {
  return (request.headers.get('if-none-match') ?? '').split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''));
}

async function publicObject(request: Request, env: Env, key: string, image = false): Promise<Response> {
  const object = await env.SITE_BUCKET.get(key);
  const headers = new Headers({
    'Cache-Control': image ? IMAGE_CACHE : HTML_CACHE,
    // Do not let an edge cache mask a newly published correction.
    'Cloudflare-CDN-Cache-Control': image ? IMAGE_CACHE : 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (!object) {
    if (key !== 'pages/index.html') return json({ ok: false, error: 'Not found' }, 404);
    const etag = `W/"${await hashBytes(new TextEncoder().encode(emptyPage).buffer as ArrayBuffer)}"`;
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('ETag', etag);
    return new Response(request.method === 'HEAD' || notModified(request, etag) ? null : emptyPage, { status: notModified(request, etag) ? 304 : 200, headers });
  }
  object.writeHttpMetadata(headers);
  // Apply serving policy after stored metadata, including older rendered pages.
  headers.set('Cache-Control', image ? IMAGE_CACHE : HTML_CACHE);
  // Weak HTML validators survive Cloudflare's automatic response compression.
  const etag = image ? object.httpEtag : `W/"${object.etag}"`;
  headers.set('ETag', etag);
  if (notModified(request, etag)) {
    await object.body.cancel();
    return new Response(null, { status: 304, headers });
  }
  if (request.method === 'HEAD') {
    await object.body.cancel();
    return new Response(null, { headers });
  }
  return new Response(object.body, { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/api/digests' || path === '/api/images') {
        if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405, { Allow: 'POST' });
        await authenticate(request, env.API_SECRET);
        const origin = originFor(request, env);
        if (path === '/api/digests') {
          if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Expected application/json');
          const bytes = await readLimited(request, 1024 * 1024);
          let input: unknown;
          try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
          catch { throw new HttpError(400, 'Invalid JSON'); }
          const digest = validateDigest(input);
          await env.PUBLISHER.getByName('site').publish(digest, origin);
          return json({ ok: true, url: `/digests/${digest.date}` });
        }
        const image = await imageUpload(request);
        const key = `images/${await hashBytes(image.bytes)}.${image.extension}`;
        await env.SITE_BUCKET.put(key, image.bytes, { httpMetadata: { contentType: image.type, cacheControl: IMAGE_CACHE } });
        return json({ ok: true, url: `${origin}/${key}` });
      }
      if (!['GET', 'HEAD'].includes(request.method)) return json({ ok: false, error: 'Method not allowed' }, 405, { Allow: 'GET, HEAD' });
      if (path === '/' || path === '/index.html') return await publicObject(request, env, 'pages/index.html');
      const date = /^\/digests\/(\d{4}-\d{2}-\d{2})$/.exec(path)?.[1];
      if (date && isDate(date)) return await publicObject(request, env, `pages/digests/${date}.html`);
      if (/^\/images\/[a-f0-9]{64}\.(jpg|png|webp|gif)$/.test(path)) return await publicObject(request, env, path.slice(1), true);
      if (path === '/favicon.svg') return new Response(request.method === 'HEAD' ? null : favicon, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
      return json({ ok: false, error: 'Not found' }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ ok: false, error: error.message }, error.status);
      // Avoid logging payloads or credentials on upload failures.
      console.error('Request failed', error instanceof Error ? error.name : 'Unknown error');
      return json({ ok: false, error: 'Unable to complete request; retry safely' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
