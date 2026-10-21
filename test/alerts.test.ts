import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { ALERT_DAY, ALERTS_KEY, currentAlertViews, readAlerts, retractAlertEntry, submitAlert, validateAlertInput, type AlertInput, type AlertListResult, type AlertMutationResult } from '../src/alerts';
import { renderAlertBanner } from '../src/alert-banner';
import { fingerprint } from '../src/primitives';
import { renderPage } from '../src/render';
import type { ContentBucket, Env } from '../src/types';

const bindings = env as unknown as Env;
const bucket = bindings.SITE_BUCKET;
const secret = 'test-secret-at-least-thirty-two-characters-long';
const owner = fingerprint(secret);
const base = 'https://lakearrowhead.town';
const auth = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
const start = new Date('2026-10-21T10:00:00-07:00');
const later = (hours: number) => new Date(start.getTime() + hours * 3600000);
const traffic = (patch: Record<string, unknown> = {}) => validateAlertInput({ client_ref: 'traffic-1', phase: 'open', category: 'traffic', kind: 'closure',
  headline: 'SR-18 closed', routes: ['SR-18'], source: 'caltrans', source_url: 'https://roads.dot.ca.gov/?roadnumber=18', observed_at: start.toISOString(), ...patch });
const power = (patch: Record<string, unknown> = {}) => validateAlertInput({ client_ref: 'power-1', phase: 'open', category: 'power', kind: 'outage',
  headline: 'Village outage', area: 'Lake Arrowhead Village', source: 'sce', source_url: 'https://www.sce.com/outage-center/check-outage-status', observed_at: start.toISOString(), power: { stage: 'in-effect', customer_count: 125 }, ...patch });
const change = (id: string, patch: Record<string, unknown> = {}) => validateAlertInput({ client_ref: crypto.randomUUID(), alert_id: id,
  phase: 'update', source: 'caltrans', source_url: 'https://roads.dot.ca.gov/?roadnumber=18', observed_at: later(1).toISOString(), ...patch });
function request(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) {
  return worker.fetch(new Request(base + path, init), { ...bindings, ...overrides });
}
function post(input: AlertInput | unknown, suffix = '') { return request('/api/alerts' + suffix, { method: 'POST', headers: auth, body: JSON.stringify(input) }); }
function wrapped(overrides: Partial<ContentBucket>): ContentBucket {
  return { get: key => bucket.get(key), head: key => bucket.head(key), put: (key, value, options) => bucket.put(key, value, options), list: options => bucket.list(options), ...overrides };
}
const keys = async () => (await bucket.list({ prefix: 'alerts/' })).objects.map(object => object.key);
const list = async (query = '', at = start) => await readAlerts(bucket, new URLSearchParams(query), 'private-cursor-key', at) as AlertListResult;
let loggedErrors: unknown[][] = [];

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
  loggedErrors = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => { loggedErrors.push(args); });
});
afterEach(() => { vi.useRealTimers(); });

describe('alert schema and lifecycle', () => {
  it.each([
    ['closure', {}], ['chain-control', { chain_level: 'R2' }], ['one-way', {}], ['construction', {}], ['storm', {}], ['hazard', {}],
  ])('accepts traffic kind %s and multiple routes or a mountain-wide area', async (kind, extra) => {
    const opened = await submitAlert(bucket, traffic({ kind, routes: ['SR-18', 'SR-330'], ...extra }), owner, start);
    expect(opened.alert.routes).toEqual(['SR-18', 'SR-330']);
    const area = traffic({ client_ref: 'mountains', kind, routes: null, area: 'San Bernardino Mountains', ...extra });
    expect((await submitAlert(bucket, area, owner, start)).alert.area).toBe('San Bernardino Mountains');
  });
  it.each([
    ['outage', 'in-effect'], ['planned-outage', 'scheduled'], ['planned-outage', 'in-effect'],
    ['psps', 'watch'], ['psps', 'warning'], ['psps', 'scheduled'], ['psps', 'in-effect'],
  ])('supports power kind %s at stage %s', async (kind, stage) => {
    const result = await submitAlert(bucket, power({ kind, power: { stage, customer_count: 0 }, source_event_id: 'SCE-123' }), owner, start);
    expect(result.alert.power).toEqual({ stage, customer_count: 0 });
    expect(result.alert.source_event_id).toBe('SCE-123');
    expect(result.expires_at).toBe(later(24).toISOString());
    expect(JSON.stringify(result)).not.toContain('publisher_fingerprint');
    expect(JSON.stringify(result)).not.toContain(owner);
  });
  it.each([
    { routes: [] }, { routes: ['SR-38'] }, { routes: ['SR-18', 'SR-18'] }, { routes: null }, { source: 'unknown' },
    { observed_at: '2026-02-30T09:00:00Z' }, { observed_at: '2026-10-21T09:00:00' }, { headline: '' },
    { source_url: 'javascript:alert(1)' }, { source_url: 'https://user:pass@example.com/' }, { kind: 'chain-control' },
    { kind: 'outage' }, { power: { stage: 'in-effect' } }, { client_ref: 'bad\nref' },
    { starts_at: later(4).toISOString(), expected_end: later(2).toISOString() },
    { expected_end: '9999-12-31T23:59:59Z' },
  ])('rejects invalid traffic input %j', patch => { expect(() => traffic(patch)).toThrow('Alert validation failed'); });
  it.each([
    { area: null }, { power: null }, { power: { stage: 'scheduled' } }, { power: { stage: 'in-effect', customer_count: -1 } },
    { power: { stage: 'in-effect', customer_count: 1.5 } }, { routes: ['SR-18'] },
  ])('rejects invalid power input %j', patch => { expect(() => power(patch)).toThrow('Alert validation failed'); });
  it('expires open-ended alerts at exactly 24 hours and confirms them on the same identity', async () => {
    const opened = await submitAlert(bucket, traffic(), owner, start);
    expect((await currentAlertViews(bucket, new Date(later(24).getTime() - 1)))).toHaveLength(1);
    expect(await currentAlertViews(bucket, later(24))).toHaveLength(0);
    expect((await list('', later(24))).alerts[0].state).toBe('expired-unconfirmed');
    const renewed = await submitAlert(bucket, change(opened.alert_id, { observed_at: later(25).toISOString() }), owner, later(25));
    expect(renewed).toMatchObject({ alert_id: opened.alert_id, state: 'open', expires_at: later(49).toISOString() });
    expect(renewed.alert.history).toHaveLength(2);
  });
  it('preserves estimates on omission and requires extending or clearing an expired estimate', async () => {
    const opened = await submitAlert(bucket, traffic({ expected_end: later(2).toISOString() }), owner, start);
    expect(opened.expires_at).toBe(later(26).toISOString());
    const stillExpired = await submitAlert(bucket, change(opened.alert_id, { observed_at: later(27).toISOString() }), owner, later(27));
    expect(stillExpired.state).toBe('expired-unconfirmed');
    const cleared = await submitAlert(bucket, change(opened.alert_id, { observed_at: later(28).toISOString(), expected_end: null }), owner, later(28));
    expect(cleared.expires_at).toBe(later(52).toISOString());
    expect(cleared.alert).not.toHaveProperty('expected_end');
  });
  it('keeps upcoming notices subject to observation expiry and never infers power-off from a start time', async () => {
    const opened = await submitAlert(bucket, power({ kind: 'planned-outage', starts_at: later(2).toISOString(), power: { stage: 'scheduled' } }), owner, start);
    expect(opened.alert.upcoming).toBe(true);
    const current = (await currentAlertViews(bucket, later(3)))[0];
    expect(current).toMatchObject({ upcoming: false, power: { stage: 'scheduled' } });
    expect(await currentAlertViews(bucket, later(24))).toHaveLength(0);
    const future = await submitAlert(bucket, traffic({ client_ref: 'far-future', starts_at: later(72).toISOString() }), owner, start);
    expect(future.expires_at).toBe(later(24).toISOString());
  });
  it('merges structured updates, rejects stale observations and identity changes, and resolves explicitly', async () => {
    const opened = await submitAlert(bucket, power(), owner, start);
    const updated = await submitAlert(bucket, change(opened.alert_id, { source: 'sce', power: { customer_count: null }, detail: 'Crews are working.' }), owner, later(1));
    expect(updated.alert.power).toEqual({ stage: 'in-effect' });
    await expect(submitAlert(bucket, change(opened.alert_id, { observed_at: start.toISOString() }), owner, later(2))).rejects.toMatchObject({ code: 'stale_observation' });
    await expect(submitAlert(bucket, change(opened.alert_id, { category: 'traffic' }), owner, later(2))).rejects.toMatchObject({ code: 'alert_identity_conflict' });
    const resolved = await submitAlert(bucket, change(opened.alert_id, { phase: 'resolved', observed_at: later(2).toISOString(), source: 'sce', detail: 'Power restored.' }), owner, later(2));
    expect(resolved).toMatchObject({ state: 'resolved', expires_at: null });
    expect(await currentAlertViews(bucket, later(2))).toHaveLength(0);
    await expect(submitAlert(bucket, change(opened.alert_id, { observed_at: later(3).toISOString() }), owner, later(3))).rejects.toMatchObject({ code: 'alert_closed' });
  });
});

describe('receipts, previews, and immutable commits', () => {
  it('retries canonically without writes, conflicts on changed content, and never deduplicates source URLs', async () => {
    const input = traffic();
    const first = await submitAlert(bucket, input, owner, start);
    const before = await keys();
    const retry = await submitAlert(bucket, Object.fromEntries(Object.entries(input).reverse()) as unknown as AlertInput, owner, later(1));
    expect(retry).toMatchObject({ entry_id: first.entry_id, alert_id: first.alert_id, status: 'duplicate', expires_at: first.expires_at });
    expect(await keys()).toEqual(before);
    await expect(submitAlert(bucket, { ...input, headline: 'Different' }, owner, later(1))).rejects.toMatchObject({ code: 'client_ref_conflict' });
    const second = await submitAlert(bucket, traffic({ client_ref: 'other', headline: 'Another segment' }), owner, later(1));
    expect(second.alert_id).not.toBe(first.alert_id);
  });
  it('performs zero writes for previews, including resolution previews, and returns the planned expiry', async () => {
    const preview = await submitAlert(bucket, traffic(), owner, start, undefined, true);
    expect(preview).toMatchObject({ dry_run: true, committed: false, expires_at: later(24).toISOString() });
    expect(await keys()).toEqual([]);
    const opened = await submitAlert(bucket, traffic(), owner, start);
    const before = await keys();
    const resolved = await submitAlert(bucket, change(opened.alert_id, { phase: 'resolved' }), owner, later(1), undefined, true);
    expect(resolved.expires_at).toBe(null);
    expect(await keys()).toEqual(before);
    expect(await currentAlertViews(bucket, later(1))).toHaveLength(1);
  });
  it('retains references across the original 30 LA receipt dates, including after retraction', async () => {
    const firstAt = new Date('2026-10-31T07:00:00Z');
    const input = traffic({ observed_at: firstAt.toISOString() });
    const opened = await submitAlert(bucket, input, owner, firstAt);
    await retractAlertEntry(bucket, opened.alert_id, opened.entry_id, owner, firstAt);
    const found = await readAlerts(bucket, new URLSearchParams({ client_ref: input.client_ref }), 'key', new Date('2026-11-30T07:59:59Z')) as AlertMutationResult;
    expect(found).toMatchObject({ entry_id: opened.entry_id, state: 'retracted', expires_at: null });
    await expect(readAlerts(bucket, new URLSearchParams({ client_ref: input.client_ref }), 'key', new Date('2026-11-30T08:00:00Z'))).rejects.toMatchObject({ code: 'alert_reference_not_found' });
  });
  it('recovers a committed pointer whose acknowledgement was lost', async () => {
    const failed = wrapped({ async put(key, value, options) {
      const result = await bucket.put(key, value, options);
      if (key === ALERTS_KEY) throw new Error('lost acknowledgement');
      return result;
    } });
    await expect(submitAlert(failed, traffic(), owner, start)).rejects.toMatchObject({ publication_status: 'unknown', retryable: true });
    const found = await readAlerts(bucket, new URLSearchParams({ client_ref: 'traffic-1' }), 'key', start) as AlertMutationResult;
    const retry = await submitAlert(bucket, traffic(), owner, start);
    expect(retry.entry_id).toBe(found.entry_id);
    expect(retry.status).toBe('duplicate');
    expect((await bucket.list({ prefix: 'alerts/revisions/' })).objects).toHaveLength(1);
  });
  it('does not expose orphan revisions or receipts when the commit fails before the pointer', async () => {
    const failed = wrapped({ put(key, value, options) { if (key.startsWith('alerts/snapshots/')) throw new Error('snapshot failure'); return bucket.put(key, value, options); } });
    await expect(submitAlert(failed, traffic(), owner, start)).rejects.toMatchObject({ publication_status: 'not_committed' });
    expect(await currentAlertViews(bucket, start)).toEqual([]);
    await expect(readAlerts(bucket, new URLSearchParams({ client_ref: 'traffic-1' }), 'key', start)).rejects.toMatchObject({ code: 'alert_reference_not_found' });
    expect((await submitAlert(bucket, traffic(), owner, start)).status).toBe('published');
  });
});

describe('entry retraction and history reads', () => {
  it('undoes individual updates and resolutions, retains history, and retracts an entire opening', async () => {
    const opened = await submitAlert(bucket, traffic({ detail: 'Original report' }), owner, start);
    const updated = await submitAlert(bucket, change(opened.alert_id, { detail: 'Mistaken report' }), owner, later(1));
    const reverted = await retractAlertEntry(bucket, opened.alert_id, updated.entry_id, owner, later(2));
    expect(reverted.alert.detail).toBe('Original report');
    expect(reverted.expires_at).toBe(later(24).toISOString());
    expect(reverted.alert.history[1].retracted_at).toBe(later(2).toISOString());
    const resolved = await submitAlert(bucket, change(opened.alert_id, { phase: 'resolved', observed_at: later(3).toISOString() }), owner, later(3));
    expect((await retractAlertEntry(bucket, opened.alert_id, resolved.entry_id, owner, later(4))).state).toBe('open');
    expect((await retractAlertEntry(bucket, opened.alert_id, opened.entry_id, owner, later(5)))).toMatchObject({ state: 'retracted', expires_at: null });
    expect((await retractAlertEntry(bucket, opened.alert_id, opened.entry_id, owner, later(50))).status).toBe('already_retracted');
    expect((await list('', later(5))).alerts[0].history).toHaveLength(3);
  });
  it('enforces per-entry ownership and the exact 24-hour receipt deadline', async () => {
    const opened = await submitAlert(bucket, traffic(), owner, start);
    await expect(retractAlertEntry(bucket, opened.alert_id, opened.entry_id, fingerprint('other'), later(1))).rejects.toMatchObject({ code: 'retract_forbidden' });
    await expect(retractAlertEntry(bucket, opened.alert_id, opened.entry_id, owner, later(24))).rejects.toMatchObject({ code: 'retract_window_expired' });
    const update = await submitAlert(bucket, change(opened.alert_id, { observed_at: later(25).toISOString() }), owner, later(25));
    expect((await retractAlertEntry(bucket, opened.alert_id, update.entry_id, owner, later(26))).state).toBe('expired-unconfirmed');
  });
  it('rejects retractions that would leave dependent field-clearing updates invalid', async () => {
    const opened = await submitAlert(bucket, traffic(), owner, start);
    const area = await submitAlert(bucket, change(opened.alert_id, { area: 'Lake Arrowhead' }), owner, later(1));
    await submitAlert(bucket, change(opened.alert_id, { routes: null, observed_at: later(2).toISOString() }), owner, later(2));
    await expect(retractAlertEntry(bucket, opened.alert_id, area.entry_id, owner, later(3))).rejects.toMatchObject({ code: 'retraction_dependency_conflict' });
    await submitAlert(bucket, change(opened.alert_id, { routes: ['SR-18'], observed_at: later(3).toISOString() }), owner, later(3));
    expect((await retractAlertEntry(bucket, opened.alert_id, area.entry_id, owner, later(4))).alert.routes).toEqual(['SR-18']);
  });
  it('pins paginated reads to one snapshot and as_of, including old current alerts and full history', async () => {
    const old = new Date(start.getTime() - 40 * ALERT_DAY);
    await submitAlert(bucket, traffic({ client_ref: 'old-current', expected_end: later(48).toISOString(), observed_at: old.toISOString() }), owner, old);
    for (let i = 0; i < 22; i++) await submitAlert(bucket, traffic({ client_ref: `page-${i}`, headline: `Report ${i}` }), owner, start);
    // A restored snapshot may have different JSON whitespace; pin its actual key.
    const pointer = await (await bucket.get(ALERTS_KEY))!.json<{ version: number; snapshot: string }>();
    const restored = JSON.stringify(await (await bucket.get(pointer.snapshot))!.json(), null, 2);
    const restoredKey = `alerts/snapshots/${fingerprint(restored)}.json`;
    await bucket.put(restoredKey, restored);
    await bucket.put(ALERTS_KEY, JSON.stringify({ ...pointer, snapshot: restoredKey }));
    const first = await list('days=1');
    expect(first.alerts).toHaveLength(20);
    expect(first.next_cursor).toBeTruthy();
    const target = first.alerts[0];
    await submitAlert(bucket, change(target.alert_id, { headline: 'Changed after snapshot' }), owner, later(1));
    await submitAlert(bucket, traffic({ client_ref: 'new-after-snapshot' }), owner, later(1));
    const second = await list(`cursor=${encodeURIComponent(first.next_cursor!)}`, later(50));
    expect(second.as_of).toBe(first.as_of);
    expect(second.alerts).toHaveLength(3);
    expect(second.next_cursor).toBeNull();
    expect([...first.alerts, ...second.alerts].some(alert => alert.history[0].client_ref === 'old-current')).toBe(true);
    expect([...first.alerts, ...second.alerts].every(alert => alert.state === 'open' && alert.history.length === 1)).toBe(true);
    const token = first.next_cursor!.split('.');
    token[1] = (token[1][0] === 'A' ? 'B' : 'A') + token[1].slice(1);
    await expect(list(`cursor=${token.join('.')}`)).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(list(`days=2&cursor=${encodeURIComponent(first.next_cursor!)}`)).rejects.toMatchObject({ code: 'invalid_cursor' });
  });
});

describe('API and homepage integration', () => {
  it('authenticates all operations, validates bodies, and follows the v3 envelope', async () => {
    for (const method of ['GET', 'HEAD', 'POST']) expect((await request('/api/alerts', { method })).status).toBe(401);
    const invalid = await post({ ...traffic(), routes: [] });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ ok: false, code: 'validation_failed', details: [{ path: 'routes' }], publication_status: 'not_attempted' });
    expect((await request('/api/alerts', { method: 'POST', headers: { Authorization: auth.Authorization }, body: '{}' })).status).toBe(415);
    expect((await request('/api/alerts', { method: 'POST', headers: auth, body: '{' })).status).toBe(400);
    expect((await post(traffic(), '?dry_run=1')).status).toBe(400);
    expect((await request('/api/alerts', { method: 'PUT', headers: auth })).headers.get('allow')).toBe('GET, HEAD, POST');
    const response = await post(traffic({ observed_at: new Date().toISOString() }));
    expect(response.status).toBe(200);
    const result = await response.json<AlertMutationResult & { ok: boolean; request_id: string }>();
    expect(result.request_id).toBe(response.headers.get('X-Request-ID'));
    expect(response.headers.get('X-API-Version')).toBe('3');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const conflict = await post(traffic({ headline: 'Changed' }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ suggestion: { path: '/api/alerts' } });
    const head = await request('/api/alerts', { method: 'HEAD', headers: auth });
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
    const path = `/api/alerts/${result.alert_id}/entries/${result.entry_id}/retract`;
    expect((await request(path, { method: 'POST' })).status).toBe(401);
    expect((await request(path + '?dry_run=true', { method: 'POST', headers: auth })).status).toBe(400);
    const retracted = await request(path, { method: 'POST', headers: auth });
    expect(await retracted.json()).toMatchObject({ status: 'retracted', expires_at: null });
  });
  it('serializes concurrent retries, previews without R2 writes, and looks up committed entries', async () => {
    const input = traffic({ observed_at: new Date().toISOString() });
    const preview = await post(input, '?dry_run=true');
    expect(await preview.json()).toMatchObject({ dry_run: true, committed: false, expires_at: new Date(Date.parse(input.observed_at) + ALERT_DAY).toISOString() });
    expect(await keys()).toEqual([]);
    const results = await Promise.all((await Promise.all(Array.from({ length: 4 }, () => post(input)))).map(response => response.json<AlertMutationResult>()));
    expect(results.filter(result => result.status === 'published')).toHaveLength(1);
    expect(new Set(results.map(result => result.entry_id)).size).toBe(1);
    expect((await bucket.list({ prefix: 'alerts/revisions/' })).objects).toHaveLength(1);
    const lookup = await request('/api/alerts?client_ref=traffic-1', { headers: auth });
    expect(await lookup.json()).toMatchObject({ status: 'found', entry_id: results[0].entry_id, expires_at: results[0].expires_at });
  });
  it('preserves validation details and gives generic alert reconciliation advice on RPC failures', async () => {
    const opened = await (await post(power({ observed_at: new Date().toISOString() }))).json<AlertMutationResult>();
    const invalid = await post(change(opened.alert_id, { source: 'sce', observed_at: new Date().toISOString(), power: null }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'validation_failed', details: [{ path: 'power.stage' }], publication_status: 'not_committed' });
    const unavailable = { getByName: () => ({ submitAlertV1: async () => { throw new Error('private transport detail'); } }) } as unknown as Env['PUBLISHER'];
    const failed = await request('/api/alerts', { method: 'POST', headers: auth, body: JSON.stringify(traffic()) }, { PUBLISHER: unavailable });
    expect(failed.status).toBe(503);
    const result = await failed.json<any>();
    expect(result).toMatchObject({ publication_status: 'unknown', retryable: true, suggestion: { path: '/api/alerts' } });
    expect(JSON.stringify(result)).not.toContain('private transport detail');
    expect(result.message).not.toContain('/api/digests');
  });
  it('renders separate compact groups, latest details, safe markup, and accurate power stages', async () => {
    const opened = await submitAlert(bucket, traffic({ headline: '<script>bad</script>', detail: 'Original detail' }), owner, start);
    await submitAlert(bucket, change(opened.alert_id, { headline: 'Newer closure', detail: '**Latest detail**\n\n<script>unsafe</script> [bad](javascript:alert(1))' }), owner, later(1));
    await submitAlert(bucket, traffic({ client_ref: 'older', headline: 'Older closure' }), owner, start);
    await submitAlert(bucket, power({ kind: 'psps', power: { stage: 'watch', customer_count: 200 } }), owner, start);
    const html = renderAlertBanner(await currentAlertViews(bucket, later(1)));
    expect(html).toContain('id="traffic-alerts">Traffic'); expect(html).toContain('id="power-alerts">Power');
    expect(html).toContain('<details class="alert-row">'); expect(html).not.toMatch(/<details[^>]*\bopen/);
    expect(html.indexOf('Newer closure')).toBeLessThan(html.indexOf('Older closure'));
    expect(html).toContain('<strong>Latest detail</strong>'); expect(html).not.toContain('Original detail');
    expect(html).not.toContain('<script>'); expect(html).not.toContain('href="javascript:');
    expect(html).toContain('PSPS · Watch'); expect(html).toContain('Customers potentially affected'); expect(html).not.toContain('Power off');
    expect(html).toContain('PDT');
  });
  it('injects alerts above stories even with an empty homepage and revalidates at expiry', async () => {
    const now = new Date();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    const empty = await request('/'); const emptyTag = empty.headers.get('etag')!; await empty.text();
    const opened = await submitAlert(bucket, traffic({ observed_at: now.toISOString() }), owner, now);
    const page = await request('/', { headers: { 'If-None-Match': emptyTag } });
    expect(page.status).toBe(200);
    const tag = page.headers.get('etag')!; const html = await page.text();
    expect(html.indexOf('class="alerts-banner"')).toBeLessThan(html.indexOf('No posts from the past week'));
    expect(html.indexOf('class="resource-nav"')).toBeLessThan(html.indexOf('class="alerts-banner"'));
    expect((await request('/index.html', { headers: { 'If-None-Match': tag } })).status).toBe(304);
    const head = await request('/', { method: 'HEAD' }); expect(head.headers.get('etag')).toBe(tag); expect(await head.text()).toBe('');
    expect(await (await request('/road-conditions/')).text()).not.toContain('class="alerts-banner"');
    vi.setSystemTime(new Date(Date.parse(opened.expires_at!)));
    const expired = await request('/', { headers: { 'If-None-Match': tag } });
    expect(expired.status).toBe(200); expect(expired.headers.get('etag')).toBe(emptyTag);
    expect(await expired.text()).not.toContain('class="alerts-banner"');
  });
  it('silently hides read failures, logs them, disables caching, and recovers', async () => {
    await bucket.put('pages/index.html', renderPage([], { origin: base }));
    await submitAlert(bucket, traffic({ observed_at: new Date().toISOString() }), owner);
    const healthy = await request('/'); const tag = healthy.headers.get('etag')!; await healthy.text();
    const failedBucket = wrapped({ get(key) { if (key === ALERTS_KEY) throw new Error('offline'); return bucket.get(key); } }) as R2Bucket;
    const response = await request('/', { headers: { 'If-None-Match': tag } }, { SITE_BUCKET: failedBucket });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.has('etag')).toBe(false);
    const html = await response.text(); expect(html).toContain('No posts from the past week'); expect(html).not.toContain('class="alerts-banner"');
    expect(JSON.stringify(loggedErrors)).toContain('alerts_banner_failed');
    expect((await request('/', { headers: { 'If-None-Match': tag } })).status).toBe(304);
  });
});
