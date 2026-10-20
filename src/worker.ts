import { timingSafeEqual } from 'node:crypto';
import { matchesEtag, parseIfNoneMatch } from './conditions';
import { hashBytes, IMAGE_CACHE, imageUpload, withImageUploadSlot } from './images';
import { HTML_CACHE } from './publishing';
import { renderPage } from './render';
import { renderRss, RSS_TYPE } from './rss';
import { isIndexable, metadataResource } from './public-metadata';
import type { Env, OperationContext, PublicationStatus, PublishResult, RebuildJob } from './types';
import { emit, fingerprint, OperationTrace, safeError } from './diagnostics';
import { HttpError, parseDigestJson, readLimited, validateDigest } from './validation';
import { asHttpError, boundary, declaredBodyBytes, isPublishReply, OperationFailure, publicationFailure } from './errors';
import notFoundPage from './not-found.html';
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

async function publisherFor(env: Env, trace: OperationTrace) {
  return trace.run('publisher_lookup', async () => {
    const unavailableBinding = () => new HttpError(503, 'Publisher binding is not configured correctly', {}, { code: 'configuration_error', retryable: false });
    if (!env.PUBLISHER || typeof env.PUBLISHER.getByName !== 'function') {
      throw unavailableBinding();
    }
    const publisher = await boundary('rpc', () => env.PUBLISHER.getByName('site'));
    if (!publisher || !['object', 'function'].includes(typeof publisher)) throw unavailableBinding();
    return publisher;
  });
}

// Cache each empty representation per serving origin instead of hashing every request.
const fallbackPages = new Map<string, Promise<{ body: string; etag: string }>>();
function fallbackFor(origin: string, rss = false): Promise<{ body: string; etag: string }> {
  const key = `${origin}${rss ? '/rss.xml' : '/'}`;
  let page = fallbackPages.get(key);
  if (!page) {
    page = (async () => {
      const body = rss ? renderRss([], { origin }) : renderPage([], { origin });
      return { body, etag: `W/"${await hashBytes(new TextEncoder().encode(body))}"` };
    })();
    fallbackPages.set(key, page);
  }
  return page;
}

async function emptyResponse(request: Request, origin: string, rss = false): Promise<Response> {
  const { body, etag } = await fallbackFor(origin, rss);
  const unchanged = matchesEtag(parseIfNoneMatch(request.headers.get('if-none-match')), etag);
  return new Response(request.method === 'HEAD' || unchanged ? null : body, {
    status: unchanged ? 304 : 200,
    headers: { 'Cache-Control': HTML_CACHE, 'Cloudflare-CDN-Cache-Control': 'no-store',
      'Content-Type': rss ? RSS_TYPE : 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ETag: etag },
  });
}

function rssUnavailable(): HttpError {
  return new HttpError(503, 'RSS feed is temporarily unavailable. Please try again later.', { 'Retry-After': '60' });
}

async function publicObject(request: Request, env: Env, key: string, type: 'html' | 'image' | 'rss' = 'html'): Promise<Response> {
  const image = type === 'image';
  const condition = parseIfNoneMatch(request.headers.get('if-none-match'));
  const object = await boundary('storage', () => request.method === 'HEAD'
    ? env.SITE_BUCKET.head(key)
    : env.SITE_BUCKET.get(key, condition ? { onlyIf: new Headers({ 'If-None-Match': condition.header }) } : undefined));
  const headers = new Headers({ 'Cloudflare-CDN-Cache-Control': image ? IMAGE_CACHE : 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (!object) {
    if (type === 'rss') throw rssUnavailable();
    if (key !== 'pages/index.html') throw new HttpError(404, 'Not found');
    return emptyResponse(request, originFor(request, env));
  }
  object.writeHttpMetadata(headers);
  if (type === 'rss') headers.set('Content-Type', RSS_TYPE);
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
  declared_body_bytes?: number;
  body_sha256?: string;
  body_complete?: boolean;
  counts?: PublishResult['counts'];
  post_id?: string;
  publication_status?: PublicationStatus;
  publication_outcome?: 'published' | 'duplicate' | 'failed';
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
      const allowedMethod = maintenance[1] && !maintenance[2] ? 'GET' : 'POST';
      if (request.method !== allowedMethod) throw new HttpError(405, 'Method not allowed', { Allow: allowedMethod });
      if (!maintenance[1]) {
        const origin = await trace.run('configuration', () => originFor(request, env));
        const publisher = await publisherFor(env, trace);
        const job = await trace.run('enqueue_rebuild', () => boundary('rpc', () => publisher.enqueueRebuild(origin, context)));
        return reply({ ok: true, job }, 202);
      }
      const publisher = await publisherFor(env, trace);
      if (!maintenance[2]) {
        const job = await trace.run('rebuild_status', () => boundary('rpc', () => publisher.jobStatus(maintenance[1], context)));
        if (!job) throw new HttpError(404, 'Job not found', {}, { code: 'job_not_found' });
        return reply({ ok: true, job });
      }
      const job = await trace.run<RebuildJob | 'conflict' | null>('resume_rebuild', () => boundary('rpc', async () => await publisher.resumeRebuild(maintenance[1], context)));
      if (!job) throw new HttpError(404, 'Job not found', {}, { code: 'job_not_found' });
      if (job === 'conflict') throw new HttpError(409, 'Only a failed queue head or a stalled queued/running head without an alarm can resume', {}, { code: 'job_not_resumable' });
      return reply({ ok: true, job }, 202);
    }
    if (path === '/api/digests' || path === '/api/images') {
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed', { Allow: 'POST' });
      await trace.run('authentication', () => authenticate(request, env.API_SECRET));
      state.bytes_received = 0;
      state.body_complete = false;
      state.declared_body_bytes = declaredBodyBytes(request);
      const origin = await trace.run('configuration', () => originFor(request, env));
      if (path === '/api/digests') {
        await trace.run('content_type', () => {
          if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Expected application/json', {}, { details: { expected: 'application/json' } });
        });
        const bytes = await trace.run('body_reading', () => readLimited(request, 1024 * 1024, bytes => { state.bytes_received = bytes; }));
        state.bytes_received = bytes.byteLength;
        state.body_complete = true;
        state.body_sha256 = fingerprint(new Uint8Array(bytes));
        const input = await trace.run('parsing', () => parseDigestJson(bytes));
        const digest = await trace.run('validation', () => validateDigest(input, { requireItems: true }));
        const publisher = await publisherFor(env, trace);
        publicationAttempted = true;
        state.publication_status = 'unknown';
        const rpc = { transport_outcome: 'error' };
        const result = await trace.run('publisher_rpc', async () => {
          const received: unknown = await boundary('rpc', async () => await publisher.publishV2(digest, origin, context));
          rpc.transport_outcome = 'ok';
          if (!isPublishReply(received)) throw new OperationFailure('rpc', new Error('Invalid publisher reply'));
          if (!received.ok) {
            const f = received.failure;
            throw new HttpError(f.status, f.error, {}, { code: f.code, details: { stage: f.stage }, retryable: f.retryable, publication_status: f.publication_status });
          }
          return received.result;
        }, rpc);
        state.counts = result.counts;
        state.post_id = result.post?.id;
        state.publication_status = result.post ? 'committed' : undefined;
        state.publication_outcome = result.duplicate ? 'duplicate' : 'published';
        return reply({ ok: true, url: '/', ...result });
      }
      return await withImageUploadSlot(() => trace.run('upload_slot_held', async () => {
        const image = await trace.run('image_validation', () => imageUpload(request, (bytes, complete) => { state.bytes_received = bytes; state.body_complete = complete ?? false; }));
        const key = `images/${image.hash}.${image.extension}`;
        await trace.run('image_write', () => boundary('storage', () => env.SITE_BUCKET.put(key, image.file.stream(), { httpMetadata: { contentType: image.type, cacheControl: IMAGE_CACHE } })));
        return reply({ ok: true, url: `${origin}/${key}` });
      }), trace);
    }
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    let origin = '';
    try { origin = originFor(request, env); }
    catch (error) { if (!(error instanceof HttpError && error.status === 503)) throw error; }
    return await trace.run('public_read', async () => {
      const metadata = await metadataResource(request, env.SITE_BUCKET, origin);
      if (metadata) return metadata;
      if (path === '/rss.xml') {
        const index = await boundary('storage', () => env.SITE_BUCKET.head('pages/index.html'));
        if (!index) return emptyResponse(request, originFor(request, env), true);
        const key = index.customMetadata?.rss;
        if (!key || !/^publications\/[a-f0-9-]{36}\.rss\.xml$/.test(key)) throw rssUnavailable();
        return publicObject(request, env, key, 'rss');
      }
      if (path === '/' || path === '/index.html') return publicObject(request, env, 'pages/index.html');
      if (/^\/images\/[a-f0-9]{64}\.(jpg|png|webp|gif)$/.test(path)) return publicObject(request, env, path.slice(1), 'image');
      throw new HttpError(404, 'Not found');
    });
  } catch (error) {
    const expected = error instanceof HttpError;
    let failure = asHttpError(error);
    const detailStage = !Array.isArray(failure.details) && typeof failure.details.stage === 'string' ? failure.details.stage : undefined;
    const stage = detailStage ?? trace.failed_stage ?? trace.stage ?? 'request_processing';
    if (context.operation === 'digest') {
      state.publication_status = failure.publication_status ?? state.publication_status ?? 'not_attempted';
      state.publication_outcome = 'failed';
      if (publicationAttempted) {
        const f = publicationFailure(error, stage, state.publication_status);
        failure = new HttpError(f.status, f.error, failure.headers, { code: f.code, details: failure.details, retryable: f.retryable, publication_status: f.publication_status });
      }
    }
    state.error_code = failure.code;
    const diagnostics = { stage, ...(state.bytes_received !== undefined ? { bytes_received: state.bytes_received, body_complete: state.body_complete ?? false } : {}), ...(state.declared_body_bytes !== undefined ? { declared_body_bytes: state.declared_body_bytes } : {}), ...(state.body_sha256 ? { body_sha256: state.body_sha256 } : {}) };
    emit('request_error', context, { error_code: failure.code, status: failure.status, ...diagnostics, publication_status: state.publication_status, publication_outcome: state.publication_outcome,
      ...(Array.isArray(failure.details) ? { issues: failure.details.map(({ path, code }) => ({ path, code })), details_truncated: failure.details_truncated } : {}),
      ...(!expected || failure.status >= 500 ? safeError(error) : {}) }, failure.status >= 500 ? 'error' : 'warn');
    if (!isApi && failure.status === 404) return new Response(notFoundPage, { status: 404, headers: {
      ...failure.headers, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Cloudflare-CDN-Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex',
    } });
    if (!isApi) return json({ ok: false, error: failure.message }, failure.status, failure.headers);
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
      bytes_received: state.bytes_received, declared_body_bytes: state.declared_body_bytes, body_complete: state.body_complete, body_sha256: state.body_sha256, counts: state.counts, post_id: state.post_id, publication_status: state.publication_status, publication_outcome: state.publication_outcome });
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
