import { expect, it } from 'vitest';
import { failureError } from '../src/errors';
import { validateIndexMetadata } from '../src/index-metadata';

it.each([undefined, {}, [], [{ path: 'items', code: 'invalid', message: 'Invalid' }], { recovery_token: 'reviewed' }])('preserves meaningful RPC details and fills empty objects: %j', details => {
  const error = failureError({ status: 503, code: 'storage_error', error: 'Unavailable', retryable: true, publication_status: 'unknown', stage: 'repair_activation', details });
  expect(error.details).toEqual(details === undefined || !Array.isArray(details) && !Object.keys(details).length ? { stage: 'repair_activation' } : details);
  expect(error).toMatchObject({ stage: 'repair_activation', retryable: true, publication_status: 'unknown' });
});

it('classifies index metadata limits for conditions independently of repair input', () => {
  expect(() => validateIndexMetadata({ x: 'a'.repeat(8191) })).not.toThrow();
  expect(() => validateIndexMetadata({ x: 'a'.repeat(8192) })).toThrow(expect.objectContaining({ status: 503, code: 'index_metadata_too_large' }));
  expect(() => validateIndexMetadata({ x: 'a'.repeat(8192) }, true)).toThrow(expect.objectContaining({ status: 400, code: 'invalid_repair_target' }));
});
