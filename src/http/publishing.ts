import { fingerprint } from '../diagnostics';
import { boundary, declaredBodyBytes, failureError, isAppendReply, isPublishReply, OperationFailure } from '../errors';
import { validateEvents, type EventDigest } from '../events';
import { validateDryRun, validateItemIndex } from '../schemas/parameters';
import type { AppendReply, Digest, PublishReply, StoryUpdate } from '../types';
import { HttpError, isTimestamp, parseDigestJson, readLimited, validateDigest, validateUpdate } from '../validation';
import type { ApiServices } from './services';
type PublicationInput = { kind: 'digest' | 'event' } | { kind: 'append'; postId: string; itemIndex: string };

export async function submitPublication(services: ApiServices, inputKind: PublicationInput): Promise<Response> {
  const { request, env, state, context, trace, query, reply } = services;
  const append = inputKind.kind === 'append' ? inputKind : undefined;
  const events = inputKind.kind === 'event';
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed', { Allow: append ? 'POST' : 'GET, HEAD, POST' });
  await services.authenticate();
  state.dry_run = validateDryRun(query);
  state.bytes_received = 0;
  state.body_complete = false;
  state.declared_body_bytes = declaredBodyBytes(request);
  const origin = await services.origin();
  await trace.run('content_type', () => {
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Expected application/json', {}, { details: { expected: 'application/json' } });
  });
  const bytes = await trace.run('body_reading', () => readLimited(request, 1024 * 1024, bytes => { state.bytes_received = bytes; }));
  state.bytes_received = bytes.byteLength;
  state.body_complete = true;
  state.body_sha256 = fingerprint(new Uint8Array(bytes));
  const input = await trace.run('parsing', () => parseDigestJson(bytes));
  const payload = await trace.run('validation', () => {
    if (append) validateItemIndex(append.itemIndex);
    return events ? validateEvents(input) : append ? validateUpdate(input) : validateDigest(input, { requireItems: true });
  });
  const publisher = await services.publisher();
  state.publicationAttempted = !state.dry_run;
  state.publication_status = state.dry_run ? 'not_attempted' : 'unknown';
  const rpc = { transport_outcome: 'error' };
  const result = await trace.run('publisher_rpc', async () => {
    const received: unknown = await boundary('rpc', async () => events
      ? await publisher.publishEventsV1(payload as EventDigest, context, state.dry_run)
      : state.dry_run
      ? append ? await publisher.previewAppendV1(append.postId, Number(append.itemIndex), payload as StoryUpdate, origin, context)
        : await publisher.previewDigestV1(payload as Digest, origin, context)
      : append ? await publisher.appendUpdateV1(append.postId, Number(append.itemIndex), payload as StoryUpdate, origin, context)
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
