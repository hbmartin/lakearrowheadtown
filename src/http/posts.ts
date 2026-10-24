import { Hono } from 'hono';
import { fingerprint } from '../diagnostics';
import { boundary, failureError, isRetractReply, OperationFailure } from '../errors';
import { isPostsReply } from '../posts';
import { HttpError } from '../validation';
import { submitPublication } from './publishing';
import type { AppEnv } from './services';
export const posts = new Hono<AppEnv>()
  .all('/posts', async c => {
    const services = c.var.services;
    const { request, context, trace, reply } = services;

    await services.authenticate();
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    const publisher = await services.publisher();
    const received: unknown = await trace.run('posts_read_rpc', () => boundary('rpc', async () => await publisher.readPostsV1(new URL(request.url).searchParams.toString(), context)));
    if (!isPostsReply(received)) throw new OperationFailure('rpc', new Error('Invalid posts reply'));
    if (!received.ok) {
      throw failureError(received.failure);
    }
    return reply({ ok: true, ...received.result });
  })
  .all('/posts/:id/retract', async c => {
    const services = c.var.services;
    const { request, env, state, context, trace, query, reply } = services;
    const path = new URL(request.url).pathname;
    const retract = /^\/api\/posts\/([^/]+)\/retract$/.exec(path)!;
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed', { Allow: 'POST' });
    await services.authenticate();
    if (query.has('dry_run')) throw new HttpError(400, 'dry_run is not supported for retraction.', {}, { code: 'invalid_dry_run' });
    const origin = await services.origin();
    const publisher = await services.publisher();
    state.publicationAttempted = true;
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
  })
  .all('/posts/:id/items/:index/updates', c => {
    // Hono decodes params; API v3 passes the raw URL segments through unchanged.
    const parts = new URL(c.req.raw.url).pathname.split('/');
    return submitPublication(c.var.services, { kind: 'append', postId: parts[3], itemIndex: parts[5] });
  });
