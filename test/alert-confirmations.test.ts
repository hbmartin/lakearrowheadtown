import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { ALERTS_KEY, confirmAlerts, readAlerts, retractAlertEntry, submitAlert, validateAlertInput, validateConfirmationBatch, type AlertReadResult, type AlertMutationResult, type ConfirmationInput, type ConfirmationsResult } from '../src/alerts';
import { fingerprint } from '../src/primitives';
import type { ContentBucket, Env } from '../src/types';
const inPublisher = runInDurableObject as unknown as <T>(stub: unknown, callback: (instance: any, state: DurableObjectState) => Promise<T>) => Promise<T>;
const bindings = env as unknown as Env; const bucket = bindings.SITE_BUCKET;
const secret = 'test-secret-at-least-thirty-two-characters-long'; const owner = fingerprint(secret);
const at = new Date('2026-10-22T18:00:00Z'); const later = (hours: number) => new Date(at.getTime() + hours * 3600000);
const source = { source: 'caltrans' as const, source_url: 'https://example.com/138' };
const open = (patch: Record<string, unknown> = {}) => submitAlert(bucket, validateAlertInput({ client_ref: crypto.randomUUID(), phase: 'open', category: 'traffic', kind: 'closure', routes: ['SR-138'], headline: 'Closure', ...source, observed_at: at.toISOString(), ...patch }), owner, at);
const check = (alert_id: string, hours = 1, patch: Record<string, unknown> = {}): ConfirmationInput => ({ client_ref: crypto.randomUUID(), alert_id, ...source, observed_at: later(hours).toISOString(), ...patch });
const wrap = (overrides: Partial<ContentBucket>): ContentBucket => ({ get: key => bucket.get(key), head: key => bucket.head(key), put: (key, body, opts) => bucket.put(key, body, opts), list: opts => bucket.list(opts), ...overrides });
const full = async (id: string, history = 'full') => (await readAlerts(bucket, new URLSearchParams({ history }), 'key', later(10), id) as AlertReadResult).alert as AlertMutationResult['alert'];
const auth = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
const request = (path: string, init: RequestInit = {}) => worker.fetch(new Request('https://lakearrowhead.town' + path, init), bindings);
beforeEach(async () => { vi.restoreAllMocks(); await reset(); for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {}); });

it('commits valid checks once and reports ordered independent errors', async () => {
  const a = await open(); const b = await open(); const put = vi.fn((key: string, body: string | ArrayBuffer | ArrayBufferView, opts?: R2PutOptions) => bucket.put(key, body, opts));
  const result = await confirmAlerts(wrap({ put }), [null, check(a.alert_id, -1), check(a.alert_id), check(a.alert_id, 2), check(b.alert_id), check(crypto.randomUUID())], later(1));
  expect(result.counts).toEqual({ submitted: 6, confirmed: 2, duplicates: 0, failed: 4 });
  expect(result.items.map(item => item.ok ? item.status : item.code)).toEqual(['validation_failed', 'stale_observation', 'confirmed', 'duplicate_alert_id', 'confirmed', 'alert_not_found']);
  expect(put.mock.calls.filter(([key]) => key === ALERTS_KEY)).toHaveLength(1);
  expect(put.mock.calls.filter(([key]) => key.startsWith('alerts/snapshots/'))).toHaveLength(1);
  expect((await full(a.alert_id)).observed_at).toBe(later(1).toISOString());
});
it('coalesces runs while expanding compatible full history and reference lookups', async () => {
  const a = await open(); const one = check(a.alert_id, 1); const two = check(a.alert_id, 2);
  const first = await confirmAlerts(bucket, [one], later(1)); const second = await confirmAlerts(bucket, [two], later(2));
  expect((await full(a.alert_id)).history).toHaveLength(3);
  const coalesced = await full(a.alert_id, 'coalesced'); expect(coalesced.history).toHaveLength(2);
  expect(coalesced.history[1]).toMatchObject({ entry_type: 'confirmation', retractable: false, input: { phase: 'update', observed_at: two.observed_at }, confirmation_run: { count: 2, first_observed_at: one.observed_at, last_observed_at: two.observed_at } });
  for (const input of [one, two]) {
    const lookup = await readAlerts(bucket, new URLSearchParams({ client_ref: input.client_ref, history: 'coalesced' }), 'key', later(3)) as AlertMutationResult;
    expect(lookup.entry).toMatchObject({ client_ref: input.client_ref, entry_type: 'confirmation', retractable: false });
  }
  const index = (second.items[0] as any).alert; expect(index.confirmation_count).toBe(2); expect(index.last_confirmed_at).toBe(two.observed_at);
  const retry = await confirmAlerts(wrap({ put: async () => { throw new Error('Duplicate must not write'); } }), [{ ...one, observed_at: '2026-10-22T12:00:00-07:00' }], later(4));
  expect(retry.counts).toMatchObject({ duplicates: 1, confirmed: 0 }); expect((retry.items[0] as any).entry_id).toBe((first.items[0] as any).entry_id);
});
it('does not load or copy earlier confirmation payloads on subsequent checks', async () => {
  const a = await open(); await confirmAlerts(bucket, [check(a.alert_id)], later(1));
  const pointer = await (await bucket.get(ALERTS_KEY))!.json<any>(); const manifest = await (await bucket.get(pointer.snapshot))!.json<any>();
  const root = await (await bucket.get(manifest.alerts[0].key))!.json<any>();
  const get = vi.fn((key: string) => { if (key === root.base || key.startsWith('alerts/confirmations/')) throw new Error('Old checks must not load'); return bucket.get(key); });
  const writes: { key: string; body: string }[] = [];
  const store = wrap({ get, put: (key, body, options) => { writes.push({ key, body: String(body) }); return bucket.put(key, body, options); } });
  await confirmAlerts(store, [check(a.alert_id, 2)], later(2));
  const revision = JSON.parse(writes.find(write => write.key.startsWith('alerts/revisions/'))!.body);
  expect(revision.version).toBe(2); expect(revision.timeline).toHaveLength(1); expect(revision.timeline[0].count).toBe(2); expect(revision.entries).toBeUndefined();
});
it('starts new runs after content changes or changes of source identity', async () => {
  const a = await open(); await confirmAlerts(bucket, [check(a.alert_id, 1)], later(1));
  const changed = await submitAlert(bucket, validateAlertInput({ ...check(a.alert_id, 2), phase: 'update', detail: 'New material details' }), owner, later(2));
  await confirmAlerts(bucket, [check(a.alert_id, 3)], later(3));
  await confirmAlerts(bucket, [check(a.alert_id, 4, { source_url: 'https://example.com/new-source' })], later(4));
  const history = await full(a.alert_id, 'coalesced'); expect(history.history).toHaveLength(5);
  expect(history.history.filter(entry => entry.confirmation_run)).toHaveLength(3);
  await retractAlertEntry(bucket, a.alert_id, changed.entry_id, owner, later(5));
  const reverted = await full(a.alert_id, 'coalesced'); expect(reverted.detail).toBeUndefined(); expect(reverted.observed_at).toBe(later(4).toISOString());
  await confirmAlerts(bucket, [check(a.alert_id, 6, { source_url: 'https://example.com/new-source' })], later(6));
  expect((await full(a.alert_id, 'coalesced')).history.filter(entry => entry.confirmation_run)).toHaveLength(4);
});
it('forbids confirmation retractions while preserving normal update ownership', async () => {
  const a = await open(); const confirmed = await confirmAlerts(bucket, [check(a.alert_id)], later(1)); const item = confirmed.items[0] as any;
  await expect(retractAlertEntry(bucket, a.alert_id, item.entry_id, owner, later(2))).rejects.toMatchObject({ status: 403, code: 'confirmation_not_retractable' });
  await expect(retractAlertEntry(bucket, a.alert_id, item.entry_id, 'rotated', later(2), undefined, undefined, true)).rejects.toMatchObject({ code: 'confirmation_not_retractable', publication_status: 'not_attempted' });
  const retry = await confirmAlerts(bucket, [check(a.alert_id, 2)], later(2)); expect(retry.counts.confirmed).toBe(1);
  await expect(retractAlertEntry(bucket, a.alert_id, a.entry_id, 'rotated', later(2))).rejects.toMatchObject({ code: 'retract_forbidden' });
});
it('retains expiry, future timestamp acceptance and lifecycle rules', async () => {
  const a = await open(); const revived = await confirmAlerts(bucket, [check(a.alert_id, 25)], later(25)); expect((revived.items[0] as any).alert.state).toBe('open');
  const future = await confirmAlerts(bucket, [check(a.alert_id, 100)], later(26)); expect((future.items[0] as any).alert.expires_at).toBe(later(124).toISOString());
  const b = await open({ expected_end: later(2).toISOString() }); const inherited = await confirmAlerts(bucket, [check(b.alert_id, 28)], later(28)); expect((inherited.items[0] as any).alert.state).toBe('expired-unconfirmed');
  await submitAlert(bucket, validateAlertInput({ ...check(b.alert_id, 29), phase: 'resolved' }), owner, later(29));
  expect((await confirmAlerts(bucket, [check(b.alert_id, 30)], later(30))).items[0]).toMatchObject({ ok: false, code: 'alert_closed' });
});
it('rejects content fields and distinguishes confirmation reference identities', async () => {
  const a = await open(); const input = check(a.alert_id);
  expect((await confirmAlerts(bucket, [{ ...input, expected_end: null }], later(1))).items[0]).toMatchObject({ ok: false, code: 'validation_failed' });
  await confirmAlerts(bucket, [input], later(1));
  expect((await confirmAlerts(bucket, [{ ...input, observed_at: later(2).toISOString() }], later(2))).items[0]).toMatchObject({ code: 'client_ref_conflict' });
  await expect(submitAlert(bucket, validateAlertInput({ ...input, phase: 'update' }), owner, later(2))).rejects.toMatchObject({ code: 'client_ref_conflict' });
  expect(() => validateConfirmationBatch({ confirmations: [] })).toThrow(); expect(() => validateConfirmationBatch({ confirmations: Array(101).fill(input) })).toThrow();
});
it('previews without writes and recovers an uncertain atomic commit by unchanged retry', async () => {
  const a = await open(); const input = check(a.alert_id); const pending = vi.fn(async () => {});
  const preview = await confirmAlerts(wrap({ put: async () => { throw new Error('Preview must not write'); } }), [input], later(1), undefined, true, pending);
  expect(preview).toMatchObject({ dry_run: true, committed: false, counts: { confirmed: 1 } }); expect(pending).not.toHaveBeenCalled();
  const failed = wrap({ put: async (key, body, opts) => { const result = await bucket.put(key, body, opts); if (key === ALERTS_KEY) throw new Error('Lost acknowledgement'); return result; } });
  await expect(confirmAlerts(failed, [input], later(1))).rejects.toMatchObject({ publication_status: 'unknown', retryable: true });
  const retry = await confirmAlerts(bucket, [input], later(2)); expect(retry.counts).toMatchObject({ confirmed: 0, duplicates: 1 }); expect((await full(a.alert_id)).history).toHaveLength(2);
});
it('does not expose orphan checks when snapshot preparation fails', async () => {
  const a = await open(); const input = check(a.alert_id);
  const failed = wrap({ put: (key, body, opts) => { if (key.startsWith('alerts/snapshots/')) throw new Error('Snapshot failure'); return bucket.put(key, body, opts); } });
  await expect(confirmAlerts(failed, [input], later(1))).rejects.toMatchObject({ publication_status: 'not_committed' });
  expect((await full(a.alert_id)).history).toHaveLength(1);
  await expect(readAlerts(bucket, new URLSearchParams({ client_ref: input.client_ref }), 'key', later(2))).rejects.toMatchObject({ code: 'alert_reference_not_found' });
  expect((await confirmAlerts(bucket, [input], later(2))).counts.confirmed).toBe(1);
});
it('binds history mode to cursors and rejects meaningless index-history combinations', async () => {
  for (let i = 0; i < 21; i++) await open();
  const first = await readAlerts(bucket, new URLSearchParams('history=coalesced'), 'key', at) as any;
  await expect(readAlerts(bucket, new URLSearchParams({ cursor: first.next_cursor, history: 'full' }), 'key', at)).rejects.toMatchObject({ code: 'invalid_cursor' });
  expect((await readAlerts(bucket, new URLSearchParams({ cursor: first.next_cursor }), 'key', at) as any).history).toBe('coalesced');
  await expect(readAlerts(bucket, new URLSearchParams('history=coalesced&fields=index'), 'key', at)).rejects.toMatchObject({ code: 'invalid_history' });
});
it('wires HTTP batching and stages writes behind the reader rollout gate', async () => {
  const published = await request('/api/alerts', { method: 'POST', headers: auth, body: JSON.stringify(validateAlertInput({ ...check(crypto.randomUUID(), 1), alert_id: undefined, phase: 'open', category: 'traffic', kind: 'closure', routes: ['SR-138'], headline: 'HTTP', observed_at: new Date().toISOString() })) });
  const a = await published.json<any>(); const input = { ...check(a.alert_id), observed_at: new Date().toISOString() };
  const send = (suffix = '') => request('/api/alerts/confirmations' + suffix, { method: 'POST', headers: auth, body: JSON.stringify({ confirmations: [input] }) });
  expect((await request('/api/alerts/confirmations')).status).toBe(401);
  expect((await request('/api/alerts/confirmations', { headers: auth })).status).toBe(405);
  const preview = await send('?dry_run=true'); expect(await preview.json()).toMatchObject({ ok: true, dry_run: true, counts: { confirmed: 1 } });
  await inPublisher(bindings.PUBLISHER.getByName('site'), async (instance: any) => { instance.env = { ...instance.env, ALERT_CONFIRMATIONS_ENABLED: 'false' }; });
  expect(await (await send()).json()).toMatchObject({ ok: false, code: 'confirmations_not_enabled', publication_status: 'not_attempted' });
  await inPublisher(bindings.PUBLISHER.getByName('site'), async (instance: any) => { instance.env = { ...instance.env, ALERT_CONFIRMATIONS_ENABLED: 'true' }; });
  const confirmed = await (await send()).json<ConfirmationsResult & { ok: boolean }>(); expect(confirmed).toMatchObject({ ok: true, counts: { confirmed: 1 } });
  expect(await (await send()).json()).toMatchObject({ ok: true, counts: { duplicates: 1, confirmed: 0 } });
});

it('keeps confirmation lookups within their original LA receipt-date window across DST', async () => {
  const a = await open(); const input = check(a.alert_id); await confirmAlerts(bucket, [input], at);
  expect(await readAlerts(bucket, new URLSearchParams({ client_ref: input.client_ref }), 'key', new Date('2026-11-21T07:59:59Z'))).toMatchObject({ status: 'found' });
  await expect(readAlerts(bucket, new URLSearchParams({ client_ref: input.client_ref }), 'key', new Date('2026-11-21T08:00:00Z'))).rejects.toMatchObject({ code: 'alert_reference_not_found' });
});
it('recovers pending homepage composition on an unchanged confirmation retry', async () => {
  await inPublisher(bindings.PUBLISHER.getByName('site'), async (instance, state) => {
    const published = await instance.submitAlertV1(validateAlertInput({ client_ref: 'pending-open', phase: 'open', category: 'traffic', kind: 'closure', routes: ['SR-138'], headline: 'Pending', ...source, observed_at: new Date().toISOString() }), owner);
    const input = { ...check(published.result.alert_id), observed_at: new Date().toISOString() }; const original = instance.env;
    let rejected = false;
    instance.env = { ...original, SITE_BUCKET: wrap({ put: (key, body, opts) => { if (key === 'pages/index.html' && !rejected) { rejected = true; throw new Error('Composition failed after source commit'); } return bucket.put(key, body, opts); } }) };
    try {
      const committed = await instance.confirmAlertsV1([input]); expect(committed.ok).toBe(true); expect(committed.result.counts.confirmed).toBe(1); expect(await state.storage.get('conditions:pending')).toBe(true);
      const retry = await instance.confirmAlertsV1([input]); expect(retry.ok).toBe(true); expect(retry.result.counts.duplicates).toBe(1); expect(await state.storage.get('conditions:pending')).toBeUndefined();
    } finally { instance.env = original; }
  });
});
