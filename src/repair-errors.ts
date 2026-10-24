import { asHttpError, type HttpError } from './errors';
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
export function repairFailure(error: unknown, context: RepairFailureContext): HttpError {
  const failure = asHttpError(error);
  const { publication_status, ...ids } = context;
  const enriched = Object.create(Object.getPrototypeOf(failure), Object.getOwnPropertyDescriptors(failure)) as HttpError;
  return Object.defineProperties(enriched, {
    stack: { value: failure.stack, configurable: true },
    publication_status: { value: publication_status === 'committed' ? 'committed' : failure.publication_status ?? publication_status, enumerable: true, configurable: true },
    details: { value: { ...(Array.isArray(failure.details) ? { issues: failure.details } : failure.details), ...ids }, enumerable: true, configurable: true },
    cause: { value: error, configurable: true },
  });
}
