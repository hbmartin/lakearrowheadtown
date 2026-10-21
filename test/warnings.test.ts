import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import { appendUpdate, currentPublication, loadPost, publishDigest, rebuildHomepage } from '../src/publishing';
import { readPosts } from '../src/posts';
import { CATEGORY_VOCABULARY, CATEGORY_VOCABULARY_VERSION, digestItemWarnings, postedAtWarnings } from '../src/warnings';
import type { AppendResult, ContentBucket, Digest, DigestItem, Env, PublishResult, StoryUpdate } from '../src/types';

const bindings = env as unknown as Env;
const origin = 'https://lakearrowhead.town';
const secret = 'test-secret-at-least-thirty-two-characters-long';
const at = new Date('2026-10-20T18:00:00.000Z');
const item = (name: string, category = 'alert', posted_at = at.toISOString()): DigestItem => ({
  group: 'Community', group_url: 'https://example.com/group', headline: name, body: 'A story.',
  post_url: `https://example.com/${name}`, category, posted_at,
});
const digest = (...items: DigestItem[]): Digest => ({ title: 'Batch', source: 'Community', items });
const update = (name: string, posted_at: string): StoryUpdate => ({ group: 'Community', body: '', post_url: `https://example.com/${name}`, posted_at });
const request = (path: string, body: unknown) => worker.fetch(new Request(origin + path, {
  method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), bindings);
const readOnlyBucket: ContentBucket = {
  get: key => bindings.SITE_BUCKET.get(key), head: key => bindings.SITE_BUCKET.head(key), list: options => bindings.SITE_BUCKET.list(options),
  put: async () => { throw new Error('Unexpected persistent write'); },
};
async function storedPosts() {
  const publication = await currentPublication(bindings.SITE_BUCKET);
  return Promise.all(publication.posts.map(ref => loadPost(bindings.SITE_BUCKET, ref)));
}
async function snapshot() {
  const objects: { key: string; etag: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await bindings.SITE_BUCKET.list({ cursor });
    objects.push(...page.objects.map(({ key, etag }) => ({ key, etag })));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
});

describe('advisory source checks', () => {
  it('pins category vocabulary version 1', () => {
    expect(CATEGORY_VOCABULARY_VERSION).toBe(1);
    expect(CATEGORY_VOCABULARY).toEqual(['alert', 'announcement', 'discussion', 'event', 'traffic', 'weather']);
  });

  it.each(['alert', 'announcement', 'discussion', 'event', 'traffic', 'weather', ''])('accepts category %j without a warning', category => {
    expect(digestItemWarnings(item('story', category), 3, at)).toEqual([]);
  });

  it.each(['trafic', 'Traffic', ' traffic', 'traffic ', ' '])('warns on exact out-of-vocabulary category %j', category => {
    expect(digestItemWarnings(item('story', category), 3, at)).toEqual([{
      index: 3, field: 'items[3].category', code: 'unknown_category', value: category, message: expect.stringContaining('Accepted as submitted.'),
    }]);
  });

  it.each([
    [-2592000001, 'posted_at_stale'], [-2592000000, undefined], [-2591999999, undefined],
    [0, undefined], [899999, undefined], [900000, undefined], [900001, 'posted_at_in_future'],
  ])('checks elapsed-time boundary at offset %i ms', (offset, code) => {
    const value = new Date(at.getTime() + Number(offset)).toISOString();
    expect(postedAtWarnings(value, at)).toEqual(code ? [{ field: 'posted_at', code, message: expect.any(String), value, server_time: at.toISOString() }] : []);
  });

  it.each([
    ['2026-10-20T18:15:00.000Z', '2026-10-20T11:15:00.000-07:00', undefined],
    ['2026-10-20T18:15:00.001Z', '2026-10-20T11:15:00.001-07:00', 'posted_at_in_future'],
    ['2026-09-20T18:00:00.000Z', '2026-09-20T11:00:00.000-07:00', undefined],
    ['2026-09-20T17:59:59.999Z', '2026-09-20T10:59:59.999-07:00', 'posted_at_stale'],
  ])('compares equivalent instants independently of timezone: %s', (utc, offset, code) => {
    for (const value of [utc, offset]) {
      const warnings = postedAtWarnings(value!, at);
      expect(warnings.map(warning => warning.code)).toEqual(code ? [code] : []);
      if (code) expect(warnings[0].value).toBe(value);
    }
  });

  it('uses 720 elapsed hours across daylight saving changes', () => {
    const afterFallback = new Date('2026-11-10T10:00:00-08:00');
    expect(postedAtWarnings('2026-10-11T11:00:00-07:00', afterFallback)).toEqual([]);
    expect(postedAtWarnings('2026-10-11T10:59:59.999-07:00', afterFallback)).toMatchObject([{ code: 'posted_at_stale' }]);
  });
});

describe('publication warning contract', () => {
  it('preserves all submitted categories in storage and reads, including grandfathered values', async () => {
    const categories = ['alert', 'announcement', 'discussion', 'event', 'traffic', 'weather', '', 'trafic', 'Traffic', ' traffic', 'traffic ', ' '];
    const input = digest(...categories.map((category, index) => item(`category-${index}`, category)));
    const result = await publishDigest(bindings.SITE_BUCKET, input, origin, at, true);
    expect(result.counts).toEqual({ submitted: 12, published: 12, duplicates: 0 });
    expect(result.warnings?.map(warning => [warning.index, warning.field, warning.code, warning.value])).toEqual(
      categories.slice(7).map((category, index) => [index + 7, `items[${index + 7}].category`, 'unknown_category', category]));
    expect((await storedPosts())[0].items).toEqual(input.items);
    await rebuildHomepage(bindings.SITE_BUCKET, origin);
    const read = await readPosts(bindings.SITE_BUCKET, new URLSearchParams(), secret, at);
    expect(read.posts[0].items.map(item => item.category)).toEqual(categories);
    expect(read).not.toHaveProperty('warnings');
  });

  it('warns only for new items, preserving submitted indexes and category-before-timestamp order', async () => {
    const first = await publishDigest(bindings.SITE_BUCKET, digest(item('existing')), origin, at, true);
    const input = digest(item('existing', 'Traffic', '2099-01-01T00:00:00Z'),
      item('future', 'trafic', '2026-10-21T06:12:00-07:00'), item('future', 'bad', '2000-01-01T00:00:00Z'),
      item('stale', 'weather', '2000-01-01T00:00:00Z'));
    const before = await snapshot();
    const preview = await publishDigest(readOnlyBucket, input, origin, at, true, undefined, { dryRun: true });
    expect(await snapshot()).toEqual(before);
    const result = await publishDigest(bindings.SITE_BUCKET, input, origin, at, true);
    expect(result.warnings).toEqual(preview.warnings);
    expect(result.counts).toEqual({ submitted: 4, published: 2, duplicates: 2 });
    expect(result.counts).toEqual(preview.counts);
    expect(result.items).toMatchObject([
      { index: 0, status: 'duplicate', post_id: first.post!.id, item_index: 0 },
      { index: 1, status: 'published', item_index: 0 }, { index: 2, status: 'duplicate', item_index: 0 },
      { index: 3, status: 'published', item_index: 1 },
    ]);
    expect(result.warnings).toEqual([
      { index: 1, field: 'items[1].category', code: 'unknown_category', value: 'trafic', message: expect.any(String) },
      { index: 1, field: 'items[1].posted_at', code: 'posted_at_in_future', value: input.items[1].posted_at, message: expect.any(String), server_time: result.post!.received_at },
      { index: 3, field: 'items[3].posted_at', code: 'posted_at_stale', value: input.items[3].posted_at, message: expect.any(String), server_time: preview.checked_at },
    ]);
    expect((await storedPosts()).find(post => post.id === result.post!.id)!.items).toEqual([input.items[1], input.items[3]]);
    const committed = await snapshot();
    for (const dryRun of [true, false]) {
      const retry = await publishDigest(readOnlyBucket, input, origin, at, true, undefined, { dryRun });
      expect(retry).toMatchObject({ post: null, duplicate: true, counts: { submitted: 4, published: 0, duplicates: 4 } });
      expect(retry).not.toHaveProperty('warnings');
    }
    expect(await snapshot()).toEqual(committed);
  });

  it.each(['2000-01-01T00:00:00Z', '2099-01-01T00:00:00Z'])('warns for new appended timestamps with preview parity: %s', async posted_at => {
    const first = await publishDigest(bindings.SITE_BUCKET, digest(item('original', 'historical-category')), origin, at, true);
    const input = update('followup', posted_at);
    const before = await snapshot();
    const preview = await appendUpdate(readOnlyBucket, first.post!.id, 0, input, origin, at, true, undefined, { dryRun: true });
    expect(await snapshot()).toEqual(before);
    const result = await appendUpdate(bindings.SITE_BUCKET, first.post!.id, 0, input, origin, at, true);
    expect(result).toMatchObject({ status: 'appended', post_id: first.post!.id, item_index: 0, update_index: 0 });
    expect(result.warnings).toEqual(preview.warnings);
    expect(result.warnings).toEqual([{ field: 'posted_at', code: posted_at.startsWith('2000') ? 'posted_at_stale' : 'posted_at_in_future',
      value: posted_at, server_time: preview.checked_at, message: expect.any(String) }]);
    const stored = (await storedPosts())[0].items[0];
    expect(stored.category).toBe('historical-category');
    expect(stored.updates).toEqual([{ ...input, received_at: result.warnings![0].server_time }]);
    const committed = await snapshot();
    for (const dryRun of [true, false]) {
      const retry = await appendUpdate(readOnlyBucket, first.post!.id, 0, input, origin, at, true, undefined, { dryRun });
      expect(retry).toMatchObject({ status: 'duplicate', post_id: first.post!.id, item_index: 0, update_index: 0 });
      expect(retry).not.toHaveProperty('warnings');
    }
    expect(await snapshot()).toEqual(committed);
  });

  it('omits empty warning arrays and does not rewarn about target or historical fields', async () => {
    const first = await publishDigest(bindings.SITE_BUCKET, digest(item('historical', 'old-category', '2000-01-01T00:00:00Z')), origin, at, true);
    expect(await appendUpdate(bindings.SITE_BUCKET, first.post!.id, 0, update('current', at.toISOString()), origin, at, true)).not.toHaveProperty('warnings');
    for (const dryRun of [true, false]) {
      expect(await publishDigest(bindings.SITE_BUCKET, digest(item(`clean-${dryRun}`)), origin, at, true, undefined, { dryRun })).not.toHaveProperty('warnings');
      expect(await appendUpdate(bindings.SITE_BUCKET, first.post!.id, 0, update(`clean-update-${dryRun}`, at.toISOString()), origin, at, true, undefined, { dryRun })).not.toHaveProperty('warnings');
    }
  });

  it('passes warnings through HTTP/RPC for real and preview requests, and leaves reads and errors warning-free', async () => {
    const input = digest(item('http', 'Traffic', '2099-01-01T00:00:00Z'));
    const previewResponse = await request('/api/digests?dry_run=true', input);
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json<PublishResult>();
    expect(preview).toMatchObject({ ok: true, dry_run: true, committed: false });
    expect(preview.warnings).toMatchObject([{ code: 'unknown_category' }, { code: 'posted_at_in_future', server_time: preview.checked_at }]);
    expect(await snapshot()).toEqual([]);
    const response = await request('/api/digests', input);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-API-Version')).toBe('3');
    const result = await response.json<PublishResult>();
    expect(result).toMatchObject({ ok: true, counts: { published: 1, duplicates: 0 } });
    expect(result.warnings?.map(warning => warning.code)).toEqual(['unknown_category', 'posted_at_in_future']);
    const path = `/api/posts/${result.post!.id}/items/0/updates`;
    const before = await snapshot();
    const appendPreview = await (await request(path + '?dry_run=true', update('http-update', '2000-01-01T00:00:00Z'))).json<AppendResult>();
    expect(appendPreview).toMatchObject({ ok: true, dry_run: true, committed: false, status: 'appended',
      warnings: [{ code: 'posted_at_stale', server_time: appendPreview.checked_at }] });
    expect(await snapshot()).toEqual(before);
    const appended = await (await request(path, update('http-update', '2000-01-01T00:00:00Z'))).json<AppendResult>();
    expect(appended).toMatchObject({ ok: true, status: 'appended', warnings: [{ field: 'posted_at', code: 'posted_at_stale' }] });
    expect(appended.warnings![0]).not.toHaveProperty('index');
    const read = await worker.fetch(new Request(origin + '/api/posts', { headers: { Authorization: `Bearer ${secret}` } }), bindings);
    expect(await read.json()).not.toHaveProperty('warnings');
    for (const query of ['', '?dry_run=true']) {
      const invalid = digest({ ...input.items[0], posted_at: 'not-a-timestamp' });
      const failed = await request('/api/digests' + query, invalid);
      expect(failed.status).toBe(400);
      const error = await failed.json<any>();
      expect(error).toMatchObject({ ok: false, code: 'validation_failed', publication_status: 'not_attempted' });
      expect(error).not.toHaveProperty('warnings');
      const failedAppend = await request(path + query, { ...update('invalid', at.toISOString()), posted_at: 'not-a-timestamp' });
      expect(failedAppend.status).toBe(400);
      expect(await failedAppend.json()).not.toHaveProperty('warnings');
    }
  });
});
