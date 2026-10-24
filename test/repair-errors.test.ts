import { expect, it } from 'vitest';
import { DamagedSource, HttpError } from '../src/errors';
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
