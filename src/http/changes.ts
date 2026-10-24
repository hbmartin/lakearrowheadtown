import { Hono } from 'hono';
import { isChangesReply } from '../changes';
import { boundary, failureError, OperationFailure } from '../errors';
import { HttpError } from '../validation';
import type { AppEnv } from './services';
export const changes = new Hono<AppEnv>().all('/changes', async c => {
  const services = c.var.services;
  const { request, context, trace, query, reply } = services;

  await services.authenticate();
  context.operation = 'changes_read';
  if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed', { Allow: 'GET, HEAD' });
  const publisher = await services.publisher();
  const received: unknown = await trace.run('changes_read_rpc', () => boundary('rpc', () => publisher.readChangesV1(query.toString(), context)));
  if (!isChangesReply(received)) throw new OperationFailure('rpc', new Error('Invalid changes reply'));
  if (!received.ok) throw failureError(received.failure);
  return reply({ ok: true, ...received.result });
});
