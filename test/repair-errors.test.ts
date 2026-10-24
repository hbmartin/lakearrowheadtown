import { expect, it } from 'vitest';
import { DamagedSource, HttpError, OperationFailure } from '../src/errors';
import { safeError } from '../src/diagnostics';
import { repairErrorState, repairFailure } from '../src/repair-errors';
import { errorSuggestion } from '../src/suggestions';

it.each([
  ['repair_pending', 'repair_pending', true, 'retry_unchanged'],
  ['repair_stalled', 'repair_stalled', true, 'inspect_repair'],
  ['rebuild_checkpoint_damaged', 'rebuild_checkpoint_damaged', true, 'inspect_repair'],
  ['repair_journal_damaged', 'repair_damaged', false, 'inspect_repair'],
])('shares classification and advice for %s', (code, reason, stopAlarm, action) => {
  expect(repairErrorState(code as string)).toMatchObject({ reason, stopAlarm });
  expect(errorSuggestion(code as string, false)).toMatchObject({ action });
});
it('retains the original storage classification and frames through normalization and completion mapping', () => {
  const original = new TypeError('secret payload must never appear');
  original.stack = 'TypeError: secret payload must never appear\n    at storageRead (src/original.ts:42:7)';
  const failure = new OperationFailure('storage', original);
  for (const completion of [undefined, { retry_at: '2026-10-24T18:00:05.000Z' }]) {
    const enriched = repairFailure(failure, { publication_status: 'committed', repair_id: 'repair' }, completion);
    expect(enriched).toMatchObject({ status: completion ? 503 : 500, retryable: true });
    expect(safeError(enriched)).toEqual({ failure_kind: 'storage', error_type: 'TypeError', stack_frames: ['src/original.ts:42:7'] });
    expect(JSON.stringify(safeError(enriched))).not.toContain('secret');
  }
});
it('keeps permanent errors and existing identifiers while filtering undefined context', () => {
  for (const original of [new TypeError('bug'), new HttpError(503, 'Restore evidence', {}, { code: 'rebuild_checkpoint_damaged' })]) {
    const result = repairFailure(original, { publication_status: 'committed' }, {});
    expect(result.code).toBe(original instanceof HttpError ? 'rebuild_checkpoint_damaged' : 'internal_error');
    expect(result.retryable).toBe(false);
  }
  const original = new HttpError(400, 'Invalid target', {}, { details: { repair_id: 'saved-repair', job_id: 'saved-job' } });
  expect(repairFailure(original, { publication_status: 'not_committed', repair_id: undefined, job_id: undefined }).details)
    .toEqual(original.details);
});
it('uses a future completion deadline and replaces expired deadlines with a one-second retry', () => {
  const now = Date.now();
  for (const deadline of [undefined, new Date(now - 1000).toISOString(), new Date(now + 60000).toISOString()]) {
    const failure = repairFailure(new OperationFailure('storage', Error('outage')), { publication_status: 'committed' }, { retry_at: deadline });
    if (deadline && Date.parse(deadline) > now) expect(failure.retry_at).toBe(deadline);
    else expect(Date.parse(failure.retry_at!)).toBeGreaterThanOrEqual(now + 1000);
  }
});
it('bounds cyclic and deeply wrapped diagnostic causes', () => {
  const cyclic = new HttpError(500, 'private'); cyclic.cause = cyclic;
  expect(safeError(cyclic)).toEqual({ error_type: 'UnknownError' });
  let nested: Error = new Error('private');
  for (let i = 0; i < 12; i++) nested = repairFailure(nested, { publication_status: 'unknown' });
  expect(safeError(nested)).toEqual({ error_type: 'UnknownError' });
});
it('does not classify storage failures, inherited object properties, or unrelated errors as repair states', () => {
  for (const code of ['storage_error', 'constructor', '__proto__', 'render_failed']) expect(repairErrorState(code)).toBeUndefined();
  expect(errorSuggestion('rebuild_checkpoint_damaged', false).message).toContain('checkpoint');
});
it('preserves exception identity, causes, diagnostics and identifiers while enriching certainty', () => {
  const original = new DamagedSource('private/source', 'post', 'invalid_digest');
  const enriched = repairFailure(original, { publication_status: 'committed', job_id: 'job', repair_id: 'repair' });
  expect(enriched).toBeInstanceOf(DamagedSource);
  expect(enriched.cause).toBe(original);
  expect(enriched.stack).toBe(original.stack);
  expect(safeError(enriched)).toMatchObject({ source_key: 'private/source', post_id: 'post', reason: 'invalid_digest' });
  expect(enriched).toMatchObject({ publication_status: 'committed', details: { job_id: 'job', repair_id: 'repair' } });
  expect(original.publication_status).toBeUndefined();
  const uncertain = new HttpError(503, 'Unknown', {}, { publication_status: 'unknown', details: { checkpoint_key: 'checkpoint' } });
  expect(repairFailure(uncertain, { publication_status: 'committed', job_id: 'job' })).toMatchObject({ publication_status: 'committed', details: { checkpoint_key: 'checkpoint', job_id: 'job' } });
});
