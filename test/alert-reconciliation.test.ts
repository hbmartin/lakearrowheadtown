import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { readAlerts, retractAlertEntry, submitAlert, validateAlertInput, ALERTS_KEY, type AlertReadResult, type AlertListResult, type AlertIndex } from '../src/alerts';
import { fingerprint } from '../src/primitives';
import { instant } from '../src/instants';
import type { ContentBucket, Env } from '../src/types';

const bindings = env as unknown as Env;
const bucket = bindings.SITE_BUCKET;
const secret = 'test-secret-at-least-thirty-two-characters-long';
const owner = fingerprint(secret);
const at = new Date('2026-10-22T18:00:00Z');
const later = (hours: number) => new Date(at.getTime() + hours * 3600000);
const opening = (patch: Record<string, unknown> = {}) => validateAlertInput({ client_ref: crypto.randomUUID(), phase: 'open', category: 'traffic', kind: 'closure', routes: ['SR-138'],
  headline: 'SR-138 closure', detail: 'Long Markdown detail', source: 'caltrans', source_url: 'https://example.com/138', observed_at: at.toISOString(), ...patch });
const update = (id: string, patch: Record<string, unknown> = {}) => validateAlertInput({ client_ref: crypto.randomUUID(), phase: 'update', alert_id: id,
  source: 'caltrans', source_url: 'https://example.com/138', observed_at: later(1).toISOString(), ...patch });
const wrap = (overrides: Partial<ContentBucket>): ContentBucket => ({ get: key => bucket.get(key), head: key => bucket.head(key),
  put: (key, body, options) => bucket.put(key, body, options), list: options => bucket.list(options), ...overrides });
const read = (query = '', now = at, id?: string) => readAlerts(bucket, new URLSearchParams(query), 'cursor-secret', now, id);
const auth = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
const request = (path: string, init: RequestInit = {}) => worker.fetch(new Request('https://lakearrowhead.town' + path, init), bindings);
beforeEach(async () => { vi.restoreAllMocks(); await reset(); for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); });

describe('direct and compact alert reads', () => {
  it('finds old retained identities outside the collection window', async () => {
    const opened = await submitAlert(bucket, opening(), owner, at);
    await submitAlert(bucket, update(opened.alert_id, { phase: 'resolved' }), owner, later(1));
    expect((await read('', later(24 * 40)) as AlertListResult).alerts).toHaveLength(0);
    expect((await read('', later(24 * 40), opened.alert_id) as AlertReadResult).alert.state).toBe('resolved');
    await expect(read('', at, crypto.randomUUID())).rejects.toMatchObject({ status: 404, code: 'alert_not_found' });
  });
  it('serves effective state and revision without source reads', async () => {
    const opened = await submitAlert(bucket, opening(), owner, at);
    const get = vi.fn((key: string) => { if (key.startsWith('alerts/revisions/')) throw new Error('History must not load'); return bucket.get(key); });
    const store = wrap({ get });
    const direct = await readAlerts(store, new URLSearchParams('fields=index'), 'key', at, opened.alert_id) as AlertReadResult;
    expect(direct.alert).toMatchObject({ alert_id: opened.alert_id, state: 'open', confirmation_count: 0, last_received_at: at.toISOString(), revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(direct.alert).not.toHaveProperty('detail'); expect(direct.alert).not.toHaveProperty('history');
    const list = await readAlerts(store, new URLSearchParams('fields=index'), 'key', later(24)) as AlertListResult<AlertIndex>;
    expect(list.alerts[0].state).toBe('expired-unconfirmed');
    expect(list.alerts[0].revision).not.toBe((direct.alert as AlertIndex).revision);
  });
  it('pins representation, snapshot and expiry across pages', async () => {
    for (let i = 0; i < 21; i++) await submitAlert(bucket, opening(), owner, at);
    const first = await read('fields=index') as AlertListResult<AlertIndex>;
    expect(first.alerts).toHaveLength(20);
    const second = await read(`cursor=${encodeURIComponent(first.next_cursor!)}`, later(48)) as AlertListResult<AlertIndex>;
    expect(second.fields).toBe('index'); expect(second.as_of).toBe(first.as_of); expect(second.alerts[0].state).toBe('open');
    await expect(read(`fields=full&cursor=${encodeURIComponent(first.next_cursor!)}`)).rejects.toMatchObject({ code: 'invalid_cursor' });
    for (const query of ['fields=bad', 'fields=full&fields=index']) await expect(read(query)).rejects.toMatchObject({ code: 'invalid_fields' });
  });
  it('authenticates direct GET/HEAD and exposes the additive v3 shape', async () => {
    const response = await request('/api/alerts', { method: 'POST', headers: auth, body: JSON.stringify(opening({ observed_at: new Date().toISOString() })) });
    const published = await response.json<any>(); const path = `/api/alerts/${published.alert_id}?fields=index`;
    expect((await request(path)).status).toBe(401);
    const get = await request(path, { headers: auth }); expect(get.status).toBe(200); expect(await get.json()).toMatchObject({ ok: true, fields: 'index', alert: { alert_id: published.alert_id } });
    const head = await request(path, { method: 'HEAD', headers: auth }); expect(head.status).toBe(200); expect(await head.text()).toBe('');
    expect((await request(path, { method: 'POST', headers: auth })).status).toBe(405);
  });
});

describe('lossless retry identity and advisory duplicate warnings', () => {
  it('accepts equivalent instants in existing receipts without writes or value replacement', async () => {
    const input = opening({ observed_at: '2026-10-22T18:00:00.123456789Z', starts_at: '2026-10-22T18:00:00Z', expected_end: '2026-10-23T18:00:00Z' });
    const first = await submitAlert(bucket, input, owner, at);
    const put = vi.fn(() => { throw new Error('Retries must not write'); });
    const retry = await submitAlert(wrap({ put }), { ...input, observed_at: '2026-10-22T11:00:00.123456789-07:00', starts_at: '2026-10-22T11:00:00.000-07:00', expected_end: '2026-10-23T11:00:00-07:00' }, owner, at);
    expect(retry).toMatchObject({ status: 'duplicate', entry_id: first.entry_id, entry: { input } }); expect(put).not.toHaveBeenCalled();
    await expect(submitAlert(bucket, { ...input, observed_at: '2026-10-22T18:00:00.123456790Z' }, owner, at)).rejects.toMatchObject({ code: 'client_ref_conflict' });
    await expect(submitAlert(bucket, { ...input, detail: null }, owner, at)).rejects.toMatchObject({ code: 'client_ref_conflict' });
    expect(instant('2026-10-22T18:00:00.1Z')).toBe(instant('2026-10-22T11:00:00.100000000-07:00'));
  });
  it('warns without merging, prefers provider IDs and excludes expired conditions', async () => {
    const first = await submitAlert(bucket, opening({ source_event_id: 'one' }), owner, at);
    const distinct = await submitAlert(bucket, opening({ source_event_id: 'two' }), owner, at); expect(distinct).not.toHaveProperty('warnings');
    const same = await submitAlert(bucket, opening({ source_event_id: 'one', routes: ['SR-18'] }), owner, at, undefined, true);
    expect(same.warnings).toMatchObject([{ code: 'possible_duplicate_alert', matches: [{ alert_id: first.alert_id, reason: 'source_event_id' }] }]);
    expect(same.alert_id).not.toBe(first.alert_id);
    const expired = await submitAlert(bucket, opening({ observed_at: later(25).toISOString() }), owner, later(25)); expect(expired).not.toHaveProperty('warnings');
    const other = await submitAlert(bucket, opening({ routes: ['SR-18'], area: '  Village  Road ', observed_at: later(25).toISOString() }), owner, later(25));
    const match = await submitAlert(bucket, opening({ routes: ['SR-18'], area: 'village road', observed_at: later(25).toISOString() }), owner, later(25));
    expect(match.warnings?.[0].matches).toContainEqual({ alert_id: other.alert_id, reason: 'location' });
  });
});

describe('retraction previews', () => {
  it('replays state, ownership and dependencies without any writes', async () => {
    const first = await submitAlert(bucket, opening(), owner, at);
    const resolved = await submitAlert(bucket, update(first.alert_id, { phase: 'resolved' }), owner, later(1));
    const put = vi.fn(() => { throw new Error('Preview must not write'); }); const pending = vi.fn(async () => {});
    const preview = await retractAlertEntry(wrap({ put }), first.alert_id, resolved.entry_id, owner, later(2), undefined, pending, true);
    expect(preview).toMatchObject({ state: 'open', dry_run: true, committed: false, checked_at: later(2).toISOString() });
    expect(put).not.toHaveBeenCalled(); expect(pending).not.toHaveBeenCalled();
    await expect(retractAlertEntry(bucket, first.alert_id, resolved.entry_id, 'other', later(2), undefined, pending, true)).rejects.toMatchObject({ code: 'retract_forbidden', publication_status: 'not_attempted' });
    expect((await read('', later(2), first.alert_id) as AlertReadResult).alert.state).toBe('resolved');
  });
  it('passes previews through HTTP and leaves pending composition untouched', async () => {
    const response = await request('/api/alerts', { method: 'POST', headers: auth, body: JSON.stringify(opening({ observed_at: new Date().toISOString() })) });
    const opened = await response.json<any>();
    const path = `/api/alerts/${opened.alert_id}/entries/${opened.entry_id}/retract?dry_run=true`;
    const before = (await bucket.get(ALERTS_KEY))!.etag;
    const preview = await request(path, { method: 'POST', headers: auth });
    expect(await preview.json()).toMatchObject({ ok: true, state: 'retracted', dry_run: true, committed: false });
    expect((await bucket.get(ALERTS_KEY))!.etag).toBe(before);
    await runInDurableObject(bindings.PUBLISHER.getByName('site'), async (_instance, state) => { expect(await state.storage.get('conditions:pending')).toBeUndefined(); });
    expect((await request(path.replace('true', 'maybe'), { method: 'POST', headers: auth })).status).toBe(400);
  });
});
