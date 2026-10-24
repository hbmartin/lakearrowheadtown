import { test } from 'node:test';
import assert from 'node:assert/strict';

// Temporary rollout probe, removed after verifying GitHub blocks this revision.
test('intentional local merge-gate failure', () => {
  assert.fail('Expected rollout probe failure: Local validation must block merging.');
});
