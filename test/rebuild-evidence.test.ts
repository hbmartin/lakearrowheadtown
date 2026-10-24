import { expect, it } from 'vitest';
import { checkpointFor, readCheckpoint, readPause } from '../src/rebuild-evidence';
import type { RebuildJob } from '../src/types';

const job: RebuildJob = { id: crypto.randomUUID(), generation_id: crypto.randomUUID(), status: 'running', phase: 'render',
  origin: 'https://lakearrowhead.town', processed: 1, created_at: new Date().toISOString() };
it('retains earlier bootstrap bookkeeping when another dispatch is recorded', () => {
  const prior = { version: 2 as const, generation_id: job.generation_id!, phase: 'dispatching' as const, migration: { complete: true, processed: 77 } };
  expect(checkpointFor(job, 'dispatching', undefined, prior)).toEqual(prior);
  expect(checkpointFor(job, 'prepared', undefined, prior)).toEqual(prior);
  expect(() => checkpointFor(job, 'dispatching', { complete: true, processed: 1 }, prior)).toThrow(/Conflicting migration/);
});
it('preserves legacy checkpoints without assigning a generation', () => {
  const legacy = { ...job }; delete legacy.generation_id;
  const prior = readCheckpoint({ version: 1, migration: { complete: true, processed: 2 } }, legacy);
  expect(checkpointFor(legacy, 'dispatching', undefined, prior)).toEqual(prior);
});
it('validates active pause provenance against the current generation', () => {
  const pause = { version: 1, generation_id: job.generation_id, repair_id: crypto.randomUUID(), code: 'unscheduled' };
  expect(readPause(pause, job)).toEqual(pause);
  expect(readPause(undefined, job)).toBeUndefined();
  expect(() => readPause({ ...pause, generation_id: crypto.randomUUID() }, job)).toThrow(/provenance/);
  expect(() => readPause({ ...pause, code: 'render_failed' }, job)).toThrow(/provenance/);
});
it('attributes checkpoint validation to the operation inspecting it', () => {
  try { readCheckpoint({}, job, 'repair_rebuild_evidence'); throw new Error('Expected damage'); }
  catch (error) { expect(error).toMatchObject({ code: 'rebuild_checkpoint_damaged', stage: 'repair_rebuild_evidence' }); }
});
