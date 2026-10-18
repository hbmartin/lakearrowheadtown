import { timingSafeEqual } from 'node:crypto';
import { matchesEtag, parseIfNoneMatch } from './conditions';
import { hashBytes, IMAGE_CACHE, imageUpload, withImageUploadSlot } from './images';
import { HTML_CACHE } from './publishing';
import { renderPage } from './render';
import { isIndexable, metadataResource } from './public-metadata';
import type { Env, OperationContext, PublicationStatus, PublishReply, PublishResult, RebuildJob } from './types';
import { emit, fingerprint, OperationTrace, safeError } from './diagnostics';
import { HttpError, parseDigestJson, readLimited, validateDigest } from './validation';
export { DigestPublisher } from './publisher';

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
}

async function authenticate(request: Request, secret?: string): Promise<void> {
  if (!secret || secret.length < 32) throw new HttpError(503, 'Publishing secret is not configured', {}, { code: 'configuration_error' });
  const token = /^Bearer +([^\s]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
  const [provided, expected] = await Promise.all([token, secret].map(async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))));
  if (!timingSafeEqual(provided, expected)) throw new HttpError(401, 'Unauthorized');
}

function originFor(request: Request, env: Env): string {
  try {
    const url = new URL(env.SITE_ORIGIN || new URL(request.url).origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid origin');
    return url.origin;
  } catch { throw new HttpError(503, 'Site origin is not configured correctly', {}, { code: 'configuration_error' }); }
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

interface RequestState {
  context: OperationContext;
  trace: OperationTrace;
  error_code?: string;
  bytes_received?: number;
  body_sha256?: string;
  body_complete?: boolean;
  counts?: PublishResult['counts'];
  post_id?: string;
  publication_status?: PublicationStatus;
}

async function handle(request: Request, env: Env, state: RequestState): Promise<Response> {
  const { context, trace } = state;
  const path = new URL(request.url).pathname;
  const isApi = path === '/api' || path.startsWith('/api/');
  let publicationAttempted = false;
  const reply = (value: Record<string, unknown>, status = 200, headers: HeadersInit = {}) => json({ ...value, ...(isApi ? { request_id: context.request_id } : {}) }, status, headers);
  try {
    const maintenance = /^\/api\/rebuild(?:\/([a-f0-9-]{36})(\/resume)?)?$/.exec(path);
    if (maintenance) {
      await trace.run('authentication', () => authenticate(request, env.API_SECRET));
      const publisher = env.PUBLISHER.getByName('site');
      if (!maintenance[1] && request.method === 'POST') {
        const job = await trace.run('enqueue_rebuild', () => publisher.enqueueRebuild(originFor(request, env), context));
        return reply({ ok: true, job }, 202);
      }
      if (maintenance[1] && !maintenance[2] && request.method === 'GET') {
        const job = await trace.run('rebuild_status', () => publisher.jobStatus(maintenance[1]));
        if (!job) throw new HttpError(404, 'Job not found', {}, { code: 'job_not_found' });
        return reply({ ok: true, job });
      }
      if (maintenance[2] && request.method === 'POST') {
        const job = await trace.run<RebuildJob | 'conflict' | null>('resume_rebuild', async () => await publisher.resumeRebuild(maintenance[1], context));
        if (!job) throw new HttpError(404, 'Job not found', {}, { code: 'job_not_found' });
        if (job === 'conflict') throw new HttpError(409, 'Only failed jobs can resume', {}, { code: 'job_not_failed' });
        return reply({ ok: true, job }, 202);
      }
      throw new HttpError(405, 'Method not allowed', { Allow: maintenance[1] && !maintenance[2] ? 'GET' : 'POST' });
    }
    if (path === '/api/digests' || path === '/api/images') {
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed', { Allow: 'POST' });
      await trace.run('authentication', () => authenticate(request, env.API_SECRET));
      trace.stage = 'configuration';
      const origin = originFor(request, env);
      if (path === '/api/digests') {
        trace.stage = 'content_type';
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Expected application/json', {}, { details: { expected: 'application/json' } });
        state.bytes_received = 0;
        state.body_complete = false;
        const bytes = await trace.run('body_reading', () => readLimited(request, 1024 * 1024, bytes => { state.bytes_received = bytes; }));
        state.bytes_received = bytes.byteLength;
        state.body_complete = true;
        state.body_sha256 = fingerprint(new Uint8Array(bytes));
        const input = await trace.run('parsing', () => parseDigestJson(bytes));
        const digest = await trace.run('validation', () => validateDigest(input, { requireItems: true }));
        trace.stage = 'publisher_lookup';
        const publisher = env.PUBLISHER.getByName('site');
        publicationAttempted = true;
        state.publication_status = 'unknown';
        const result = await trace.run<PublishReply>('publisher_rpc', async () => await publisher.publish(digest, origin, context));
        if (!result.ok) {
          state.publication_status = result.failure.publication_status;
          trace.stage = result.failure.stage;
          throw new HttpError(500, result.failure.error, {}, { code: result.failure.code, details: { stage: result.failure.stage }, retryable: result.failure.retryable, publication_status: result.failure.publication_status });
        }
        state.counts = result.result.counts;
        state.post_id = result.result.post?.id;
        state.publication_status = result.result.post ? 'committed' : 'not_committed';
        return reply({ ok: true, url: '/', ...result.result });
      }
      trace.stage = 'upload_admission';
      return await withImageUploadSlot(async () => {
        const image = await trace.run('image_validation', () => imageUpload(request, (bytes, complete) => { state.bytes_received = bytes; state.body_complete = complete ?? false; }));
        const key = `images/${image.hash}.${image.extension}`;
        await trace.run('image_write', () => env.SITE_BUCKET.put(key, image.file.stream(), { httpMetadata: { contentType: image.type, cacheControl: IMAGE_CACHE } }));
        return reply({ ok: true, url: `${origin}/${key}` });
      });
    }
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    let origin = '';
    try { origin = originFor(request, env); }
    catch (error) { if (!(error instanceof HttpError && error.status === 503)) throw error; }
    return await trace.run('public_read', async () => {
      const metadata = await metadataResource(request, env.SITE_BUCKET, origin);
      if (metadata) return metadata;
      if (path === '/' || path === '/index.html') return publicObject(request, env, 'pages/index.html');
      if (/^\/images\/[a-f0-9]{64}\.(jpg|png|webp|gif)$/.test(path)) return publicObject(request, env, path.slice(1), true);
      throw new HttpError(404, 'Not found');
    });
  } catch (error) {
    const expected = error instanceof HttpError;
    const failure = expected ? error : new HttpError(500, publicationAttempted
      ? 'Unable to publish digest; publication may have completed. Retry the unchanged payload within the seven-day deduplication window.'
      : { digest: 'Unable to process digest', image: 'Unable to upload image', rebuild: 'Unable to complete rebuild request', read: 'Unable to load content' }[context.operation] ?? 'Unable to complete request', {}, {
        code: publicationAttempted ? 'publish_failed' : trace.stage === 'body_reading' ? 'body_read_failed' : trace.stage === 'image_write' || trace.stage === 'public_read' ? 'storage_error' : 'internal_error',
      });
    state.error_code = failure.code;
    if (context.operation === 'digest') state.publication_status = failure.publication_status ?? state.publication_status ?? 'not_attempted';
    const diagnostics = { stage: trace.stage, ...(state.bytes_received !== undefined ? { bytes_received: state.bytes_received, body_complete: state.body_complete ?? false } : {}), ...(state.body_sha256 ? { body_sha256: state.body_sha256 } : {}) };
    emit('request_error', context, { error_code: failure.code, status: failure.status, ...diagnostics, publication_status: state.publication_status,
      ...(Array.isArray(failure.details) ? { issues: failure.details.map(({ path, code }) => ({ path, code })), details_truncated: failure.details_truncated } : {}),
      ...(!expected ? safeError(error) : {}) }, failure.status >= 500 ? 'error' : 'warn');
    return reply({ ok: false, error: failure.message, code: failure.code, retryable: failure.retryable, details: failure.details, details_truncated: failure.details_truncated,
      diagnostics, ...(context.operation === 'digest' ? { publication_status: state.publication_status } : {}) }, failure.status, failure.headers);
  }
}

function routeFor(path: string): { route: string; operation: string } {
  if (path === '/api/digests') return { route: path, operation: 'digest' };
  if (path === '/api/images') return { route: path, operation: 'image' };
  if (/^\/api\/rebuild(?:\/[a-f0-9-]{36}(?:\/resume)?)?$/.test(path)) return { route: path === '/api/rebuild' ? path : path.endsWith('/resume') ? '/api/rebuild/:id/resume' : '/api/rebuild/:id', operation: 'rebuild' };
  if (path.startsWith('/api/') || path === '/api') return { route: '/api/*', operation: 'read' };
  return { route: path === '/' || path === '/index.html' ? '/' : path.startsWith('/images/') ? '/images/:file' : '/public/*', operation: 'read' };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const started = performance.now();
    const path = new URL(request.url).pathname;
    const route = routeFor(path);
    const ray = request.headers.get('cf-ray');
    const context: OperationContext = { request_id: crypto.randomUUID(), worker_version: env.CF_VERSION_METADATA?.id ?? 'local', environment: env.ENVIRONMENT ?? 'local', operation: route.operation,
      ...(ray && /^[a-f0-9]{16,32}(?:-[A-Z]{3})?$/.test(ray) ? { cf_ray: ray } : {}) };
    const state: RequestState = { context, trace: new OperationTrace(context) };
    const response = await handle(request, env, state);
    if (path === '/api' || path.startsWith('/api/')) {
      response.headers.set('X-Request-ID', context.request_id);
      response.headers.set('X-Worker-Version', context.worker_version);
      response.headers.set('X-API-Version', '2');
    }
    const media = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    emit('request_completed', context, { route: route.route, method: request.method, status: response.status, error_code: state.error_code,
      duration_ms: performance.now() - started, response_etag: response.headers.get('etag') ?? undefined, content_type: media && ['application/json', 'multipart/form-data', 'text/plain'].includes(media) ? media : 'other',
      bytes_received: state.bytes_received, body_complete: state.body_complete, body_sha256: state.body_sha256, counts: state.counts, post_id: state.post_id, publication_status: state.publication_status });
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
