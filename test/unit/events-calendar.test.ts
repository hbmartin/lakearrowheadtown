import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { addDays, currentEvents, eventDates, loadEvents, publishEvents, readEvents, selectEvents, validateEvents, isEventsReply, EVENTS_KEY, type EventItem } from '../../src/events';
import { renderCalendarPage } from '../../src/calendar';
import { canonicalJson, fingerprint } from '../../src/primitives';
import { at, bucketWith, digest, item, origin } from '../helpers/fixtures';
import type { Env } from '../../src/types';
const bucket = (env as unknown as Env).SITE_BUCKET;
const timed = (patch: Partial<EventItem> = {}): EventItem => ({ ...item(), all_day: false, starts_at: '2026-10-24T18:00:00Z', ...patch });
beforeEach(async () => { vi.restoreAllMocks(); await reset(); for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {}); });
it.each([
  [{ all_day: 'yes' }, 'all_day'], [{ location: 12 }, 'location'], [{ starts_at: '2026-10-24T18:00:00' }, 'starts_at'],
  [{ ends_at: 'bad' }, 'ends_at'], [{ ends_at: '2026-10-24T18:00:00Z' }, 'ends_at'], [{ ends_at: '2026-10-23T18:00:00Z' }, 'ends_at'],
  [{ all_day: true, starts_at: '2026-02-30' }, 'starts_at'], [{ all_day: true, starts_at: '2026-10-24', ends_at: '2026-10-24' }, 'ends_at'],
])('reports the invalid event field for %j', (patch, field) => {
  try { validateEvents(digest({ items: [{ ...timed(), ...patch } as any] })); throw Error('accepted invalid event'); }
  catch (error: any) { expect(error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: `items[0].${field}` })])); }
});
it('bounds combined validation issues and handles non-object inputs', () => {
  for (const value of [null, [], {}, { items: [null] }]) expect(() => validateEvents(value)).toThrow();
  try { validateEvents({ items: Array.from({ length: 60 }, () => ({ all_day: 'invalid', location: 1 })) }); }
  catch (error: any) { expect(error.details).toHaveLength(50); expect(error.details_truncated).toBe(true); }
});
it('keeps exclusive ends and Pacific dates across both DST transitions', () => {
  expect(eventDates(timed({ all_day: true, starts_at: '2026-10-24', ends_at: '2026-10-27' }))).toEqual({ first: '2026-10-24', last: '2026-10-26' });
  expect(eventDates(timed({ starts_at: '2026-11-01T08:30:00Z', ends_at: '2026-11-01T10:30:00Z' }))).toEqual({ first: '2026-11-01', last: '2026-11-01' });
  expect(eventDates(timed({ starts_at: '2026-03-08T07:30:00Z', ends_at: '2026-03-09T07:00:00Z' }))).toEqual({ first: '2026-03-07', last: '2026-03-08' });
  expect(eventDates(timed({ ends_at: '2026-10-25T07:00:00Z' })).last).toBe('2026-10-24');
  expect(addDays('2024-02-28', 2)).toBe('2024-03-01');
});
it('sorts continuing, all-day and timed occurrences and excludes events outside the window', () => {
  const events = [timed({ headline: 'late', starts_at: '2026-10-24T22:00:00Z' }), timed({ headline: 'early' }),
    timed({ headline: 'all day', all_day: true, starts_at: '2026-10-24' }), timed({ headline: 'continuing', all_day: true, starts_at: '2026-10-23', ends_at: '2026-10-26' }),
    timed({ headline: 'past', all_day: true, starts_at: '2026-10-23' }), timed({ headline: 'future', all_day: true, starts_at: '2026-11-24' })];
  const selected = selectEvents([{ ...digest(), id: crypto.randomUUID(), date: '2026-10-24', received_at: at.toISOString(), items: events }], at);
  expect(selected.map(value => value.headline)).toEqual(['continuing', 'all day', 'early', 'late']);
  const html = renderCalendarPage(origin, { days: 30, as_of: at.toISOString(), published_at: null, events: selected });
  expect(html).toContain('Continues'); expect(html).toContain('All day'); expect(html).toContain('11:00 AM PDT');
  const multi = { ...selected[2], ends_at: '2026-10-26T18:00:00Z', location: '<unsafe>', category: '' };
  const more = renderCalendarPage(origin, { days: 30, as_of: at.toISOString(), published_at: at.toISOString(), events: [multi] });
  expect(more).toContain('Oct 26, 2026'); expect(more).toContain('&lt;unsafe&gt;');
  expect(renderCalendarPage(origin, { days: 30, as_of: at.toISOString(), published_at: null, events: [] })).toContain('No events');
});
it.each(['days=0', 'days=31', 'days=1.5', 'days=1&days=2'])('rejects invalid reads: %s', async query => {
  await expect(readEvents(bucket, new URLSearchParams(query), at)).rejects.toMatchObject({ code: 'invalid_days' });
});
it('deduplicates equivalent offsets while distinguishing a later occurrence and rejecting past ends', async () => {
  const first = validateEvents(digest({ items: [timed({ ends_at: '2026-10-24T20:00:00Z', location: 'Library' })] }));
  expect(await publishEvents(bucket, first, at)).toMatchObject({ ok: true, result: { counts: { published: 1 } } });
  expect(await publishEvents(bucket, { ...first, items: [{ ...first.items[0], starts_at: '2026-10-24T11:00:00-07:00' }] }, at)).toMatchObject({ ok: true, result: { duplicate: true } });
  expect(await publishEvents(bucket, { ...first, items: [{ ...first.items[0], starts_at: '2026-10-25T18:00:00Z', ends_at: undefined }] }, at)).toMatchObject({ ok: true, result: { counts: { published: 1 } } });
  expect(await readEvents(bucket, new URLSearchParams('days=1'), at)).toMatchObject({ days: 1, events: [expect.objectContaining({ location: 'Library' })] });
  expect(await publishEvents(bucket, validateEvents(digest({ items: [timed({ all_day: true, starts_at: '2026-10-20', ends_at: '2026-10-22' })] })), at)).toMatchObject({ ok: false, failure: { details: [expect.objectContaining({ path: 'items[0].ends_at' })] } });
});
it('fails closed for missing, malformed and mismatched event snapshots and sources', async () => {
  await expect(currentEvents(bucket, `events/snapshots/${'a'.repeat(64)}.json`)).rejects.toMatchObject({ reason: 'missing' });
  for (const [body, reason] of [['{', 'invalid_json'], ['{}', 'invalid_manifest']] as const) {
    await bucket.put(EVENTS_KEY, body); await expect(currentEvents(bucket)).rejects.toMatchObject({ reason });
  }
  await bucket.delete(EVENTS_KEY);
  await publishEvents(bucket, validateEvents(digest({ items: [timed()] })), at);
  const publication = await currentEvents(bucket); const body = canonicalJson(publication); const key = `events/snapshots/${fingerprint(body)}.json`;
  await bucket.put(key, body); expect(await currentEvents(bucket, key)).toEqual(publication);
  await bucket.put(key, '{}'); await expect(currentEvents(bucket, key)).rejects.toMatchObject({ reason: 'invalid_manifest' });
  const ref = publication.posts[0];
  for (const [text, reason] of [[null, 'missing'], ['{', 'invalid_json'], ['{}', 'invalid_digest']] as const) {
    if (text === null) await bucket.delete(ref.key); else await bucket.put(ref.key, text);
    await expect(loadEvents(bucket, ref)).rejects.toMatchObject({ reason });
    await expect(readEvents(bucket, undefined, at)).rejects.toMatchObject({ reason });
  }
  await expect(currentEvents(bucketWith(bucket, { get: async () => { throw Error('transport'); } }))).rejects.toMatchObject({ kind: 'storage' });
});
it('validates RPC envelopes without accepting malformed result shapes', () => {
  for (const value of [null, {}, { ok: false }, { ok: true, result: {} }, { ok: true, result: { days: 31, as_of: at.toISOString(), published_at: null, events: [] } }]) expect(isEventsReply(value)).toBe(false);
  expect(isEventsReply({ ok: true, result: { days: 30, as_of: at.toISOString(), published_at: null, events: [] } })).toBe(true);
});
