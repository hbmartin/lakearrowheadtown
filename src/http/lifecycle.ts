import { emit, OperationTrace, safeError } from '../diagnostics';
import { asHttpError, publicationFailure } from '../errors';
import { htmlResponse } from '../html-response';
import notFoundPage from '../not-found';
import { sourceMutation } from '../operations';
import { isIndexable } from '../public-metadata';
import { noStoreHeaders } from '../responses';
import { errorSuggestion } from '../suggestions';
import type { Env, OperationContext, PublicationStatus, PublishResult } from '../types';
import { HttpError } from '../validation';

export function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: noStoreHeaders('application/json', headers) });
}

export function originFor(request: Request, env: Env): string {
  try {
    const url = new URL(env.SITE_ORIGIN || new URL(request.url).origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid origin');
    return url.origin;
  } catch { throw new HttpError(503, 'Site origin is not configured correctly', {}, { code: 'configuration_error' }); }
}

export interface RequestState {
  started: number;
  route: string;
  publicationAttempted: boolean;
  context: OperationContext;
  trace: OperationTrace;
  error_code?: string;
  bytes_received?: number;
  declared_body_bytes?: number;
  body_sha256?: string;
  body_complete?: boolean;
  counts?: PublishResult['counts'] | { submitted: number; confirmed: number; duplicates: number; failed: number };
  post_id?: string;
  publication_status?: PublicationStatus;
  publication_outcome?: 'repaired' | 'unchanged' | 'published' | 'duplicate' | 'failed' | 'preview' | 'preview_failed' | 'retracted' | 'already_retracted';
  dry_run?: boolean;
}

export function errorResponse(error: unknown, request: Request, state: RequestState): Response {
  const { context, trace } = state;
  const path = new URL(request.url).pathname;
  const isApi = path === '/api' || path.startsWith('/api/');
  const reply = (value: Record<string, unknown>, status: number, headers: HeadersInit) => json({ ...value, request_id: context.request_id }, status, headers);
  const expected = error instanceof HttpError;
  let failure = asHttpError(error);
  const detailStage = !Array.isArray(failure.details) && typeof failure.details.stage === 'string' ? failure.details.stage : undefined;
  const stage = failure.stage ?? detailStage ?? trace.failed_stage ?? trace.stage ?? 'request_processing';
  if (sourceMutation(context.operation) || context.operation === 'publication_repair') {
    state.publication_status = failure.publication_status ?? state.publication_status ?? 'not_attempted';
    state.publication_outcome = state.dry_run ? 'preview_failed' : 'failed';
    if (state.dry_run) state.publication_status = 'not_attempted';
    if (state.publicationAttempted && (sourceMutation(context.operation))) {
      const f = publicationFailure(error, stage, state.publication_status, context.operation);
      failure = new HttpError(f.status, f.error, failure.headers, { code: f.code, details: failure.details, details_truncated: failure.details_truncated, retryable: f.retryable, publication_status: f.publication_status, retry_at: f.retry_at });
    }
  }
  state.error_code = failure.code;
  const diagnostics = { stage, ...(state.bytes_received !== undefined ? { bytes_received: state.bytes_received, body_complete: state.body_complete ?? false } : {}), ...(state.declared_body_bytes !== undefined ? { declared_body_bytes: state.declared_body_bytes } : {}), ...(state.body_sha256 ? { body_sha256: state.body_sha256 } : {}) };
  emit('request_error', context, { error_code: failure.code, status: failure.status, ...diagnostics, publication_status: state.publication_status, publication_outcome: state.publication_outcome,
    ...(Array.isArray(failure.details) ? { issues: failure.details.map(({ path, code }) => ({ path, code })), details_truncated: failure.details_truncated } : {}),
    ...(!expected || failure.status >= 500 ? safeError(error) : {}) }, failure.status >= 500 && failure.code !== 'confirmations_not_enabled' ? 'error' : 'warn');
  if (!isApi && failure.status === 404) {
    const headers = noStoreHeaders('text/html; charset=utf-8', failure.headers);
    headers.set('X-Robots-Tag', 'noindex');
    return new Response(notFoundPage, { status: 404, headers });
  }
  if (!isApi) return json({ ok: false, error: failure.message }, failure.status, failure.headers);
  return reply({ ok: false, error: failure.message, message: failure.message, suggestion: errorSuggestion(failure.code, failure.retryable, state.dry_run, context.operation, state.publication_status), code: failure.code, retryable: failure.retryable, details: failure.details, details_truncated: failure.details_truncated,
    diagnostics, ...(failure.retry_at ? { retry_at: failure.retry_at } : {}), ...(state.dry_run ? { dry_run: true, committed: false } : {}), ...(sourceMutation(context.operation) || context.operation === 'publication_repair' ? { publication_status: state.publication_status } : {}) }, failure.status, failure.headers);
}

function routeFor(path: string, method: string): { route: string; operation: string } {
  if (path === '/api/changes') return { route: path, operation: 'changes_read' };
  if (path === '/api/events') return { route: path, operation: ['GET', 'HEAD'].includes(method) ? 'events_read' : 'event' };
  if (path === '/api/alerts/confirmations') return { route: path, operation: 'alert_confirm' };
  if (/^\/api\/alerts\/[^/]+$/.test(path)) return { route: '/api/alerts/:id', operation: 'alerts_read' };
  if (path === '/api/alerts') return { route: path, operation: ['GET', 'HEAD'].includes(method) ? 'alerts_read' : 'alert' };
  if (/^\/api\/alerts\/[^/]+\/entries\/[^/]+\/retract$/.test(path)) return { route: '/api/alerts/:id/entries/:entry/retract', operation: 'alert_retract' };
  if (/^\/api\/publication\/repair(?:\/(?:resume|cancel))?$/.test(path)) return { route: path, operation: 'publication_repair' };
  if (path === '/api/digests') return { route: path, operation: 'digest' };
  if (path === '/api/images') return { route: path, operation: 'image' };
  if (path === '/api/posts') return { route: path, operation: 'posts_read' };
  if (/^\/api\/posts\/[^/]+\/items\/[^/]+\/updates$/.test(path)) return { route: '/api/posts/:id/items/:index/updates', operation: 'append' };
  if (/^\/api\/posts\/[^/]+\/retract$/.test(path)) return { route: '/api/posts/:id/retract', operation: 'retract' };
  if (/^\/api\/rebuild(?:\/[a-f0-9-]{36}(?:\/resume)?)?$/.test(path)) return { route: path === '/api/rebuild' ? path : path.endsWith('/resume') ? '/api/rebuild/:id/resume' : '/api/rebuild/:id', operation: 'rebuild' };
  if (path.startsWith('/api/') || path === '/api') return { route: '/api/*', operation: 'read' };
  if (path.startsWith('/thumbnails/')) return { route: path.startsWith('/thumbnails/v2/') ? '/thumbnails/v2/:file/:edge.:format' : '/thumbnails/v1/:file/:edge', operation: 'read' };
  return { route: path === '/' || path === '/index.html' ? '/' : path.startsWith('/images/') ? '/images/:file' : '/public/*', operation: 'read' };
}

export function beginRequest(request: Request, env: Env): RequestState {
  const started = performance.now();
  const path = new URL(request.url).pathname;
  const route = routeFor(path, request.method);
  const ray = request.headers.get('cf-ray');
  const context: OperationContext = { request_id: crypto.randomUUID(), worker_version: env.CF_VERSION_METADATA?.id ?? 'local', environment: env.ENVIRONMENT ?? 'local', operation: route.operation,
    ...(ray && /^[a-f0-9]{16,32}(?:-[A-Z]{3})?$/.test(ray) ? { cf_ray: ray } : {}) };
  return { started, route: route.route, publicationAttempted: false, context, trace: new OperationTrace(context) };
}

export async function finishRequest(request: Request, env: Env, state: RequestState, received: Response): Promise<Response> {
  const { context, started } = state;
  const path = new URL(request.url).pathname;
  const response = htmlResponse(request, received);
  if (path === '/api' || path.startsWith('/api/')) {
    response.headers.set('X-Request-ID', context.request_id);
    response.headers.set('X-Worker-Version', context.worker_version);
    response.headers.set('X-API-Version', '3');
  }
  const media = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  emit('request_completed', context, { route: state.route, method: request.method, status: response.status, error_code: state.error_code,
    duration_ms: performance.now() - started, response_etag: response.headers.get('etag') ?? undefined, content_type: media && ['application/json', 'multipart/form-data', 'text/plain'].includes(media) ? media : 'other',
    bytes_received: state.bytes_received, declared_body_bytes: state.declared_body_bytes, body_complete: state.body_complete, body_sha256: state.body_sha256, counts: state.counts, post_id: state.post_id, publication_status: state.publication_status, publication_outcome: state.publication_outcome, dry_run: state.dry_run });
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
}
