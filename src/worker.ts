import { timingSafeEqual } from 'node:crypto';
import { matchesEtag, parseIfNoneMatch } from './conditions';
import { hashBytes, IMAGE_CACHE, imageUpload, withImageUploadSlot } from './images';
import { HTML_CACHE } from './publishing';
import { renderPage } from './render';
import { isIndexable, metadataResource } from './public-metadata';
import type { Env } from './types';
import { HttpError, readLimited, validateDigest } from './validation';
export { DigestPublisher } from './publisher';

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
}

async function authenticate(request: Request, secret?: string): Promise<void> {
  if (!secret || secret.length < 32) throw new HttpError(503, 'Publishing secret is not configured');
  const token = /^Bearer +([^\s]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
  const [provided, expected] = await Promise.all([token, secret].map(async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))));
  if (!timingSafeEqual(provided, expected)) throw new HttpError(401, 'Unauthorized');
}

function originFor(request: Request, env: Env): string {
  try {
    const url = new URL(env.SITE_ORIGIN || new URL(request.url).origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid origin');
    return url.origin;
  } catch { throw new HttpError(503, 'Site origin is not configured correctly'); }
}

// One cached fallback per serving origin; never hash static HTML on every request.
const fallbackPages = new Map<string, Promise<{ html: string; etag: string }>>();
function fallbackFor(origin: string): Promise<{ html: string; etag: string }> {
  let page = fallbackPages.get(origin);
  if (!page) {
    page = (async () => {
      const html = renderPage([], { origin });
      return { html, etag: `W/"${await hashBytes(new TextEncoder().encode(html))}"` };
    })();
    fallbackPages.set(origin, page);
  }
  return page;
}

async function publicObject(request: Request, env: Env, key: string, image = false): Promise<Response> {
  const condition = parseIfNoneMatch(request.headers.get('if-none-match'));
  const object = request.method === 'HEAD'
    ? await env.SITE_BUCKET.head(key)
    : await env.SITE_BUCKET.get(key, condition ? { onlyIf: new Headers({ 'If-None-Match': condition.header }) } : undefined);
  const headers = new Headers({ 'Cloudflare-CDN-Cache-Control': image ? IMAGE_CACHE : 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (!object) {
    if (key !== 'pages/index.html') return json({ ok: false, error: 'Not found' }, 404);
    const { html, etag } = await fallbackFor(originFor(request, env));
    headers.set('Cache-Control', HTML_CACHE);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('ETag', etag);
    const unchanged = matchesEtag(condition, etag);
    return new Response(request.method === 'HEAD' || unchanged ? null : html, { status: unchanged ? 304 : 200, headers });
  }
  object.writeHttpMetadata(headers);
  // Serving policy overrides metadata on older stored objects too.
  headers.set('Cache-Control', image ? IMAGE_CACHE : HTML_CACHE);
  const etag = image ? object.httpEtag : `W/"${object.etag}"`;
  headers.set('ETag', etag);
  const body = (object as Partial<R2ObjectBody>).body;
  if (matchesEtag(condition, etag)) {
    if (body) await body.cancel();
    return new Response(null, { status: 304, headers });
  }
  if (request.method === 'HEAD') return new Response(null, { headers });
  if (!body) throw new Error('Unexpected conditional read result');
  return new Response(body, { headers });
}

const handler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    let operation: 'read' | 'digest' | 'image' | 'rebuild' = 'read';
    let publicationAttempted = false;
    try {
      const path = new URL(request.url).pathname;
      const maintenance = /^\/api\/rebuild(?:\/([a-f0-9-]{36})(\/resume)?)?$/.exec(path);
      if (maintenance) {
        operation = 'rebuild';
        await authenticate(request, env.API_SECRET);
        const publisher = env.PUBLISHER.getByName('site');
        if (!maintenance[1] && request.method === 'POST') {
          const job = await publisher.enqueueRebuild(originFor(request, env));
          return json({ ok: true, job }, 202);
        }
        if (maintenance[1] && !maintenance[2] && request.method === 'GET') {
          const job = await publisher.jobStatus(maintenance[1]);
          return job ? json({ ok: true, job }) : json({ ok: false, error: 'Job not found' }, 404);
        }
        if (maintenance[2] && request.method === 'POST') {
          const job = await publisher.resumeRebuild(maintenance[1]);
          if (!job) return json({ ok: false, error: 'Job not found' }, 404);
          return job === 'conflict' ? json({ ok: false, error: 'Only failed jobs can resume' }, 409) : json({ ok: true, job }, 202);
        }
        return json({ ok: false, error: 'Method not allowed' }, 405, { Allow: maintenance[1] && !maintenance[2] ? 'GET' : 'POST' });
      }
      if (path === '/api/digests' || path === '/api/images') {
        operation = path === '/api/digests' ? 'digest' : 'image';
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
          const publisher = env.PUBLISHER.getByName('site');
          publicationAttempted = true;
          await publisher.publish(digest, origin);
          return json({ ok: true, url: '/' });
        }
        return await withImageUploadSlot(async () => {
          const image = await imageUpload(request);
          const key = `images/${image.hash}.${image.extension}`;
          await env.SITE_BUCKET.put(key, image.file.stream(), { httpMetadata: { contentType: image.type, cacheControl: IMAGE_CACHE } });
          return json({ ok: true, url: `${origin}/${key}` });
        });
      }
      if (!['GET', 'HEAD'].includes(request.method)) return json({ ok: false, error: 'Method not allowed' }, 405, { Allow: 'GET, HEAD' });
      const metadata = await metadataResource(request, env.SITE_BUCKET, originFor(request, env));
      if (metadata) return metadata;
      if (path === '/' || path === '/index.html') return await publicObject(request, env, 'pages/index.html');
      if (/^\/images\/[a-f0-9]{64}\.(jpg|png|webp|gif)$/.test(path)) return await publicObject(request, env, path.slice(1), true);
      return json({ ok: false, error: 'Not found' }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ ok: false, error: error.message }, error.status, error.headers);
      console.error('Request failed', error instanceof Error ? error.name : 'Unknown error');
      const message = publicationAttempted
        ? 'Unable to publish digest; publication may have completed. Check the homepage before posting again'
        : { read: 'Unable to load content', digest: 'Unable to process digest', image: 'Unable to upload image', rebuild: 'Unable to complete rebuild request' }[operation];
      return json({ ok: false, error: message }, 500);
    }
  },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await handler.fetch(request, env);
    // Stored HTML may have production metadata even when served from workers.dev.
    // Apply the actual serving-origin policy to every response, including 304s.
    let indexable = false;
    try { indexable = isIndexable(originFor(request, env), new URL(request.url).origin); }
    catch { /* Invalid configuration must never enable indexing. */ }
    if (!indexable) response.headers.set('X-Robots-Tag', 'noindex');
    if (request.method === 'HEAD' && response.body) {
      await response.body.cancel();
      return new Response(null, response);
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
