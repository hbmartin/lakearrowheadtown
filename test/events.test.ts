import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { publishEvents, validateEvents, currentEvents, readEvents, EVENTS_KEY } from '../src/events';
import { pageResource } from '../src/pages';
import type { ContentBucket, Env } from '../src/types';
const bucket = (env as unknown as Env).SITE_BUCKET; const origin = 'https://lakearrowhead.town';
const at = new Date('2026-10-22T18:00:00Z'); const day = (n: number) => new Date(+at + n * 86400000);
const input = (date = '2026-10-22', url = crypto.randomUUID()) => validateEvents({ title: 'Events', source: 'Test', items: [{ headline: 'Meeting', body: 'Details', group: 'Group', group_url: origin, post_url: `${origin}/${url}`, posted_at: at.toISOString(), category: 'event', all_day: true, starts_at: date }] });
const wrap = (overrides: Partial<ContentBucket>): ContentBucket => ({ get: key => bucket.get(key), head: key => bucket.head(key), put: (key, body, options) => bucket.put(key, body, options), list: options => bucket.list(options), ...overrides });
beforeEach(async () => { vi.restoreAllMocks(); await reset(); vi.spyOn(console, 'info').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it('rejects new past events atomically in execution and preview while stored validation remains time independent', async () => {
  const old = input('2026-10-21'); const fresh = input('2026-10-23');
  for (const dryRun of [false, true]) {
    const result = await publishEvents(bucket, { ...fresh, items: [...fresh.items, ...old.items] }, at, undefined, dryRun);
    expect(result).toMatchObject({ ok: false, failure: { code: 'validation_failed', details: [{ path: 'items[1].starts_at', code: 'event_in_past' }] } });
    expect(await bucket.head(EVENTS_KEY)).toBeNull();
  }
  expect(validateEvents(old).items).toHaveLength(1);
});
it('deduplicates a finished occurrence for its original 30 receipt dates without reading source bodies', async () => {
  const digest = input(); const first = await publishEvents(bucket, digest, at); expect(first.ok).toBe(true);
  const store = wrap({ get: key => { if (key.startsWith('events/batches/')) throw new Error('No historical source reads'); return bucket.get(key); } });
  const duplicate = await publishEvents(store, digest, day(29)); expect(duplicate).toMatchObject({ ok: true, result: { duplicate: true } });
  const expired = await publishEvents(store, digest, day(30)); expect(expired).toMatchObject({ ok: false, failure: { code: 'validation_failed' } });
});
it('hydrates committed legacy references once and then reuses indexed metadata for publication', async () => {
  await publishEvents(bucket, input('2026-11-01'), at);
  const legacy = await currentEvents(bucket); delete legacy.dedup_index; await bucket.put(EVENTS_KEY, JSON.stringify(legacy));
  await publishEvents(bucket, input('2026-11-02'), at);
  const store = wrap({ get: key => { if (key.startsWith('events/batches/')) throw new Error('Unchanged batches must not load'); return bucket.get(key); } });
  expect(await publishEvents(store, input('2026-11-03'), at)).toMatchObject({ ok: true });
  expect((await readEvents(bucket, new URLSearchParams(), at)).events).toHaveLength(3);
});
it('keeps same-source same-start identity unchanged and aggregates common/event validation', async () => {
  const digest = input(); digest.items.push({ ...digest.items[0], headline: 'Other meeting' });
  expect(await publishEvents(bucket, digest, at)).toMatchObject({ ok: true, result: { counts: { published: 1, duplicates: 1 } } });
  try { validateEvents({ ...digest, items: [{ ...digest.items[0], post_url: 'bad', starts_at: 'bad' }] }); throw new Error('Expected validation'); }
  catch (error: any) { expect(error.message).toBe('Event validation failed'); expect(error.details.map((item: any) => item.path)).toEqual(expect.arrayContaining(['items[0].post_url', 'items[0].starts_at'])); }
});
it('shares calendar renders but invalidates on publication and Los Angeles date changes', async () => {
  vi.setSystemTime(at); await publishEvents(bucket, input('2026-10-23'), at);
  const get = vi.fn((key: string) => bucket.get(key)); const store = wrap({ get });
  const request = () => pageResource(new Request(origin + '/calendar/'), store, origin);
  await Promise.all([request(), request()]); expect(get.mock.calls.filter(([key]) => key.startsWith('events/batches/'))).toHaveLength(1);
  get.mockClear(); await request(); expect(get.mock.calls.filter(([key]) => key.startsWith('events/batches/'))).toHaveLength(0);
  vi.setSystemTime(day(1)); await request(); expect(get.mock.calls.filter(([key]) => key.startsWith('events/batches/'))).toHaveLength(1);
  await publishEvents(bucket, input('2026-10-24'), day(1)); get.mockClear(); await request(); expect(get.mock.calls.filter(([key]) => key.startsWith('events/batches/'))).toHaveLength(2);
});
