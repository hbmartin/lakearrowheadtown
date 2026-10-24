import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { canonicalJson, fingerprint } from '../../src/primitives';
import { instant, timestampPayload } from '../../src/instants';
import { eventDates, type EventItem } from '../../src/events';
import { publishDigest, appendUpdate, retractPost, currentPublication, loadPost } from '../../src/publishing';
import { readPosts } from '../../src/posts';
import { captureChanges, readChanges } from '../../src/changes';
import { fc, propertyOptions } from '../helpers/properties';
import { at, digest, item, origin, secret } from '../helpers/fixtures';
import type { Env } from '../../src/types';
const bucket = (env as unknown as Env).SITE_BUCKET;
const owner = fingerprint(secret);
beforeEach(async () => { vi.restoreAllMocks(); await reset(); for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {}); });
it('canonicalizes object ordering while preserving arrays and JSON round trips', () => {
  fc.assert(fc.property(fc.dictionary(fc.string({ maxLength: 12 }), fc.jsonValue()), value => {
    const reversed = Object.fromEntries(Object.entries(value).reverse());
    expect(canonicalJson(reversed)).toBe(canonicalJson(value));
    expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
    expect(canonicalJson([value, null])).not.toBe(canonicalJson([null, value]));
  }), propertyOptions());
});
it('normalizes offsets without losing nanosecond ordering or submitted values', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 999999998 }), fraction => {
    const digits = String(fraction).padStart(9, '0');
    const utc = `2026-10-24T18:00:00.${digits}Z`;
    const pacific = `2026-10-24T11:00:00.${digits}-07:00`;
    expect(instant(utc)).toBe(instant(pacific));
    expect(instant(`2026-10-24T18:00:00.${String(fraction + 1).padStart(9, '0')}Z`) - instant(utc)).toBe(1n);
    const value = { observed_at: utc, detail: 'unaltered' };
    expect(timestampPayload(value)).toEqual(timestampPayload({ ...value, observed_at: pacific }));
    expect(value.observed_at).toBe(utc);
  }), propertyOptions());
});
it('treats all-day end dates as exclusive for arbitrary positive durations', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 700 }), fc.integer({ min: 1, max: 40 }), (offset, days) => {
    const start = Date.UTC(2025, 0, 1) + offset * 86400000;
    const date = (n: number) => new Date(start + n * 86400000).toISOString().slice(0, 10);
    expect(eventDates({ ...item(), all_day: true, starts_at: date(0), ends_at: date(days) } as EventItem)).toEqual({ first: date(0), last: date(days - 1) });
  }), propertyOptions());
});
it('keeps an independent publication model through publish, retry, update and retract sequences', async () => {
  const operation = fc.record({ action: fc.constantFrom('publish', 'update', 'retract'), slot: fc.integer({ min: 0, max: 3 }) });
  await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 15 }), async operations => {
    await reset();
    const model = new Map<number, { id: string; updates: string[] }>();
    let ordinal = 0;
    for (const { action, slot } of operations) {
      const existing = model.get(slot);
      if (action === 'publish') {
        const input = digest({ client_ref: `sequence-${ordinal++}`, items: [item({ headline: `Slot ${slot}`, post_url: `https://example.com/slot/${slot}` })] });
        const result = await publishDigest(bucket, input, origin, at, true, undefined, { publisherFingerprint: owner });
        expect(result.duplicate).toBe(!!existing);
        if (!existing) model.set(slot, { id: result.post!.id, updates: [] });
      } else if (existing && action === 'update') {
        const url = `https://example.com/update/${slot}/${ordinal++}`;
        await appendUpdate(bucket, existing.id, 0, { group: 'Update', post_url: url, body: url, posted_at: at.toISOString() }, origin, at, true);
        existing.updates.push(url);
      } else if (existing) {
        await retractPost(bucket, existing.id, owner, origin, at, true); model.delete(slot);
      }
      const publication = await currentPublication(bucket);
      const posts = await Promise.all(publication.posts.map(ref => loadPost(bucket, ref)));
      const visible = posts.flatMap(post => post.items.map(story => ({ id: post.id, headline: story.headline, updates: (story.updates ?? []).map(update => update.post_url) })));
      expect(visible).toHaveLength(model.size);
      for (const [slot, expected] of model) expect(visible).toContainEqual({ id: expected.id, headline: `Slot ${slot}`, updates: expected.updates });
    }
  }), propertyOptions(true));
}, 120000);
it('paginates generated story inventories exactly once while retaining pinned snapshots', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 25 }), async count => {
    await reset();
    for (let i = 0; i < count; i++) await publishDigest(bucket, digest({ items: [item({ headline: `Item ${i}` })] }), origin, at, true);
    let query = new URLSearchParams('days=30'); const seen: string[] = [];
    do {
      const page = await readPosts(bucket, query, secret, at);
      for (const post of page.posts) for (const story of post.items) seen.push(`${post.post_id}:${story.item_index}`);
      if (!page.next_cursor) break;
      query = new URLSearchParams({ cursor: page.next_cursor });
    } while (true);
    expect(seen).toHaveLength(count); expect(new Set(seen).size).toBe(count);
    const checkpoint = await captureChanges(bucket, at); let cursor: string | null = null; let changes = 0;
    do {
      const result = await readChanges(bucket, new URLSearchParams(cursor ? { cursor } : {}), secret, async () => checkpoint, at);
      changes += result.changes.length; cursor = result.next_cursor;
    } while (cursor);
    expect(changes).toBe(count);
  }), propertyOptions(true));
}, 120000);
