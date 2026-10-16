import { recentDates, renderPage } from './render';
import { HttpError, isDate, validateDigest } from './validation';
import type { ContentBucket, Digest, Migration, PostReference, Publication, StoredPost } from './types';

export const HTML_CACHE = 'public, max-age=0, must-revalidate';
export const initialMigration = (): Migration => ({ processed: 0, complete: false });
export const postKey = (post: Pick<PostReference, 'date' | 'id'>) => `posts/${post.date}/${post.id}.json`;
const reference = (post: StoredPost): PostReference => ({ id: post.id, key: postKey(post), date: post.date, received_at: post.received_at });
const order = (a: PostReference, b: PostReference) => b.received_at.localeCompare(a.received_at) || b.id.localeCompare(a.id);

function legacyReference(object: R2Object): PostReference | null {
  const date = /^digests\/(\d{4}-\d{2}-\d{2})\.json$/.exec(object.key)?.[1];
  return date && isDate(date) ? { id: `legacy-${date}`, key: object.key, date: recentDates(object.uploaded)[0], received_at: object.uploaded.toISOString() } : null;
}

async function legacyReferences(bucket: ContentBucket): Promise<PostReference[]> {
  const references: PostReference[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: 'digests/', cursor });
    for (const object of page.objects) {
      const ref = legacyReference(object);
      if (ref) references.push(ref);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return references;
}

class DamagedSource extends Error {
  constructor(public reason: 'missing' | 'invalid_json' | 'invalid_digest') { super('Damaged published source'); }
}

export async function loadPost(bucket: ContentBucket, ref: PostReference): Promise<StoredPost> {
  const source = await bucket.get(ref.key);
  if (!source) throw new DamagedSource('missing');
  // Keep body transport errors outside the parse/validation catches.
  const text = await source.text();
  let input: unknown;
  try { input = JSON.parse(text); }
  catch (error) {
    if (error instanceof SyntaxError) throw new DamagedSource('invalid_json');
    throw error;
  }
  let digest: Digest;
  try { digest = validateDigest(input); }
  catch (error) {
    if (error instanceof HttpError && error.status === 400) throw new DamagedSource('invalid_digest');
    throw error;
  }
  return { ...digest, id: ref.id, date: ref.date, received_at: ref.received_at };
}

export async function currentPublication(bucket: ContentBucket): Promise<Publication> {
  const index = await bucket.head('pages/index.html');
  const key = index?.customMetadata?.manifest;
  if (key) {
    const object = await bucket.get(key);
    if (!object) throw new Error('Missing publication manifest');
    return object.json<Publication>();
  }
  // Bootstrap old deployments using server storage times, never client dates.
  const legacy = await legacyReferences(bucket);
  const anchor = index?.uploaded ?? (legacy.length ? new Date([...legacy].sort(order)[0].received_at) : null);
  const days = anchor ? recentDates(anchor) : [];
  return { version: 1, posts: legacy.filter(post => days.includes(post.date)).sort(order), snapshot_date: days[0] ?? null, published_at: anchor?.toISOString() ?? null };
}

async function writeHomepage(bucket: ContentBucket, publication: Publication, posts: StoredPost[], origin: string): Promise<void> {
  const html = renderPage(posts, { origin, publication });
  const manifest = `publications/${crypto.randomUUID()}.json`;
  await bucket.put(manifest, JSON.stringify(publication), { httpMetadata: { contentType: 'application/json' } });
  // The single index replacement commits both HTML and its manifest reference.
  await bucket.put('pages/index.html', html, { httpMetadata: { contentType: 'text/html; charset=utf-8', cacheControl: HTML_CACHE }, customMetadata: { manifest } });
}

export async function publishDigest(bucket: ContentBucket, digest: Digest, origin: string, now = new Date(), migrationComplete = false): Promise<StoredPost> {
  const post: StoredPost = { ...digest, id: crypto.randomUUID(), date: recentDates(now)[0], received_at: now.toISOString() };
  const previous = await currentPublication(bucket);
  const days = recentDates(now);
  // Existing references take precedence over duplicate legacy backup objects.
  const candidates = [...(!migrationComplete ? await legacyReferences(bucket) : []), ...(previous.omitted_posts ?? []), ...previous.posts, reference(post)];
  const refs = [...new Map(candidates.filter(ref => days.includes(ref.date)).map(ref => [ref.id, ref])).values()].sort(order);
  await bucket.put(postKey(post), JSON.stringify(post), { httpMetadata: { contentType: 'application/json' } });
  const posts: StoredPost[] = [];
  const selected: PostReference[] = [];
  const omitted: PostReference[] = [];
  for (const ref of refs) {
    try {
      posts.push(ref.id === post.id ? post : await loadPost(bucket, ref));
      selected.push(ref);
    } catch (error) {
      if (!(error instanceof DamagedSource)) throw error;
      omitted.push(ref);
      console.warn('Omitted damaged post', { id: ref.id, key: ref.key, reason: error.reason });
    }
  }
  await writeHomepage(bucket, { version: 1, posts: selected, ...(omitted.length ? { omitted_posts: omitted } : {}), snapshot_date: days[0], published_at: now.toISOString() }, posts, origin);
  return post;
}

export async function migrateBatch(bucket: ContentBucket, migration: Migration): Promise<Migration> {
  if (migration.complete) return migration;
  const page = await bucket.list({ prefix: 'digests/', cursor: migration.cursor, limit: 25 });
  let processed = migration.processed;
  for (const object of page.objects) {
    const ref = legacyReference(object);
    if (!ref) continue;
    const post = await loadPost(bucket, ref);
    await bucket.put(postKey(post), JSON.stringify(post), { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
    processed++;
  }
  return { processed, complete: !page.truncated, ...(page.truncated ? { cursor: page.cursor } : {}) };
}

export async function rebuildHomepage(bucket: ContentBucket, origin: string): Promise<void> {
  const publication = await currentPublication(bucket);
  // Migration finishes before rendering; imported sources now have canonical keys.
  publication.posts = publication.posts.map(ref => ref.id.startsWith('legacy-') ? { ...ref, key: postKey(ref) } : ref);
  const posts: StoredPost[] = [];
  for (const ref of publication.posts) posts.push(await loadPost(bucket, ref));
  await writeHomepage(bucket, publication, posts, origin);
}
