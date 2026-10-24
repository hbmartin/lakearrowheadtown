import { HttpError } from './errors';
import { REBUILD_GENERATION, REBUILD_MARKER } from './index-metadata';
import { record } from './primitives';
import type { Migration, RebuildJob } from './types';

export const checkpointKey = (id: string) => `rebuild-finalization:${id}`;
export const generationKey = (id: string, generation: string) => `rebuild-generation:${id}:${generation}`;
export const pauseKey = (id: string) => `rebuild-pause:${id}`;
export const repairableCodes = ['manifest_damaged', 'legacy_recovery_required', 'source_damaged', 'archive_damaged'];
export const validGeneration = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
export const completeMigration = (value: unknown): value is Migration => record(value) && value.complete === true
  && Number.isSafeInteger(value.processed) && Number(value.processed) >= 0;

export type RebuildCheckpoint = { version: 1; migration?: Migration }
  | { version: 2; generation_id: string; phase: 'prepared' | 'dispatching'; migration?: Migration };

export function checkpointDamaged(message = 'Rebuild finalization checkpoint is damaged. Restore the checkpoint from a verified backup before resuming.', stage = 'rebuild_finalization_validation'): HttpError {
  return new HttpError(503, message, {}, { code: 'rebuild_checkpoint_damaged', stage });
}

export function readCheckpoint(value: unknown, job: RebuildJob, stage?: string): RebuildCheckpoint | undefined {
  if (job.generation_id !== undefined && !validGeneration(job.generation_id)) throw checkpointDamaged(undefined, stage);
  if (value === undefined) return;
  if (!record(value) || value.migration !== undefined && !completeMigration(value.migration)) throw checkpointDamaged(undefined, stage);
  if (value.version === 1 && job.generation_id === undefined) return value as RebuildCheckpoint;
  if (value.version === 2 && validGeneration(value.generation_id) && value.generation_id === job.generation_id
    && ['prepared', 'dispatching'].includes(String(value.phase))) return value as RebuildCheckpoint;
  throw checkpointDamaged(undefined, stage);
}

export function checkpointFor(job: RebuildJob, phase: 'prepared' | 'dispatching', migration?: Migration, prior?: RebuildCheckpoint): RebuildCheckpoint {
  if (migration && prior?.migration && (migration.processed !== prior.migration.processed || migration.cursor !== prior.migration.cursor)) {
    throw checkpointDamaged('Conflicting migration bookkeeping. Restore and reconcile the original finalization checkpoint before dispatching again.');
  }
  const saved = prior?.migration ?? migration;
  if (phase === 'prepared' && prior) return prior;
  return job.generation_id ? { version: 2, generation_id: job.generation_id, phase, ...(saved ? { migration: saved } : {}) }
    : { version: 1, ...(saved ? { migration: saved } : {}) };
}

// Active provenance is removed on resume; immutable handoffs are historical and
// cannot establish that a later pause still belongs to the repair.
export interface RepairPause { version: 1; generation_id: string; repair_id: string; code: string }
export function readPause(value: unknown, job: RebuildJob): RepairPause | undefined {
  if (value === undefined) return;
  if (!record(value) || value.version !== 1 || value.generation_id !== job.generation_id || !validGeneration(value.generation_id)
    || !validGeneration(value.repair_id) || !['unscheduled', ...repairableCodes].includes(String(value.code))) {
    throw checkpointDamaged('Active repair pause provenance is damaged. Restore its exact private record before repairing this job.', 'repair_pause_validation');
  }
  return value as unknown as RepairPause;
}

export function receiptMatches(index: R2Object | null, job: RebuildJob): boolean {
  return index?.customMetadata?.[REBUILD_MARKER] === job.id
    && (index.customMetadata?.[REBUILD_GENERATION] ?? undefined) === job.generation_id;
}

// This immutable handoff retains the old generation's evidence after a repair
// fences it. It is not a substitute for the active finalization checkpoint.
export interface GenerationHandoff {
  version: 1;
  job_id: string;
  generation_id: string;
  repair_id: string;
  prior_job: RebuildJob;
  prior_checkpoint: RebuildCheckpoint | null;
  prior_archive_checkpoint: string | null;
  prior_committed: boolean;
  repairable_code: string;
}

export function readHandoff(value: unknown, job: RebuildJob, stage?: string): GenerationHandoff | undefined {
  if (value === undefined) return;
  if (!record(value) || value.version !== 1 || value.job_id !== job.id || value.generation_id !== job.generation_id
    || !validGeneration(value.generation_id)
    || !validGeneration(value.repair_id) || !record(value.prior_job) || value.prior_job.id !== job.id
    || !['queued', 'running', 'failed'].includes(String(value.prior_job.status)) || typeof value.prior_job.origin !== 'string'
    || !['migration', 'render'].includes(String(value.prior_job.phase)) || !Number.isSafeInteger(value.prior_job.processed)
    || Number(value.prior_job.processed) < 0 || value.prior_job.generation_id !== undefined && !validGeneration(value.prior_job.generation_id)
    || value.prior_checkpoint === undefined
    || typeof value.prior_committed !== 'boolean' || typeof value.repairable_code !== 'string'
    || value.prior_archive_checkpoint !== null && typeof value.prior_archive_checkpoint !== 'string') throw checkpointDamaged('Rebuild generation evidence is damaged. Restore its exact generation record from a verified backup before resuming.', stage);
  if (value.prior_checkpoint !== null) readCheckpoint(value.prior_checkpoint, value.prior_job as unknown as RebuildJob, stage);
  return value as unknown as GenerationHandoff;
}
