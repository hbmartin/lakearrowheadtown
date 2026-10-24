import { Hono } from 'hono';
import { boundary, failureError, OperationFailure } from '../errors';
import { isEventsReply } from '../events';
import { submitPublication } from './publishing';
import type { AppEnv } from './services';
export const events = new Hono<AppEnv>()
  .get('/events', async c => {
    const services = c.var.services;
    const { context, trace, query, reply } = services;

    context.operation = 'events_read';
    await services.authenticate();
    const publisher = await services.publisher();
    const received: unknown = await trace.run('events_read_rpc', () => boundary('rpc', async () => await publisher.readEventsV1(query.toString(), context)));
    if (!isEventsReply(received)) throw new OperationFailure('rpc', new Error('Invalid events reply'));
    if (!received.ok) throw failureError(received.failure);
    return reply({ ok: true, ...received.result });
  })
  .all('/events', c => submitPublication(c.var.services, { kind: 'event' }));
