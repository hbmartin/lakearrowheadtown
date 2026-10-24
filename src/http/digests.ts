import { Hono } from 'hono';
import { boundary, failureError, isBatchReply, OperationFailure } from '../errors';
import { requireClientRef } from '../schemas/parameters';
import { validateClientRef } from '../validation';
import { submitPublication } from './publishing';
import type { AppEnv } from './services';
export const digests = new Hono<AppEnv>()
  .get('/digests', async c => {
    const services = c.var.services;
    const { context, trace, query, reply } = services;

    context.operation = 'batch_lookup';
    await services.authenticate();
    requireClientRef(query);
    const clientRef = validateClientRef(query.get('client_ref'));
    const publisher = await services.publisher();
    const received: unknown = await trace.run('batch_lookup_rpc', () => boundary('rpc', async () => await publisher.findBatchV1(clientRef, context)));
    if (!isBatchReply(received)) throw new OperationFailure('rpc', new Error('Invalid batch reply'));
    if (!received.ok) {
      throw failureError(received.failure);
    }
    return reply({ ok: true, ...received.result });
  })
  .all('/digests', c => submitPublication(c.var.services, { kind: 'digest' }));
