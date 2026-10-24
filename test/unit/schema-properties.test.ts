import { expect, it } from 'vitest';
import { HttpError } from '../../src/errors';
import { validateDigest, validateStoredDigest, validateUpdate } from '../../src/validation';
import { validateAlertInput, validateConfirmationBatch } from '../../src/alerts';
import { fc, propertyOptions } from '../helpers/properties';
import { digest, item } from '../helpers/fixtures';

it('strips untrusted publication metadata without mutating caller-owned content', () => {
  fc.assert(fc.property(fc.string(), fc.jsonValue(), (body, metadata) => {
    const input = { ...digest(), date: metadata, received_at: metadata, items: [{ ...item({ body }), updates: metadata, id: metadata }] };
    const before = structuredClone(input);
    const output = validateDigest(input, { requireItems: true });
    expect(input).toEqual(before);
    expect(output.items[0].body).toBe(body);
    expect(output).not.toHaveProperty('date');
    expect(output.items[0]).not.toHaveProperty('updates');
    expect(validateDigest(output, { requireItems: true })).toEqual(output);
  }), propertyOptions());
});

it('keeps invalid request diagnostics bounded and free of arbitrary input values', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100 }), count => {
    try { validateDigest({ title: 'Title', source: 'Source', items: Array.from({ length: count }, () => ({ headline: 'private-submission' })) }); throw new Error('Expected validation failure'); }
    catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      const failure = error as HttpError;
      expect(failure.details).toHaveLength(Math.min(count * 6, 50));
      expect(failure.details_truncated).toBe(count * 6 > 50);
      expect(JSON.stringify(failure.details)).not.toContain('private-submission');
    }
  }), propertyOptions());
});

it('preserves legacy empty digests, stored updates and partial confirmation envelopes', () => {
  fc.assert(fc.property(fc.array(fc.jsonValue(), { minLength: 1, maxLength: 100 }), checks => {
    expect(validateConfirmationBatch({ confirmations: checks })).toEqual(checks);
    expect(validateStoredDigest({ ...digest(), items: [] }).items).toEqual([]);
    const update = { group: 'G', post_url: 'https://example.com/update', posted_at: '2026-10-24T12:00:00Z' };
    expect(validateUpdate(update).body).toBe('');
    const stored = validateStoredDigest({ ...digest(), items: [{ ...item(), updates: [{ ...update, received_at: update.posted_at }] }] });
    expect(stored.items[0].updates?.[0]).toEqual({ ...update, body: '', received_at: update.posted_at });
  }), propertyOptions());
});

it('keeps omitted alert fields distinct from explicit null patches', () => {
  fc.assert(fc.property(fc.constantFrom('detail', 'area', 'source_event_id', 'starts_at', 'expected_end'), key => {
    const input = { client_ref: 'patch', phase: 'update', alert_id: '00000000-0000-0000-0000-000000000001', source: 'sce', source_url: 'https://example.com', observed_at: '2026-10-24T12:00:00Z' };
    expect(validateAlertInput(input)).not.toHaveProperty(key);
    expect(validateAlertInput({ ...input, [key]: null })).toHaveProperty(key, null);
  }), propertyOptions());
});
