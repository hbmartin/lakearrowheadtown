import { asHttpError, HttpError } from './errors';
import type { PublicationStatus, RebuildBlocker } from './types';

const states: Record<string, { reason: RebuildBlocker['reason']; stopAlarm: boolean; message: string }> = {
  repair_pending: { reason: 'repair_pending', stopAlarm: true, message: 'Retry the identical repair request after retry_at to recover its result and regeneration job.' },
  repair_stalled: { reason: 'repair_stalled', stopAlarm: true, message: 'Inspect publication repair recovery, correct its cause, then explicitly resume it.' },
  rebuild_checkpoint_damaged: { reason: 'rebuild_checkpoint_damaged', stopAlarm: true, message: 'Inspect repair and rebuild recovery. Restore the matching finalization checkpoint or generation evidence from a verified backup, then explicitly resume the blocked recovery.' },
  repair_journal_damaged: { reason: 'repair_damaged', stopAlarm: false, message: 'Restore the active repair journal and its referenced record from a verified backup before resuming.' },
};

export const repairErrorState = (code: string) => Object.hasOwn(states, code) ? states[code] : undefined;

export interface RepairFailureContext { publication_status: PublicationStatus; repair_id?: string; job_id?: string }

/** Enrich the envelope without discarding the original exception's prototype or diagnostics. */
export function repairFailure(error: unknown, context: RepairFailureContext, completion?: { retry_at?: string }): HttpError {
  let failure = asHttpError(error);
  if (completion && context.publication_status === 'committed' && failure.code === 'storage_error' && failure.retryable) {
    failure = new HttpError(503, 'Repair committed; retry the identical request to recover its result.', {}, {
      code: 'repair_pending', retryable: true, publication_status: 'committed',
      retry_at: completion.retry_at && Date.parse(completion.retry_at) > Date.now() ? completion.retry_at : new Date(Date.now() + 1000).toISOString(),
    });
  }
  const { publication_status } = context;
  const ids = Object.fromEntries(Object.entries(context).filter(([key, value]) => key !== 'publication_status' && value !== undefined));
  const enriched = Object.create(Object.getPrototypeOf(failure), Object.getOwnPropertyDescriptors(failure)) as HttpError;
  return Object.defineProperties(enriched, {
    stack: { value: failure.stack, configurable: true },
    publication_status: { value: publication_status === 'committed' ? 'committed' : failure.publication_status ?? publication_status, enumerable: true, configurable: true },
    details: { value: { ...(Array.isArray(failure.details) ? { issues: failure.details } : failure.details), ...ids }, enumerable: true, configurable: true },
    cause: { value: error, configurable: true },
  });
}
