import { prepareArchives } from './archives';
import { resolveImages } from './image-metadata';
import { recentDates, renderPage } from './render';
import { renderRss, RSS_TYPE } from './rss';
import { HttpError, isDate, isTimestamp, validateDigest, validateStoredItems } from './validation';
import { lastReceivedAt, localDate } from './feed';
import { duplicateMessage, reviewStory } from './suggestions';
import { emit, fingerprint, OperationTrace } from './diagnostics';
import { boundary, DamagedManifest, DamagedSource } from './errors';
import type { AppendResult, ContentBucket, Digest, Migration, OperationContext, PostReference, Publication, PublicationStatus, PublishResult, StoredPost, StoryIdentity, StoryUpdate } from './types';

export const HTML_CACHE = 'public, max-age=0, must-revalidate';
export const initialMigration = (): Migration => ({ processed: 0, complete: false });
export const postKey = (post: Pick<PostReference, 'date' | 'id'>) => `posts/${post.date}/${post.id}.json`;
const reference = (post: StoredPost): PostReference => ({ id: post.id, key: postKey(post), date: post.date, received_at: post.received_at,
  last_received_at: post.items.reduce((latest, item) => Date.parse(lastReceivedAt(post, item)) > Date.parse(latest) ? lastReceivedAt(post, item) : latest, post.received_at) });
const order = (a: PostReference, b: PostReference) => Date.parse(b.last_received_at ?? b.received_at) - Date.parse(a.last_received_at ?? a.received_at) || b.id.localeCompare(a.id);

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
  try { digest = { ...validateDigest(input), items: validateStoredItems(input) }; }
  catch (error) {
    if (error instanceof HttpError && error.status === 400) throw new DamagedSource(ref.key, ref.id, 'invalid_digest');
    throw error;
  }
  return { ...digest, id: ref.id, date: ref.date, received_at: ref.received_at };
}

export async function currentPublication(bucket: ContentBucket): Promise<Publication> {
  const index = await boundary('storage', () => bucket.head('pages/index.html'));
  const key = index?.customMetadata?.manifest;
  if (key) return loadPublication(bucket, key);
  // Bootstrap old deployments using server storage times, never client dates.
  const legacy = await legacyReferences(bucket);
  const anchor = index?.uploaded ?? (legacy.length ? new Date([...legacy].sort(order)[0].received_at) : null);
  const days = anchor ? recentDates(anchor) : [];
  return { version: 1, posts: legacy.filter(post => days.includes(post.date)).sort(order), snapshot_date: days[0] ?? null, published_at: anchor?.toISOString() ?? null };
}

export async function loadPublication(bucket: ContentBucket, key: string): Promise<Publication> {
  const object = await boundary('storage', () => bucket.get(key));
  if (!object) throw new DamagedManifest(key, 'missing');
  const text = await boundary('storage', () => object.text());
  let publication: unknown;
  try { publication = JSON.parse(text); }
  catch (error) {
    if (error instanceof SyntaxError) throw new DamagedManifest(key, 'invalid_json');
    throw error;
  }
  if (!isPublication(publication)) throw new DamagedManifest(key, 'invalid_manifest');
  return publication;
}

function isPublication(value: unknown): value is Publication {
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
  const date = (value: unknown) => typeof value === 'string' && isDate(value);
  const refs = (value: unknown) => Array.isArray(value) && value.every(ref => record(ref)
    && text(ref.id) && text(ref.key) && date(ref.date) && isTimestamp(ref.received_at)
    && (ref.last_received_at === undefined || isTimestamp(ref.last_received_at)));
  return record(value) && (value.version === 1 || value.version === 2) && refs(value.posts)
    && (value.omitted_posts === undefined || refs(value.omitted_posts))
    && (value.archives === undefined || (typeof value.archives === 'string' && /^archive-catalogs\/[a-f0-9]{64}\.json$/.test(value.archives)))
    && (value.snapshot_date === null || date(value.snapshot_date))
    && (value.published_at === null || isTimestamp(value.published_at));
}

async function writeHomepage(bucket: ContentBucket, publication: Publication, posts: StoredPost[], origin: string, trace = new OperationTrace()): Promise<void> {
  publication = { ...publication, version: 2 };
  const previous = await trace.run('archive_loading', () => currentPublication(bucket));
  let archives = previous.archives;
  // A first new publication must also retain the previous saved visible week,
  // even if that snapshot is now older than the incoming history window.
  if (!archives && previous.snapshot_date && previous.published_at !== publication.published_at) {
    const seed: StoredPost[] = [];
    for (const ref of previous.posts) {
      try { seed.push(await loadPost(bucket, ref)); }
      catch (error) { if (!(error instanceof DamagedSource)) throw error; }
    }
    archives = await prepareArchives(bucket, seed, previous, origin, undefined, trace);
  }
  publication.archives = await prepareArchives(bucket, posts, publication, origin, archives, trace);
  const images = await trace.run('image_metadata', () => resolveImages(bucket, posts.flatMap(post => post.items), origin));
  const html = await trace.run('rendering', () => boundary('rendering', () => renderPage(posts, { origin, publication, images })));
  const feed = await trace.run('rss_rendering', () => boundary('rendering', () => renderRss(posts, { origin, publication, images })));
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

async function retainedSources(bucket: ContentBucket, now: Date, migrationComplete: boolean, trace: OperationTrace, context?: OperationContext) {
  const posts: StoredPost[] = [];
  const selected: PostReference[] = [];
  const omitted: PostReference[] = [];
  const days = recentDates(now, 30);
  await trace.run('source_loading', async () => {
    const previous = await currentPublication(bucket);
    // Preserve the established legacy migration window; never backfill old raw sources.
    const legacy = !migrationComplete && previous.version === 1 ? (await legacyReferences(bucket)).filter(ref => recentDates(now).includes(ref.date)) : [];
    const candidates = [...legacy, ...(previous.omitted_posts ?? []), ...previous.posts];
    const refs = [...new Map(candidates.filter(ref => days.includes(localDate(new Date(ref.last_received_at ?? ref.received_at)))).map(ref => [ref.id, ref])).values()].sort(order);
    for (const ref of refs) {
      try {
        posts.push(await loadPost(bucket, ref));
        selected.push(ref);
      } catch (error) {
        if (!(error instanceof DamagedSource)) throw error;
        omitted.push(ref);
        console.warn('Omitted damaged post', { id: ref.id, key: ref.key, reason: error.reason });
        emit('source_omitted', context, { post_id: ref.id, source_key: ref.key, reason: error.reason }, 'warn');
      }
    }
  });
  return { posts, selected, omitted, days };
}

function knownSources(posts: StoredPost[], days: string[]): Map<string, StoryIdentity> {
  const sources = posts.flatMap(post => post.items.flatMap((item, item_index) => {
    if (!days.includes(localDate(new Date(lastReceivedAt(post, item))))) return [];
    const identity = { post_id: post.id, item_index };
    return [{ url: item.post_url, received_at: post.received_at, ...identity, update_index: undefined as number | undefined },
      ...(item.updates ?? []).map((update, update_index) => ({ url: update.post_url, received_at: update.received_at, ...identity, update_index }))];
  })).sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at) || a.post_id.localeCompare(b.post_id) || a.item_index - b.item_index || (a.update_index ?? -1) - (b.update_index ?? -1));
  const known = new Map<string, StoryIdentity>();
  for (const { url, post_id, item_index, update_index } of sources) {
    if (!known.has(url)) known.set(url, { post_id, item_index, ...(update_index !== undefined ? { update_index } : {}) });
  }
  return known;
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
    const { posts, selected, omitted, days: history } = await retainedSources(bucket, now, migrationComplete, trace, context);
    const post: StoredPost = { ...digest, items: [], id: crypto.randomUUID(), date: days[0], received_at: now.toISOString() };
    const items = await trace.run('duplicate_filtering', () => {
      const known = knownSources(posts, history);
      return digest.items.map((item, index): PublishResult['items'][number] => {
        const match = known.get(item.post_url);
        if (match) return { index, status: 'duplicate', ...match, message: duplicateMessage, suggestion: reviewStory };
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
      await writeHomepage(bucket, { version: 2, posts: selected, ...(omitted.length ? { omitted_posts: omitted } : {}), snapshot_date: days[0], published_at: now.toISOString() }, posts, origin, trace);
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

export async function appendUpdate(bucket: ContentBucket, postId: string, itemIndex: number, update: StoryUpdate, origin: string, now = new Date(), migrationComplete = false, context?: OperationContext): Promise<AppendResult> {
  const trace = new OperationTrace(context);
  try {
    const { posts, selected, omitted, days } = await retainedSources(bucket, now, migrationComplete, trace, context);
    const damagedTarget = omitted.find(ref => ref.id === postId);
    if (damagedTarget) await loadPost(bucket, damagedTarget);
    const post = posts.find(post => post.id === postId);
    const item = post?.items[itemIndex];
    if (!post || !item || !Number.isSafeInteger(itemIndex) || itemIndex < 0 || !days.includes(localDate(new Date(lastReceivedAt(post, item))))) {
      throw new HttpError(404, 'This story is not available in the current 30-day history.', {}, { code: 'story_not_found' });
    }
    const match = await trace.run('duplicate_filtering', () => knownSources(posts, days).get(update.post_url));
    if (match) {
      emit('append_result', context, { post_id: match.post_id, item_index: match.item_index, update_index: match.update_index, publication_outcome: 'duplicate', duplicate_url_hashes: [fingerprint(update.post_url)] });
      return { status: 'duplicate', ...match, message: duplicateMessage, suggestion: reviewStory };
    }
    const updateIndex = item.updates?.length ?? 0;
    item.updates = [...(item.updates ?? []), { ...update, received_at: now.toISOString() }];
    const key = `post-revisions/${post.id}/${crypto.randomUUID()}.json`;
    await trace.run('source_write', () => boundary('storage', () => bucket.put(key, JSON.stringify(post), { httpMetadata: { contentType: 'application/json' } })));
    const refs = selected.map(ref => ref.id === post.id ? { ...reference(post), key } : ref).sort(order);
    posts.sort((a, b) => order(reference(a), reference(b)));
    await writeHomepage(bucket, { version: 2, posts: refs, ...(omitted.length ? { omitted_posts: omitted } : {}), snapshot_date: recentDates(now)[0], published_at: now.toISOString() }, posts, origin, trace);
    emit('append_result', context, { post_id: post.id, item_index: itemIndex, update_index: updateIndex, publication_outcome: 'published', publication_status: trace.publication_status });
    return { status: 'appended', post_id: post.id, item_index: itemIndex, update_index: updateIndex, message: 'The source was added to this story and the publication was updated.' };
  } catch (error) {
    throw new PublicationError(trace.publication_status, trace.failed_stage ?? trace.stage ?? 'append_processing', error);
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
  publication.posts = publication.posts.map(ref => ref.key.startsWith('digests/') ? { ...ref, key: postKey(ref) } : ref);
  const posts: StoredPost[] = [];
  await trace.run('source_loading', async () => {
    for (const ref of publication.posts) posts.push(await loadPost(bucket, ref));
  });
  await writeHomepage(bucket, publication, posts, origin, trace);
}
