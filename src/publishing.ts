import { recentDates, renderPage } from './render';
import { renderRss, RSS_TYPE } from './rss';
import { HttpError, isDate, validateDigest } from './validation';
import { emit, fingerprint, OperationTrace } from './diagnostics';
import { boundary, DamagedSource } from './errors';
import type { ContentBucket, Digest, Migration, OperationContext, PostReference, Publication, PublicationStatus, PublishResult, StoredPost } from './types';

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
    const page = await boundary('storage', () => bucket.list({ prefix: 'digests/', cursor }));
    for (const object of page.objects) {
      const ref = legacyReference(object);
      if (ref) references.push(ref);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return references;
}

export async function loadPost(bucket: ContentBucket, ref: PostReference): Promise<StoredPost> {
  const source = await boundary('storage', () => bucket.get(ref.key));
  if (!source) throw new DamagedSource(ref.key, ref.id, 'missing');
  // Keep body transport errors outside the parse/validation catches.
  const text = await boundary('storage', () => source.text());
  let input: unknown;
  try { input = JSON.parse(text); }
  catch (error) {
    if (error instanceof SyntaxError) throw new DamagedSource(ref.key, ref.id, 'invalid_json');
    throw error;
  }
  let digest: Digest;
  try { digest = validateDigest(input); }
  catch (error) {
    if (error instanceof HttpError && error.status === 400) throw new DamagedSource(ref.key, ref.id, 'invalid_digest');
    throw error;
  }
  return { ...digest, id: ref.id, date: ref.date, received_at: ref.received_at };
}

export async function currentPublication(bucket: ContentBucket): Promise<Publication> {
  const index = await boundary('storage', () => bucket.head('pages/index.html'));
  const key = index?.customMetadata?.manifest;
  if (key) {
    const object = await boundary('storage', () => bucket.get(key));
    if (!object) throw new Error('Missing publication manifest');
    return JSON.parse(await boundary('storage', () => object.text())) as Publication;
  }
  // Bootstrap old deployments using server storage times, never client dates.
  const legacy = await legacyReferences(bucket);
  const anchor = index?.uploaded ?? (legacy.length ? new Date([...legacy].sort(order)[0].received_at) : null);
  const days = anchor ? recentDates(anchor) : [];
  return { version: 1, posts: legacy.filter(post => days.includes(post.date)).sort(order), snapshot_date: days[0] ?? null, published_at: anchor?.toISOString() ?? null };
}

async function writeHomepage(bucket: ContentBucket, publication: Publication, posts: StoredPost[], origin: string, trace = new OperationTrace()): Promise<void> {
  const html = await trace.run('rendering', () => boundary('rendering', () => renderPage(posts, { origin, publication })));
  const feed = await trace.run('rss_rendering', () => boundary('rendering', () => renderRss(posts, { origin, publication })));
  const manifest = `publications/${crypto.randomUUID()}.json`;
  const rss = manifest.replace(/\.json$/, '.rss.xml');
  const serialized = JSON.stringify(publication);
  await trace.run('manifest_write', () => boundary('storage', () => bucket.put(manifest, serialized, { httpMetadata: { contentType: 'application/json' } })));
  await trace.run('rss_write', () => boundary('storage', () => bucket.put(rss, feed, { httpMetadata: { contentType: RSS_TYPE, cacheControl: HTML_CACHE } })));
  // The single index replacement commits HTML and both immutable snapshot references.
  trace.publication_status = 'unknown';
  await trace.run('index_write', () => boundary('storage', () => bucket.put('pages/index.html', html, { httpMetadata: { contentType: 'text/html; charset=utf-8', cacheControl: HTML_CACHE }, customMetadata: { manifest, rss } })));
  trace.publication_status = 'committed';
}

export class PublicationError extends Error {
  constructor(public publication_status: PublicationStatus, public stage: string, public cause: unknown) {
    super('Digest publication failed');
    this.name = 'PublicationError';
  }
}

export async function publishDigest(bucket: ContentBucket, digest: Digest, origin: string, now = new Date(), migrationComplete = false, context?: OperationContext): Promise<PublishResult> {
  const trace = new OperationTrace(context);
  try {
    const days = recentDates(now);
    const posts: StoredPost[] = [];
    const selected: PostReference[] = [];
    const omitted: PostReference[] = [];
    await trace.run('source_loading', async () => {
      const previous = await currentPublication(bucket);
      // Existing references take precedence over duplicate legacy backup objects.
      const candidates = [...(!migrationComplete ? await legacyReferences(bucket) : []), ...(previous.omitted_posts ?? []), ...previous.posts];
      const refs = [...new Map(candidates.filter(ref => days.includes(ref.date)).map(ref => [ref.id, ref])).values()].sort(order);
      for (const ref of refs) {
        try {
          posts.push(await loadPost(bucket, ref));
          selected.push(ref);
        } catch (error) {
          if (!(error instanceof DamagedSource)) throw error;
          omitted.push(ref);
          // Keep the established fixed warning for operators and legacy callers.
          console.warn('Omitted damaged post', { id: ref.id, key: ref.key, reason: error.reason });
          emit('source_omitted', context, { post_id: ref.id, source_key: ref.key, reason: error.reason }, 'warn');
        }
      }
    });
    const post: StoredPost = { ...digest, items: [], id: crypto.randomUUID(), date: days[0], received_at: now.toISOString() };
    const items = await trace.run('duplicate_filtering', () => {
      const known = new Map<string, { post_id: string; item_index: number }>();
      // Oldest receipt wins; input item positions break the remaining ties.
      for (const old of [...posts].sort((a, b) => a.received_at.localeCompare(b.received_at) || a.id.localeCompare(b.id))) {
        old.items.forEach((item, item_index) => {
          if (!known.has(item.post_url)) known.set(item.post_url, { post_id: old.id, item_index });
        });
      }
      return digest.items.map((item, index): PublishResult['items'][number] => {
        const match = known.get(item.post_url);
        if (match) return { index, status: 'duplicate', ...match };
        const identity = { post_id: post.id, item_index: post.items.length };
        post.items.push(item);
        known.set(item.post_url, identity);
        return { index, status: 'published', ...identity };
      });
    });
    const counts = { submitted: items.length, published: post.items.length, duplicates: items.length - post.items.length };
    if (post.items.length) {
      const serialized = JSON.stringify(post);
      await trace.run('source_write', () => boundary('storage', () => bucket.put(postKey(post), serialized, { httpMetadata: { contentType: 'application/json' } })));
      posts.push(post);
      selected.push(reference(post));
      selected.sort(order);
      // Preserve the established newest-receipt ordering of historical stories.
      posts.sort((a, b) => order(reference(a), reference(b)));
      await writeHomepage(bucket, { version: 1, posts: selected, ...(omitted.length ? { omitted_posts: omitted } : {}), snapshot_date: days[0], published_at: now.toISOString() }, posts, origin, trace);
    }
    const result: PublishResult = {
      post: post.items.length ? { id: post.id, date: post.date, received_at: post.received_at } : null,
      duplicate: items.length > 0 && post.items.length === 0, counts, items,
    };
    emit('publish_result', context, { ...counts, post_id: result.post?.id, duplicate: result.duplicate, publication_outcome: result.duplicate ? 'duplicate' : 'published', ...(result.duplicate ? {} : { publication_status: trace.publication_status }), duplicate_url_hashes: items.filter(item => item.status === 'duplicate').slice(0, 20).map(item => fingerprint(digest.items[item.index].post_url)) });
    return result;
  } catch (error) {
    throw new PublicationError(trace.publication_status, trace.failed_stage ?? trace.stage ?? 'publication_processing', error);
  }
}

export async function migrateBatch(bucket: ContentBucket, migration: Migration): Promise<Migration> {
  if (migration.complete) return migration;
  const page = await boundary('storage', () => bucket.list({ prefix: 'digests/', cursor: migration.cursor, limit: 25 }));
  let processed = migration.processed;
  for (const object of page.objects) {
    const ref = legacyReference(object);
    if (!ref) continue;
    const post = await loadPost(bucket, ref);
    const serialized = JSON.stringify(post);
    await boundary('storage', () => bucket.put(postKey(post), serialized, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } }));
    processed++;
  }
  return { processed, complete: !page.truncated, ...(page.truncated ? { cursor: page.cursor } : {}) };
}

export async function rebuildHomepage(bucket: ContentBucket, origin: string, trace = new OperationTrace()): Promise<void> {
  const publication = await trace.run('source_loading', () => currentPublication(bucket));
  // Migration finishes before rendering; imported sources now have canonical keys.
  publication.posts = publication.posts.map(ref => ref.id.startsWith('legacy-') ? { ...ref, key: postKey(ref) } : ref);
  const posts: StoredPost[] = [];
  await trace.run('source_loading', async () => {
    for (const ref of publication.posts) posts.push(await loadPost(bucket, ref));
  });
  await writeHomepage(bucket, publication, posts, origin, trace);
}
