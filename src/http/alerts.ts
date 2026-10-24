import { Hono } from 'hono';
import { createFactory } from 'hono/factory';
import { isAlertsReply, validateAlertInput, validateConfirmationBatch, type HistoryMode } from '../alerts';
import { fingerprint } from '../diagnostics';
import { boundary, failureError, OperationFailure } from '../errors';
import { validateDryRun, validateHistory } from '../schemas/parameters';
import { HttpError, isTimestamp, parseDigestJson } from '../validation';
import { jsonBytes, type AppEnv } from './services';
const alertHandlers = createFactory<AppEnv>().createHandlers(async c => {
  const services = c.var.services;
  const { request, env, state, context, trace, query, reply } = services;
  const path = new URL(request.url).pathname;
  const alertRetraction = /^\/api\/alerts\/([^/]+)\/entries\/([^/]+)\/retract$/.exec(path);
  const alertRead = /^\/api\/alerts\/([^/]+)$/.exec(path);
  await services.authenticate();
  const reading = !alertRetraction && ['GET', 'HEAD'].includes(request.method);
  if (alertRead && !reading || !reading && request.method !== 'POST') throw new HttpError(405, 'Method not allowed', { Allow: alertRead ? 'GET, HEAD' : alertRetraction ? 'POST' : 'GET, HEAD, POST' });
  if (reading) context.operation = 'alerts_read';
  if (!reading) {
    state.dry_run = validateDryRun(query);
  }
  const history = reading ? (query.get('history') ?? 'full') as HistoryMode : validateHistory(query);
  let payload;
  if (!reading && !alertRetraction) {
    const bytes = await jsonBytes(request, state);
    payload = await trace.run('validation', () => validateAlertInput(parseDigestJson(bytes)));
  }
  const publisher = await services.publisher();
  state.publicationAttempted = !reading && !state.dry_run;
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
});
export const alerts = new Hono<AppEnv>()
  .all('/alerts/confirmations', async c => {
    const services = c.var.services;
    const { request, state, context, trace, query, reply } = services;

    await services.authenticate();
    context.operation = 'alert_confirm';
    if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed', { Allow: 'POST' });
    state.dry_run = validateDryRun(query);
    const bytes = await jsonBytes(request, state);
    const inputs = await trace.run('validation', () => validateConfirmationBatch(parseDigestJson(bytes)));
    const publisher = await services.publisher();
    state.publicationAttempted = !state.dry_run; state.publication_status = state.dry_run ? 'not_attempted' : 'unknown';
    const received: unknown = await trace.run('alerts_rpc', () => boundary('rpc', () => publisher.confirmAlertsV1(inputs, context, state.dry_run)));
    if (!isAlertsReply(received)) throw new OperationFailure('rpc', new Error('Invalid confirmations reply'));
    if (!received.ok) throw failureError(received.failure);
    if (!('counts' in received.result) || !('confirmed' in received.result.counts)) throw new OperationFailure('rpc', new Error('Invalid confirmations result'));
    if (state.dry_run && (received.result.dry_run !== true || received.result.committed !== false || !isTimestamp(received.result.checked_at))) throw new OperationFailure('rpc', new Error('Invalid confirmations preview'));
    state.counts = received.result.counts;
    state.publication_status = state.dry_run || received.result.counts.failed && !received.result.counts.confirmed ? 'not_attempted' : received.result.counts.confirmed ? 'committed' : undefined;
    state.publication_outcome = state.dry_run ? 'preview' : received.result.counts.confirmed ? 'published' : received.result.counts.failed ? 'failed' : 'duplicate';
    return reply({ ok: true, ...received.result });
  })
  .all('/alerts', ...alertHandlers)
  .all('/alerts/:id', ...alertHandlers)
  .all('/alerts/:id/entries/:entry/retract', ...alertHandlers);
