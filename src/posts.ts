import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { boundary, HttpError, isPublishReply } from './errors';
import { lastReceivedAt, latestActivity, localDate, recentDates } from './feed';
import { currentPublication, loadPost, loadPublication } from './publishing';
import { isTimestamp } from './validation';
import type { ContentBucket, PostReference, PublishFailure } from './types';

interface Cursor { snapshot: string; as_of: string; days: number; offset: number }
const invalidCursor = () => new HttpError(400, 'The cursor is invalid or does not match days. Start a fresh read.', {}, { code: 'invalid_cursor' });
const signature = (payload: string, secret: string) => createHmac('sha256', secret).update(`posts-v1:${payload}`).digest();

function encodeCursor(cursor: Cursor, secret: string): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${payload}.${signature(payload, secret).toString('base64url')}`;
}

function decodeCursor(value: string, secret: string): Cursor {
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw invalidCursor();
  const [payload, supplied] = value.split('.');
  const actual = Buffer.from(supplied, 'base64url');
  const expected = signature(payload, secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalidCursor();
  let cursor: Cursor;
  try { cursor = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { throw invalidCursor(); }
  if (!cursor || typeof cursor !== 'object' || typeof cursor.snapshot !== 'string' || !/^[A-Za-z0-9-]+$/.test(cursor.snapshot)
    || !isTimestamp(cursor.as_of) || !Number.isInteger(cursor.days) || cursor.days < 1 || cursor.days > 30
    || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw invalidCursor();
  return cursor;
}

export async function readPosts(bucket: ContentBucket, query: URLSearchParams, secret: string, now = new Date()) {
  if (query.getAll('days').length > 1 || query.getAll('cursor').length > 1) throw invalidCursor();
  const suppliedDays = query.get('days');
  if (suppliedDays !== null && (!/^(?:[1-9]|[12][0-9]|30)$/.test(suppliedDays))) {
    throw new HttpError(400, 'days must be an integer between 1 and 30.', {}, { code: 'invalid_days' });
  }
  const token = query.get('cursor');
  const cursor = token !== null ? decodeCursor(token, secret) : undefined;
  const days = suppliedDays === null ? cursor?.days ?? 7 : Number(suppliedDays);
  if (cursor && cursor.days !== days) throw invalidCursor();
  const manifest = cursor ? `publications/${cursor.snapshot}.json` : (await boundary('storage', () => bucket.head('pages/index.html')))?.customMetadata?.manifest;
  const publication = manifest ? await loadPublication(bucket, manifest) : await currentPublication(bucket);
  const asOf = cursor?.as_of ?? now.toISOString();
  const dates = recentDates(new Date(asOf), days);
  let offset = cursor?.offset ?? 0;
  if (offset > publication.posts.length) throw invalidCursor();
  const posts = [];
  while (offset < publication.posts.length && posts.length < 20) {
    const refs: PostReference[] = [];
    // Never prefetch beyond the number of remaining response slots.
    const capacity = Math.min(4, 20 - posts.length);
    while (offset < publication.posts.length && refs.length < capacity) {
      const ref = publication.posts[offset++];
      if (dates.includes(localDate(new Date(ref.last_received_at ?? ref.received_at)))) refs.push(ref);
    }
    const loaded = await Promise.allSettled(refs.map(ref => loadPost(bucket, ref)));
    for (const result of loaded) {
      // Completion order must not change source or failure ordering.
      if (result.status === 'rejected') throw result.reason;
      const post = result.value;
      const items = post.items.flatMap((item, item_index) => {
        const last_received_at = lastReceivedAt(post, item);
        if (!dates.includes(localDate(new Date(last_received_at)))) return [];
        return [{ ...item, item_index, last_received_at, latest_activity_at: latestActivity(item),
          updates: (item.updates ?? []).map((update, update_index) => ({ ...update, update_index })) }];
      });
      if (items.length) posts.push({ post_id: post.id, date: post.date, received_at: post.received_at, title: post.title, source: post.source, items });
    }
  }

  return { days, as_of: asOf, published_at: publication.published_at, posts,
    omitted_post_ids: (publication.omitted_posts ?? []).map(ref => ref.id),
    message: publication.omitted_posts?.length ? 'Some sources were omitted from this publication because they require operator repair.' : 'Published stories are ready to review.',
    next_cursor: manifest && offset < publication.posts.length ? encodeCursor({ snapshot: manifest.slice('publications/'.length, -'.json'.length), as_of: asOf, days, offset }, secret) : null };
}

export type PostsReply = { ok: true; result: Awaited<ReturnType<typeof readPosts>> } | { ok: false; failure: PublishFailure };

export function isPostsReply(value: unknown): value is PostsReply {
  if (!value || typeof value !== 'object') return false;
  const reply = value as Record<string, any>;
  if (reply.ok === false) return isPublishReply(value);
  const r = reply.result;
  return reply.ok === true && !!r && Number.isInteger(r.days) && r.days >= 1 && r.days <= 30 && isTimestamp(r.as_of)
    && (r.published_at === null || isTimestamp(r.published_at)) && Array.isArray(r.posts) && Array.isArray(r.omitted_post_ids)
    && typeof r.message === 'string' && (r.next_cursor === null || typeof r.next_cursor === 'string');
}
