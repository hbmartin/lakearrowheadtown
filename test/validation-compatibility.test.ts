import { expect, it } from 'vitest';
import { validateDigest, validateUpdate, validateClientRef } from '../src/validation';
import { validateEvents } from '../src/events';
import { validateAlertInput, validateConfirmationBatch } from '../src/alerts';
import { validateRepair } from '../src/publication-repair';
import { HttpError } from '../src/errors';

const item = { group: 'Group', group_url: 'https://example.com', headline: 'Title', body: '', post_url: 'https://example.com/story', category: '', posted_at: '2026-10-24T12:00:00-07:00' };
const digest = { title: 'Digest', source: 'Source', items: [item] };
const alert = { client_ref: 'ref', phase: 'open', category: 'traffic', kind: 'hazard', source: 'caltrans', source_url: 'https://example.com', observed_at: item.posted_at, headline: 'Hazard', area: 'Town' };
const validators = { digest: (v: unknown) => validateDigest(v, { requireItems: true }), stored: validateDigest, update: validateUpdate, event: validateEvents, alert: validateAlertInput, confirmations: validateConfirmationBatch, repair: validateRepair, reference: validateClientRef };
const cases: Array<[keyof typeof validators, string, unknown]> = [
  ['digest', 'strips server fields and preserves whitespace', { ...digest, title: ' title ', client_ref: ' ref ', date: 'wrong', items: [{ ...item, updates: [], id: 'ignored' }] }],
  ['digest', 'nonobject', null], ['digest', 'nonarray', { title: false, source: '', client_ref: '', items: {} }],
  ['digest', 'empty', { ...digest, items: [] }], ['stored', 'empty legacy', { ...digest, items: [] }],
  ['digest', 'ordered field errors', { title: null, source: ' ', client_ref: 3, items: [null, { group: 1, group_url: ' ', headline: '', body: null, post_url: 'ftp://example.com', category: 1, posted_at: '2026-02-30T00:00:00Z' }] }],
  ['digest', 'bounded issues', { ...digest, items: Array.from({ length: 12 }, () => ({})) }],
  ['update', 'defaults and strips', { group: 'G', post_url: item.post_url, posted_at: item.posted_at, ignored: true }],
  ['update', 'nonobject', []], ['update', 'ordered errors', { group: '', group_url: false, body: null, post_url: '', posted_at: '' }],
  ['event', 'all day', { ...digest, items: [{ ...item, all_day: true, starts_at: '2026-10-24', ends_at: '2026-10-25' }] }],
  ['event', 'timed default', { ...digest, client_ref: 'ignored', items: [{ ...item, starts_at: item.posted_at }] }],
  ['event', 'base then event issues', { title: false, items: [{ starts_at: 'bad', all_day: 'yes', ends_at: 'bad', location: 1 }, null] }],
  ['event', 'range', { ...digest, items: [{ ...item, all_day: true, starts_at: '2026-10-24', ends_at: '2026-10-24' }] }],
  ['alert', 'opening', alert], ['alert', 'nonobject', null], ['alert', 'all field errors', { phase: 'open', power: { stage: false, customer_count: -1 }, routes: ['no'], detail: 1, starts_at: 'bad' }],
  ['alert', 'patch null and omission', { client_ref: 'r', phase: 'update', alert_id: '00000000-0000-0000-0000-000000000001', source: 'sce', source_url: item.post_url, observed_at: item.posted_at, area: null, power: { customer_count: null }, ignored: true }],
  ['alert', 'invalid effective opening', { ...alert, area: null }],
  ['confirmations', 'envelope only', { confirmations: [null, {}, { unknown: true }] }], ['confirmations', 'empty', { confirmations: [] }],
  ['repair', 'malformed', { expected_version: 'x' }],
  ['reference', 'unicode', '😀'.repeat(128)], ['reference', 'too long', '😀'.repeat(129)], ['reference', 'control', 'a\u0000b'],
];
it.each(cases)('%s: %s matches API v3', (kind, _name, input) => {
  let result: unknown;
  try { result = { ok: true, value: validators[kind](input) }; }
  catch (error) { if (!(error instanceof HttpError)) throw error; result = { ok: false, status: error.status, message: error.message, code: error.code, details: error.details, details_truncated: error.details_truncated }; }
  expect(result).toMatchSnapshot();
});
