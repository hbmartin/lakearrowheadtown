import { isChangesReply } from './changes';
import { validRssKey } from './committed';
import { metadataKey } from './image-metadata';
import { pageResource } from './pages';
import { timingSafeEqual } from 'node:crypto';
import { matchesEtag, parseIfNoneMatch } from './conditions';
import { hashBytes, IMAGE_CACHE, imageUpload, withImageUploadSlot } from './images';
import { HTML_CACHE } from './publishing';
import { htmlResponse } from './html-response';
import { renderPage } from './render';
import { renderRss, RSS_TYPE } from './rss';
import { isAlertsReply, validateAlertInput, validateConfirmationBatch, type HistoryMode } from './alerts';
import { isPostsReply } from './posts';
import { isEventsReply, validateEvents, type EventDigest } from './events';
import { isRepairReply, validateRepair, type RepairInput } from './publication-repair';
import { publicationOperation, sourceMutation } from './operations';
import { errorSuggestion } from './suggestions';
import { isIndexable, metadataResource } from './public-metadata';
import type { AppendReply, Digest, Env, OperationContext, PublicationStatus, PublishReply, PublishResult, RebuildJob, StoryUpdate } from './types';
import { emit, fingerprint, OperationTrace, safeError } from './diagnostics';
import { HttpError, isTimestamp, parseDigestJson, readLimited, validateClientRef, validateDigest, validateUpdate } from './validation';
import { asHttpError, boundary, declaredBodyBytes, isAppendReply, isBatchReply, isPublishReply, isRetractReply, isRebuildResumeReply, OperationFailure, publicationFailure, failureError } from './errors';
import notFoundPage from './not-found';
import { noStoreHeaders } from './responses';
import { thumbnailResponse } from './thumbnails';
export { DigestPublisher } from './publisher';

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: noStoreHeaders('application/json', headers) });
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
  if (!image) headers.set('Content-Type', type === 'rss' ? RSS_TYPE : 'text/html; charset=utf-8');
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
  counts?: PublishResult['counts'] | { submitted: number; confirmed: number; duplicates: number; failed: number };
  post_id?: string;
  publication_status?: PublicationStatus;
  publication_outcome?: 'repaired' | 'unchanged' | 'published' | 'duplicate' | 'failed' | 'preview' | 'preview_failed' | 'retracted' | 'already_retracted';
  dry_run?: boolean;
}

async function jsonBytes(request: Request, state: RequestState, limit = 1024 * 1024): Promise<ArrayBuffer> {
  await state.trace.run('content_type', () => {
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Expected application/json');
  });
  state.bytes_received = 0; state.body_complete = false; state.declared_body_bytes = declaredBodyBytes(request);
  const bytes = await state.trace.run('body_reading', () => readLimited(request, limit, size => { state.bytes_received = size; }));
  state.bytes_received = bytes.byteLength; state.body_complete = true; state.body_sha256 = fingerprint(new Uint8Array(bytes));
  return bytes;
}

async function handle(request: Request, env: Env, state: RequestState): Promise<Response> {
  const { context, trace } = state;
  const path = new URL(request.url).pathname;
  const query = new URL(request.url).searchParams;
  const isApi = path === '/api' || path.startsWith('/api/');
  let publicationAttempted = false;
  const reply = (value: Record<string, unknown>, status = 200, headers: HeadersInit = {}) => json({ ...value, ...(isApi ? { request_id: context.request_id } : {}) }, status, headers);
  try {
    if (path === '/api/changes') {
      await trace.run('authentication', () => authenticate(request, env.API_SECRET));
      context.operation = 'changes_read';
      if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed', { Allow: 'GET, HEAD' });
      const publisher = await publisherFor(env, trace);
      const received: unknown = await trace.run('changes_read_rpc', () => boundary('rpc', () => publisher.readChangesV1(query.toString(), context)));
      if (!isChangesReply(received)) throw new OperationFailure('rpc', new Error('Invalid changes reply'));
      if (!received.ok) throw failureError(received.failure);
      return reply({ ok: true, ...received.result });
    }
    if (path === '/api/alerts/confirmations') {
      await trace.run('authentication', () => authenticate(request, env.API_SECRET));
      context.operation = 'alert_confirm';
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed', { Allow: 'POST' });
      if (query.getAll('dry_run').length > 1 || query.has('dry_run') && !['true', 'false'].includes(query.get('dry_run')!)) throw new HttpError(400, 'dry_run must be true or false.', {}, { code: 'invalid_dry_run' });
      state.dry_run = query.get('dry_run') === 'true';
      const bytes = await jsonBytes(request, state);
      const inputs = await trace.run('validation', () => validateConfirmationBatch(parseDigestJson(bytes)));
      const publisher = await publisherFor(env, trace);
      publicationAttempted = !state.dry_run; state.publication_status = state.dry_run ? 'not_attempted' : 'unknown';
      const received: unknown = await trace.run('alerts_rpc', () => boundary('rpc', () => publisher.confirmAlertsV1(inputs, context, state.dry_run)));
      if (!isAlertsReply(received)) throw new OperationFailure('rpc', new Error('Invalid confirmations reply'));
      if (!received.ok) throw failureError(received.failure);
      if (!('counts' in received.result) || !('confirmed' in received.result.counts)) throw new OperationFailure('rpc', new Error('Invalid confirmations result'));
      if (state.dry_run && (received.result.dry_run !== true || received.result.committed !== false || !isTimestamp(received.result.checked_at))) throw new OperationFailure('rpc', new Error('Invalid confirmations preview'));
      state.counts = received.result.counts;
      state.publication_status = state.dry_run || received.result.counts.failed && !received.result.counts.confirmed ? 'not_attempted' : received.result.counts.confirmed ? 'committed' : undefined;
      state.publication_outcome = state.dry_run ? 'preview' : received.result.counts.confirmed ? 'published' : received.result.counts.failed ? 'failed' : 'duplicate';
      return reply({ ok: true, ...received.result });
    }
    const alertRetraction = /^\/api\/alerts\/([^/]+)\/entries\/([^/]+)\/retract$/.exec(path);
    const alertRead = /^\/api\/alerts\/([^/]+)$/.exec(path);
    if (path === '/api/alerts' || alertRetraction || alertRead) {
      await trace.run('authentication', () => authenticate(request, env.API_SECRET));
      const reading = !alertRetraction && ['GET', 'HEAD'].includes(request.method);
      if (alertRead && !reading || !reading && request.method !== 'POST') throw new HttpError(405, 'Method not allowed', { Allow: alertRead ? 'GET, HEAD' : alertRetraction ? 'POST' : 'GET, HEAD, POST' });
      if (reading) context.operation = 'alerts_read';
      if (!reading) {
        if (query.getAll('dry_run').length > 1 || query.has('dry_run') && !['true', 'false'].includes(query.get('dry_run')!)) throw new HttpError(400, 'dry_run must be true or false.', {}, { code: 'invalid_dry_run' });
        state.dry_run = query.get('dry_run') === 'true';
      }
      if (!reading && (query.getAll('history').length > 1 || query.has('history') && !['full', 'coalesced'].includes(query.get('history')!))) throw new HttpError(400, 'history must be full or coalesced.', {}, { code: 'invalid_history' });
      const history = (query.get('history') ?? 'full') as HistoryMode;
      let payload;
      if (!reading && !alertRetraction) {
        const bytes = await jsonBytes(request, state);
        payload = await trace.run('validation', () => validateAlertInput(parseDigestJson(bytes)));
      }
      const publisher = await publisherFor(env, trace);
      publicationAttempted = !reading && !state.dry_run;
      if (!reading) state.publication_status = state.dry_run ? 'not_attempted' : 'unknown';
      const received: unknown = await trace.run('alerts_rpc', () => boundary('rpc', async () => reading
        ? await publisher.readAlertsV1(query.toString(), context, alertRead?.[1])
        : alertRetraction ? await publisher.retractAlertEntryV1(alertRetraction[1], alertRetraction[2], fingerprint(env.API_SECRET!), context, state.dry_run, history)
        : await publisher.submitAlertV1(payload!, fingerprint(env.API_SECRET!), context, state.dry_run, history)));
      if (!isAlertsReply(received)) throw new OperationFailure('rpc', new Error('Invalid alerts reply'));
      if (!received.ok) {
        throw failureError(received.failure);
      }
      if (!reading) {
        if (!('status' in received.result)) throw new OperationFailure('rpc', new Error('Invalid alert mutation reply'));
        if (state.dry_run && (received.result.dry_run !== true || received.result.committed !== false || !isTimestamp(received.result.checked_at))) throw new OperationFailure('rpc', new Error('Invalid alert preview reply'));
        state.publication_outcome = state.dry_run ? 'preview' : received.result.status === 'duplicate' ? 'duplicate' : received.result.status === 'already_retracted' ? 'already_retracted' : alertRetraction ? 'retracted' : 'published';
        state.publication_status = state.dry_run ? 'not_attempted' : ['duplicate', 'already_retracted'].includes(received.result.status) ? undefined : 'committed';
      }
      return reply({ ok: true, ...received.result });
    }
    if (path === '/api/events' && ['GET', 'HEAD'].includes(request.method)) {
      context.operation = 'events_read';
      await trace.run('authentication', () => authenticate(request, env.API_SECRET));
      const publisher = await publisherFor(env, trace);
      const received: unknown = await trace.run('events_read_rpc', () => boundary('rpc', async () => await publisher.readEventsV1(query.toString(), context)));
      if (!isEventsReply(received)) throw new OperationFailure('rpc', new Error('Invalid events reply'));
      if (!received.ok) throw failureError(received.failure);
      return reply({ ok: true, ...received.result });
    }
    const repairControl = /^\/api\/publication\/repair\/(resume|cancel)$/.exec(path);
    if (repairControl) {
      await trace.run('authentication', () => authenticate(request, env.API_SECRET));
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed', { Allow: 'POST' });
      const input = parseDigestJson(await jsonBytes(request, state, 16384));
      const publisher = await publisherFor(env, trace);
      const result: unknown = await boundary('rpc', () => publisher.publicationRepairControlV1(repairControl[1] as 'resume' | 'cancel', input, context));
      if (!isRepairReply(result)) throw new OperationFailure('rpc', new Error('Invalid repair response'));
      if (!result.ok) throw failureError(result.failure);
      return reply({ ok: true, ...result.result });
    }
    if (path === '/api/publication/repair') {
      await trace.run('authentication', () => authenticate(request, env.API_SECRET));
      if (!['GET', 'HEAD', 'POST'].includes(request.method)) throw new HttpError(405, 'Method not allowed', { Allow: 'GET, HEAD, POST' });
      if (query.has('dry_run')) throw new HttpError(400, 'dry_run is not supported for publication repair.', {}, { code: 'invalid_dry_run' });
      let input: RepairInput | undefined;
      const origin = await trace.run('configuration', () => originFor(request, env));
      if (request.method === 'POST') {
        const bytes = await jsonBytes(request, state, 16384);
        input = await trace.run('validation', () => validateRepair(parseDigestJson(bytes)));
      }
      const publisher = await publisherFor(env, trace);
      state.publication_status = input === undefined ? 'not_attempted' : 'unknown';
      const received: unknown = await trace.run('repair_rpc', () => boundary('rpc', async () => await publisher.publicationRepairV1(input, origin, context)));
      if (!isRepairReply(received)) throw new OperationFailure('rpc', new Error('Invalid publication repair reply'));
      if (!received.ok) {
        throw failureError(received.failure);
      }
      state.publication_status = input === undefined || received.result.unchanged ? 'not_attempted' : 'committed';
      state.publication_outcome = input === undefined ? undefined : received.result.unchanged ? 'unchanged' : 'repaired';
      return reply({ ok: true, ...received.result });
    }
    if (path === '/api/digests' && ['GET', 'HEAD'].includes(request.method)) {
      context.operation = 'batch_lookup';
      await trace.run('authentication', () => authenticate(request, env.API_SECRET));
      if (query.getAll('client_ref').length !== 1) throw new HttpError(400, 'Supply exactly one client_ref.');
      const clientRef = validateClientRef(query.get('client_ref'));
      const publisher = await publisherFor(env, trace);
      const received: unknown = await trace.run('batch_lookup_rpc', () => boundary('rpc', async () => await publisher.findBatchV1(clientRef, context)));
      if (!isBatchReply(received)) throw new OperationFailure('rpc', new Error('Invalid batch reply'));
      if (!received.ok) {
        throw failureError(received.failure);
      }
      return reply({ ok: true, ...received.result });
    }
    if (path === '/api/posts') {
      await trace.run('authentication', () => authenticate(request, env.API_SECRET));
      if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed', { Allow: 'GET, HEAD' });
      const publisher = await publisherFor(env, trace);
      const received: unknown = await trace.run('posts_read_rpc', () => boundary('rpc', async () => await publisher.readPostsV1(new URL(request.url).searchParams.toString(), context)));
      if (!isPostsReply(received)) throw new OperationFailure('rpc', new Error('Invalid posts reply'));
      if (!received.ok) {
        throw failureError(received.failure);
      }
      return reply({ ok: true, ...received.result });
    }
    const append = /^\/api\/posts\/([^/]+)\/items\/([^/]+)\/updates$/.exec(path);
    const retract = /^\/api\/posts\/([^/]+)\/retract$/.exec(path);
    if (retract) {
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed', { Allow: 'POST' });
      await trace.run('authentication', () => authenticate(request, env.API_SECRET));
      if (query.has('dry_run')) throw new HttpError(400, 'dry_run is not supported for retraction.', {}, { code: 'invalid_dry_run' });
      const origin = await trace.run('configuration', () => originFor(request, env));
      const publisher = await publisherFor(env, trace);
      publicationAttempted = true;
      state.publication_status = 'unknown';
      const received: unknown = await trace.run('retract_rpc', () => boundary('rpc', async () => await publisher.retractPostV1(retract[1], fingerprint(env.API_SECRET!), origin, context)));
      if (!isRetractReply(received)) throw new OperationFailure('rpc', new Error('Invalid retract reply'));
      if (!received.ok) {
        throw failureError(received.failure);
      }
      state.post_id = received.result.post_id;
      state.publication_status = received.result.status === 'retracted' ? 'committed' : undefined;
      state.publication_outcome = received.result.status;
      return reply({ ok: true, ...received.result });
    }
    const maintenance = /^\/api\/rebuild(?:\/([a-f0-9-]{36})(\/resume)?)?$/.exec(path);
    if (maintenance) {
      await trace.run('authentication', () => authenticate(request, env.API_SECRET));
      const allowedMethod = maintenance[1] && !maintenance[2] ? 'GET' : 'POST';
      if (request.method !== allowedMethod) throw new HttpError(405, 'Method not allowed', { Allow: allowedMethod });
      if (request.method === 'POST' && query.has('dry_run')) throw new HttpError(400, 'dry_run is not supported for rebuild operations.', {}, { code: 'invalid_dry_run' });
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
      const received: unknown = await trace.run('resume_rebuild', () => boundary('rpc', () => publisher.resumeRebuildV1(maintenance[1], context)));
      if (!isRebuildResumeReply(received)) throw new OperationFailure('rpc', new Error('Invalid rebuild resume reply'));
      if (!received.ok) throw failureError(received.failure);
      const job = received.result;
      if (!job) throw new HttpError(404, 'Job not found', {}, { code: 'job_not_found' });
      if (job === 'conflict') throw new HttpError(409, 'Only a failed queue head, an explicitly paused head, or an unscheduled queued/running head can resume; active scheduled heads cannot resume', {}, { code: 'job_not_resumable' });
      return reply({ ok: true, job }, 202);
    }
    if (path === '/api/digests' || path === '/api/events' || path === '/api/images' || append) {
      const events = path === '/api/events';
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed', { Allow: path === '/api/digests' || events ? 'GET, HEAD, POST' : 'POST' });
      await trace.run('authentication', () => authenticate(request, env.API_SECRET));
      if (path === '/api/images' && query.has('dry_run')) throw new HttpError(400, 'dry_run is not supported for image uploads.', {}, { code: 'invalid_dry_run' });
      if (path === '/api/digests' || events || append) {
        if (query.getAll('dry_run').length > 1 || query.has('dry_run') && !['true', 'false'].includes(query.get('dry_run')!)) {
          throw new HttpError(400, 'dry_run must be true or false.', {}, { code: 'invalid_dry_run' });
        }
        state.dry_run = query.get('dry_run') === 'true';
      }
      state.bytes_received = 0;
      state.body_complete = false;
      state.declared_body_bytes = declaredBodyBytes(request);
      const origin = await trace.run('configuration', () => originFor(request, env));
      if (path === '/api/digests' || events || append) {
        await trace.run('content_type', () => {
          if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Expected application/json', {}, { details: { expected: 'application/json' } });
        });
        const bytes = await trace.run('body_reading', () => readLimited(request, 1024 * 1024, bytes => { state.bytes_received = bytes; }));
        state.bytes_received = bytes.byteLength;
        state.body_complete = true;
        state.body_sha256 = fingerprint(new Uint8Array(bytes));
        const input = await trace.run('parsing', () => parseDigestJson(bytes));
        const payload = await trace.run('validation', () => {
          if (append && (!/^(?:0|[1-9][0-9]*)$/.test(append[2]) || !Number.isSafeInteger(Number(append[2])))) throw new HttpError(400, 'item_index must be a nonnegative safe integer.');
          return events ? validateEvents(input) : append ? validateUpdate(input) : validateDigest(input, { requireItems: true });
        });
        const publisher = await publisherFor(env, trace);
        publicationAttempted = !state.dry_run;
        state.publication_status = state.dry_run ? 'not_attempted' : 'unknown';
        const rpc = { transport_outcome: 'error' };
        const result = await trace.run('publisher_rpc', async () => {
          const received: unknown = await boundary('rpc', async () => events
            ? await publisher.publishEventsV1(payload as EventDigest, context, state.dry_run)
            : state.dry_run
            ? append ? await publisher.previewAppendV1(append[1], Number(append[2]), payload as StoryUpdate, origin, context)
              : await publisher.previewDigestV1(payload as Digest, origin, context)
            : append ? await publisher.appendUpdateV1(append[1], Number(append[2]), payload as StoryUpdate, origin, context)
              : await publisher.publishV2(payload as Digest, origin, context, fingerprint(env.API_SECRET!)));
          rpc.transport_outcome = 'ok';
          if (!(append ? isAppendReply(received) : isPublishReply(received))) throw new OperationFailure('rpc', new Error('Invalid publisher reply'));
          const receivedReply = received as AppendReply | PublishReply;
          if (!receivedReply.ok) {
            throw failureError(receivedReply.failure);
          }
          if (state.dry_run && (receivedReply.result.dry_run !== true || receivedReply.result.committed !== false || !isTimestamp(receivedReply.result.checked_at))) {
            throw new OperationFailure('rpc', new Error('Invalid preview reply'));
          }
          return receivedReply.result;
        }, rpc);
        if ('status' in result) {
          state.post_id = result.post_id;
          state.publication_status = result.status === 'appended' ? 'committed' : undefined;
          state.publication_outcome = result.status === 'duplicate' ? 'duplicate' : 'published';
        } else {
          state.counts = result.counts;
          state.post_id = result.post?.id;
          state.publication_status = result.post ? 'committed' : undefined;
          state.publication_outcome = result.duplicate ? 'duplicate' : 'published';
        }
        if (state.dry_run) {
          state.publication_status = 'not_attempted';
          state.publication_outcome = 'preview';
        }
        return reply({ ok: true, url: events ? '/calendar/' : '/', ...result });
      }
      return await withImageUploadSlot(() => trace.run('upload_slot_held', async () => {
        const image = await trace.run('image_validation', () => imageUpload(request, (bytes, complete) => { state.bytes_received = bytes; state.body_complete = complete ?? false; }));
        const key = `images/${image.hash}.${image.extension}`;
        await trace.run('image_write', () => boundary('storage', () => env.SITE_BUCKET.put(key, image.file.stream(), { httpMetadata: { contentType: image.type, cacheControl: IMAGE_CACHE } })));
        await trace.run('image_metadata_write', () => boundary('storage', () => env.SITE_BUCKET.put(metadataKey(image.hash), JSON.stringify(image.metadata), { httpMetadata: { contentType: 'application/json' } })));
        return reply({ ok: true, url: `${origin}/${key}`, width: image.metadata.width, height: image.metadata.height });
      }), trace);
    }
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    let origin = '';
    try { origin = originFor(request, env); }
    catch (error) { if (!(error instanceof HttpError && error.status === 503)) throw error; }
    return await trace.run('public_read', async () => {
      if (path.startsWith('/thumbnails/')) return thumbnailResponse(request, env, trace);
      const metadata = await metadataResource(request, env.SITE_BUCKET, origin);
      if (metadata) return metadata;
      const page = await pageResource(request, env.SITE_BUCKET, origin);
      if (page) return page;
      if (path === '/rss.xml') {
        const index = await boundary('storage', () => env.SITE_BUCKET.head('pages/index.html'));
        if (!index) return emptyResponse(request, originFor(request, env), true);
        const key = index.customMetadata?.rss;
        if (!validRssKey(key)) throw rssUnavailable();
        return publicObject(request, env, key, 'rss');
      }
      if (path === '/' || path === '/index.html') return publicObject(request, env, 'pages/index.html');
      if (/^\/assets\/daily\/[a-f0-9]{64}\.png$/.test(path)) return publicObject(request, env, path.slice(1), 'image');
      if (/^\/images\/[a-f0-9]{64}\.(jpg|png|webp|gif)$/.test(path)) return publicObject(request, env, path.slice(1), 'image');
      throw new HttpError(404, 'Not found');
    });
  } catch (error) {
    const expected = error instanceof HttpError;
    let failure = asHttpError(error);
    const detailStage = !Array.isArray(failure.details) && typeof failure.details.stage === 'string' ? failure.details.stage : undefined;
    const stage = failure.stage ?? detailStage ?? trace.failed_stage ?? trace.stage ?? 'request_processing';
    if (sourceMutation(context.operation) || context.operation === 'publication_repair') {
      state.publication_status = failure.publication_status ?? state.publication_status ?? 'not_attempted';
      state.publication_outcome = state.dry_run ? 'preview_failed' : 'failed';
      if (state.dry_run) state.publication_status = 'not_attempted';
      if (publicationAttempted && (sourceMutation(context.operation))) {
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

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const origin = env.SITE_ORIGIN || 'https://lakearrowheadtown-preview.harold-martin.workers.dev';
    await env.PUBLISHER.getByName('site').pullWeatherV1(origin);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const started = performance.now();
    const path = new URL(request.url).pathname;
    const route = routeFor(path, request.method);
    const ray = request.headers.get('cf-ray');
    const context: OperationContext = { request_id: crypto.randomUUID(), worker_version: env.CF_VERSION_METADATA?.id ?? 'local', environment: env.ENVIRONMENT ?? 'local', operation: route.operation,
      ...(ray && /^[a-f0-9]{16,32}(?:-[A-Z]{3})?$/.test(ray) ? { cf_ray: ray } : {}) };
    const state: RequestState = { context, trace: new OperationTrace(context) };
    const response = htmlResponse(request, await handle(request, env, state));
    if (path === '/api' || path.startsWith('/api/')) {
      response.headers.set('X-Request-ID', context.request_id);
      response.headers.set('X-Worker-Version', context.worker_version);
      response.headers.set('X-API-Version', '3');
    }
    const media = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    emit('request_completed', context, { route: route.route, method: request.method, status: response.status, error_code: state.error_code,
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
  },
} satisfies ExportedHandler<Env>;
