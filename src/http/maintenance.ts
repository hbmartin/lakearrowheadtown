import { Hono } from 'hono';
import { createFactory } from 'hono/factory';
import { boundary, failureError, isRebuildResumeReply, OperationFailure } from '../errors';
import { isRepairReply, validateRepair, type RepairInput } from '../publication-repair';
import { HttpError, parseDigestJson } from '../validation';
import { jsonBytes, type AppEnv } from './services';
const rebuildHandlers = createFactory<AppEnv>().createHandlers(async c => {
  const services = c.var.services;
  const { request, context, trace, query, reply } = services;
  const path = new URL(request.url).pathname;
  const maintenance = /^\/api\/rebuild(?:\/([a-f0-9-]{36})(\/resume)?)?$/.exec(path)!;
  await services.authenticate();
  const allowedMethod = maintenance[1] && !maintenance[2] ? 'GET' : 'POST';
  if (request.method !== allowedMethod) throw new HttpError(405, 'Method not allowed', { Allow: allowedMethod });
  if (request.method === 'POST' && query.has('dry_run')) throw new HttpError(400, 'dry_run is not supported for rebuild operations.', {}, { code: 'invalid_dry_run' });
  if (!maintenance[1]) {
    const origin = await services.origin();
    const publisher = await services.publisher();
    const job = await trace.run('enqueue_rebuild', () => boundary('rpc', () => publisher.enqueueRebuild(origin, context)));
    return reply({ ok: true, job }, 202);
  }
  const publisher = await services.publisher();
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
});
const controlHandlers = createFactory<AppEnv>().createHandlers(async c => {
  const services = c.var.services;
  const { request, state, context, reply } = services;
  const path = new URL(request.url).pathname;
  const repairControl = /^\/api\/publication\/repair\/(resume|cancel)$/.exec(path)!;
  await services.authenticate();
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed', { Allow: 'POST' });
  const input = parseDigestJson(await jsonBytes(request, state, 16384));
  const publisher = await services.publisher();
  const result: unknown = await boundary('rpc', () => publisher.publicationRepairControlV1(repairControl[1] as 'resume' | 'cancel', input, context));
  if (!isRepairReply(result)) throw new OperationFailure('rpc', new Error('Invalid repair response'));
  if (!result.ok) throw failureError(result.failure);
  return reply({ ok: true, ...result.result });
});
export const maintenance = new Hono<AppEnv>()
  .all('/rebuild', ...rebuildHandlers)
  .all('/rebuild/:id{[a-f0-9-]{36}}', ...rebuildHandlers)
  .all('/rebuild/:id{[a-f0-9-]{36}}/resume', ...rebuildHandlers)
  .all('/publication/repair/resume', ...controlHandlers)
  .all('/publication/repair/cancel', ...controlHandlers)
  .all('/publication/repair', async c => {
    const services = c.var.services;
    const { request, state, context, trace, query, reply } = services;

    await services.authenticate();
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) throw new HttpError(405, 'Method not allowed', { Allow: 'GET, HEAD, POST' });
    if (query.has('dry_run')) throw new HttpError(400, 'dry_run is not supported for publication repair.', {}, { code: 'invalid_dry_run' });
    let input: RepairInput | undefined;
    const origin = await services.origin();
    if (request.method === 'POST') {
      const bytes = await jsonBytes(request, state, 16384);
      input = await trace.run('validation', () => validateRepair(parseDigestJson(bytes)));
    }
    const publisher = await services.publisher();
    state.publication_status = input === undefined ? 'not_attempted' : 'unknown';
    const received: unknown = await trace.run('repair_rpc', () => boundary('rpc', async () => await publisher.publicationRepairV1(input, origin, context)));
    if (!isRepairReply(received)) throw new OperationFailure('rpc', new Error('Invalid publication repair reply'));
    if (!received.ok) {
      throw failureError(received.failure);
    }
    state.publication_status = input === undefined || received.result.unchanged ? 'not_attempted' : 'committed';
    state.publication_outcome = input === undefined ? undefined : received.result.unchanged ? 'unchanged' : 'repaired';
    return reply({ ok: true, ...received.result });
  });
