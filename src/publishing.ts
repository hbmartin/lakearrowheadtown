import { createCardCache, prepareArchives, stableJson } from './archives';
import { committedSnapshot, isLegacyId } from './committed';
export { loadPublication } from './committed';
import { createImageResolver } from './image-metadata';
import { recentDates, renderPage } from './render';
import { renderRss, RSS_TYPE } from './rss';
import { HttpError, isDate, validateStoredDigest } from './validation';
import { lastReceivedAt, localDate } from './feed';
import { duplicateMessage, reviewStory } from './suggestions';
import { emit, fingerprint, OperationTrace } from './diagnostics';
import { boundary, DamagedSource } from './errors';
import { batchRecord, indexPost, loadHistoryIndex, retainedBatches } from './history-index';
import { prepareWrites } from './prepared-writes';
import type { AppendResult, ContentBucket, Digest, Migration, OperationContext, PostReference, Publication, PublicationStatus, PublishOptions, PublishResult, RetractResult, StoredPost, StoryIdentity, StoryUpdate } from './types';

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
  let digest: ReturnType<typeof validateStoredDigest>;
  try { digest = validateStoredDigest(input); }
  catch (error) {
    if (error instanceof HttpError && error.status === 400) throw new DamagedSource(ref.key, ref.id, 'invalid_digest');
    throw error;
  }
  return { ...digest, id: ref.id, date: ref.date, received_at: ref.received_at };
}

export async function currentPublication(bucket: ContentBucket, discover = () => legacyReferences(bucket), pinned?: Awaited<ReturnType<typeof committedSnapshot>>): Promise<Publication> {
  const snapshot = pinned ?? await committedSnapshot(bucket);
  const publication = await snapshot.publication();
  if (publication) return publication;
  // Bootstrap old deployments using server storage times, never client dates.
  const legacy = await discover();
  const anchor = snapshot.index?.uploaded ?? (legacy.length ? new Date([...legacy].sort(order)[0].received_at) : null);
  const days = anchor ? recentDates(anchor) : [];
  const archives = await snapshot.archives();
  return { version: 1, posts: legacy.filter(post => days.includes(post.date)).sort(order), snapshot_date: days[0] ?? null,
    published_at: anchor?.toISOString() ?? null, ...(archives === undefined ? {} : { archives }) };
}

function legacyReceipts(previous: Publication, additional: PostReference[] = []): Record<string, string> {
  const receipts = { ...previous.legacy_receipts };
  for (const ref of [...previous.posts, ...(previous.omitted_posts ?? []), ...additional]) {
    if (isLegacyId(ref.id) && !Object.hasOwn(receipts, ref.id)) receipts[ref.id] = ref.received_at;
  }
  return receipts;
}

async function prepareHomepage(bucket: ContentBucket, publication: Publication, posts: StoredPost[], origin: string, previous: Publication,
  trace = new OperationTrace(), options: { migrationComplete?: boolean; allCards?: boolean; now?: Date } = {}): Promise<void> {
  publication = { ...publication, version: 3 };
  delete publication.legacy_receipts;
  if (!options.migrationComplete) {
    const receipts = legacyReceipts(previous, [...publication.posts, ...(publication.omitted_posts ?? [])]);
    if (Object.keys(receipts).length) publication.legacy_receipts = receipts;
  }
  const resolve = createImageResolver(bucket, origin);
  const cards = createCardCache(bucket);
  let archives = previous.archives;
  // A first new publication must also retain the previous saved visible week,
  // even if that snapshot is now older than the incoming history window.
  if (!archives && previous.snapshot_date && previous.published_at !== publication.published_at) {
    const seed: StoredPost[] = [];
    for (const ref of previous.posts) {
      try { seed.push(await loadPost(bucket, ref)); }
      catch (error) { if (!(error instanceof DamagedSource)) throw error; }
    }
    archives = await prepareArchives(bucket, seed, previous, origin, undefined, trace, resolve, { cards });
  }
  publication.archives = await prepareArchives(bucket, posts, publication, origin, archives, trace, resolve, { cards, allCards: options.allCards });
  const images = await trace.run('image_metadata', () => resolve(posts.flatMap(post => post.items)));
  const html = await trace.run('rendering', () => boundary('rendering', () => renderPage(posts, { origin, publication, images })));
  const feed = await trace.run('rss_rendering', () => boundary('rendering', () => renderRss(posts, { origin, publication, images })));
  const manifest = `publications/${crypto.randomUUID()}.json`;
  const rss = manifest.replace(/\.json$/, '.rss.xml');
  const previousIndex = await trace.run('history_index_loading', () => loadHistoryIndex(bucket, previous));
  const batches = new Map(previousIndex.batches.map(batch => [batch.id, batch]));
  for (const post of posts) batches.set(post.id, batchRecord(post));
  const byId = new Map(posts.map(post => [post.id, post]));
  const index = { version: 1, posts: publication.posts.map(ref => indexPost(byId.get(ref.id)!)),
    batches: retainedBatches([...batches.values()], options.now ?? new Date()) };
  const indexBody = stableJson(index);
  publication.history_index = `history-index/${fingerprint(indexBody)}.json`;
  if (publication.history_index !== previous.history_index) await trace.run('history_index_write', () => boundary('storage', () => bucket.put(publication.history_index!, indexBody, { httpMetadata: { contentType: 'application/json' } })));
  const serialized = JSON.stringify(publication);
  await trace.run('manifest_write', () => boundary('storage', () => bucket.put(manifest, serialized, { httpMetadata: { contentType: 'application/json' } })));
  await trace.run('rss_write', () => boundary('storage', () => bucket.put(rss, feed, { httpMetadata: { contentType: RSS_TYPE, cacheControl: HTML_CACHE } })));
  // The single index replacement commits HTML and both immutable snapshot references.
  await trace.run('index_write', () => boundary('storage', () => bucket.put('pages/index.html', html, { httpMetadata: { contentType: 'text/html; charset=utf-8', cacheControl: HTML_CACHE }, customMetadata: { manifest, rss, archives: publication.archives! } })));
}

async function retainedSources(bucket: ContentBucket, now: Date, migrationComplete: boolean, trace: OperationTrace, context?: OperationContext) {
  const posts: StoredPost[] = [];
  const selected: PostReference[] = [];
  const omitted: PostReference[] = [];
  const days = recentDates(now, 30);
  let discovery: Promise<PostReference[]> | undefined;
  const discover = () => discovery ??= migrationComplete ? Promise.resolve([]) : legacyReferences(bucket);
  const previous = await trace.run('source_loading', async () => {
    const previous = await currentPublication(bucket, discover);
    // Preserve the established legacy migration window; never backfill old raw sources.
    const receipts = legacyReceipts(previous);
    const legacy = (await discover()).filter(ref => recentDates(now).includes(ref.date) && !Object.hasOwn(receipts, ref.id));
    const candidates = [...legacy, ...(previous.omitted_posts ?? []), ...previous.posts];
    const refs = [...new Map(candidates.map(ref => [ref.id, ref])).values()]
      .filter(ref => days.includes(localDate(new Date(ref.last_received_at ?? ref.received_at)))).sort(order);
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
    return previous;
  });
  return { posts, selected, omitted, days, previous };
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

export async function publishDigest(bucket: ContentBucket, digest: Digest, origin: string, now = new Date(), migrationComplete = false, context?: OperationContext, options: PublishOptions = {}): Promise<PublishResult> {
  const trace = new OperationTrace(context);
  const prepared = prepareWrites(bucket, trace);
  bucket = prepared.bucket;
  try {
    const days = recentDates(now);
    const { posts, selected, omitted, days: history, previous } = await retainedSources(bucket, now, migrationComplete, trace, context);
    const post: StoredPost = { ...digest, items: [], id: crypto.randomUUID(), date: days[0], received_at: now.toISOString(),
      ...(options.publisherFingerprint ? { publisher_fingerprint: options.publisherFingerprint } : {}) };
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
      if (digest.client_ref !== undefined) {
        const index = await trace.run('history_index_loading', () => loadHistoryIndex(bucket, previous));
        if (retainedBatches(index.batches, now).some(batch => batch.client_ref === digest.client_ref)) {
          throw new HttpError(409, 'client_ref already identifies a committed batch. Choose a new reference.', {}, { code: 'client_ref_conflict' });
        }
      }
      const serialized = JSON.stringify(post);
      await trace.run('source_write', () => boundary('storage', () => bucket.put(postKey(post), serialized, { httpMetadata: { contentType: 'application/json' } })));
      posts.push(post);
      selected.push(reference(post));
      selected.sort(order);
      // Preserve the established newest-receipt ordering of historical stories.
      posts.sort((a, b) => order(reference(a), reference(b)));
      await prepareHomepage(bucket, { version: 3, posts: selected, ...(omitted.length ? { omitted_posts: omitted } : {}), snapshot_date: days[0], published_at: now.toISOString() }, posts, origin, previous, trace, { migrationComplete, now });
      if (!options.dryRun) await prepared.commit();
    }
    const result: PublishResult = {
      post: post.items.length ? { id: post.id, date: post.date, received_at: post.received_at } : null,
      duplicate: items.length > 0 && post.items.length === 0, counts, items,
      ...(digest.client_ref === undefined ? {} : { client_ref: digest.client_ref }),
      ...(options.dryRun ? { dry_run: true as const, committed: false as const, checked_at: now.toISOString() } : {}),
    };
    emit(options.dryRun ? 'preview_result' : 'publish_result', context, { ...counts, post_id: result.post?.id, duplicate: result.duplicate, publication_outcome: options.dryRun ? 'preview' : result.duplicate ? 'duplicate' : 'published', ...(options.dryRun || result.duplicate ? {} : { publication_status: trace.publication_status }), duplicate_url_hashes: items.filter(item => item.status === 'duplicate').slice(0, 20).map(item => fingerprint(digest.items[item.index].post_url)) });
    return result;
  } catch (error) {
    throw new PublicationError(options.dryRun ? 'not_attempted' : trace.publication_status, trace.failed_stage ?? trace.stage ?? 'publication_processing', error);
  }
}

export async function appendUpdate(bucket: ContentBucket, postId: string, itemIndex: number, update: StoryUpdate, origin: string, now = new Date(), migrationComplete = false, context?: OperationContext, options: PublishOptions = {}): Promise<AppendResult> {
  const trace = new OperationTrace(context);
  const prepared = prepareWrites(bucket, trace);
  bucket = prepared.bucket;
  const preview = options.dryRun ? { dry_run: true as const, committed: false as const, checked_at: now.toISOString() } : {};
  try {
    const { posts, selected, omitted, days, previous } = await retainedSources(bucket, now, migrationComplete, trace, context);
    const damagedTarget = omitted.find(ref => ref.id === postId);
    if (damagedTarget) await loadPost(bucket, damagedTarget);
    const post = posts.find(post => post.id === postId);
    const item = post?.items[itemIndex];
    if (!post || !item || !Number.isSafeInteger(itemIndex) || itemIndex < 0 || !days.includes(localDate(new Date(lastReceivedAt(post, item))))) {
      throw new HttpError(404, 'This story is not available in the current 30-day history.', {}, { code: 'story_not_found' });
    }
    const match = await trace.run('duplicate_filtering', () => knownSources(posts, days).get(update.post_url));
    if (match) {
      emit(options.dryRun ? 'preview_result' : 'append_result', context, { post_id: match.post_id, item_index: match.item_index, update_index: match.update_index, publication_outcome: options.dryRun ? 'preview' : 'duplicate', duplicate_url_hashes: [fingerprint(update.post_url)] });
      return { status: 'duplicate', ...match, message: duplicateMessage, suggestion: reviewStory, ...preview };
    }
    const updateIndex = item.updates?.length ?? 0;
    item.updates = [...(item.updates ?? []), { ...update, received_at: now.toISOString() }];
    const key = `post-revisions/${post.id}/${crypto.randomUUID()}.json`;
    await trace.run('source_write', () => boundary('storage', () => bucket.put(key, JSON.stringify(post), { httpMetadata: { contentType: 'application/json' } })));
    const refs = selected.map(ref => ref.id === post.id ? { ...reference(post), key } : ref).sort(order);
    posts.sort((a, b) => order(reference(a), reference(b)));
    await prepareHomepage(bucket, { version: 3, posts: refs, ...(omitted.length ? { omitted_posts: omitted } : {}), snapshot_date: recentDates(now)[0], published_at: now.toISOString() }, posts, origin, previous, trace, { migrationComplete, now });
    if (!options.dryRun) await prepared.commit();
    emit(options.dryRun ? 'preview_result' : 'append_result', context, { post_id: post.id, item_index: itemIndex, update_index: updateIndex, publication_outcome: options.dryRun ? 'preview' : 'published', ...(options.dryRun ? {} : { publication_status: trace.publication_status }) });
    return { status: 'appended', post_id: post.id, item_index: itemIndex, update_index: updateIndex, message: options.dryRun ? 'The source would be added to this story.' : 'The source was added to this story and the publication was updated.', ...preview };
  } catch (error) {
    throw new PublicationError(options.dryRun ? 'not_attempted' : trace.publication_status, trace.failed_stage ?? trace.stage ?? 'append_processing', error);
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

export async function retractPost(bucket: ContentBucket, postId: string, publisherFingerprint: string, origin: string,
  now = new Date(), migrationComplete = false, context?: OperationContext): Promise<RetractResult> {
  const trace = new OperationTrace(context);
  const prepared = prepareWrites(bucket, trace);
  bucket = prepared.bucket;
  try {
    const previous = await trace.run('source_loading', () => currentPublication(bucket));
    const index = await trace.run('history_index_loading', () => loadHistoryIndex(bucket, previous));
    const batch = retainedBatches(index.batches, now).find(batch => batch.id === postId);
    const ref = [...previous.posts, ...(previous.omitted_posts ?? [])].find(ref => ref.id === postId);
    if (!batch && !ref) throw new HttpError(404, 'Post not found.', {}, { code: 'post_not_found' });
    if (!batch?.publisher_fingerprint || batch.publisher_fingerprint !== publisherFingerprint) {
      throw new HttpError(403, 'Only the token that published this batch may retract it.', {}, { code: 'retract_forbidden' });
    }
    if (batch.retracted_at) return { post_id: postId, status: 'already_retracted', retracted_at: batch.retracted_at };
    if (now.getTime() - Date.parse(batch.received_at) >= 24 * 60 * 60 * 1000) {
      throw new HttpError(409, 'The 24-hour self-retraction window has expired.', {}, { code: 'retract_window_expired' });
    }
    const retained = await retainedSources(bucket, now, migrationComplete, trace, context);
    const original = retained.posts.find(post => post.id === postId);
    const post: StoredPost = { ...(original ?? { ...batch, title: 'Retracted batch', source: 'retraction' }), items: [], retracted_at: now.toISOString() };
    const key = `post-revisions/${postId}/${crypto.randomUUID()}.json`;
    await trace.run('source_write', () => boundary('storage', () => bucket.put(key, JSON.stringify(post), { httpMetadata: { contentType: 'application/json' } })));
    const refs = [...retained.selected.filter(ref => ref.id !== postId), { ...reference(post), key }].sort(order);
    const posts = [...retained.posts.filter(post => post.id !== postId), post].sort((a, b) => order(reference(a), reference(b)));
    const omitted = retained.omitted.filter(ref => ref.id !== postId);
    await prepareHomepage(bucket, { version: 3, posts: refs, ...(omitted.length ? { omitted_posts: omitted } : {}),
      snapshot_date: recentDates(now)[0], published_at: now.toISOString() }, posts, origin, previous, trace, { migrationComplete, now });
    await prepared.commit();
    emit('retract_result', context, { post_id: postId, publication_status: trace.publication_status, publication_outcome: 'retracted' });
    return { post_id: postId, status: 'retracted', retracted_at: post.retracted_at! };
  } catch (error) {
    throw new PublicationError(trace.publication_status, trace.failed_stage ?? trace.stage ?? 'retract_processing', error);
  }
}

export async function rebuildHomepage(bucket: ContentBucket, origin: string, trace = new OperationTrace(), migrationComplete = false, previous?: Publication): Promise<void> {
  const prepared = prepareWrites(bucket, trace);
  bucket = prepared.bucket;
  previous ??= await trace.run('source_loading', () => currentPublication(bucket, migrationComplete ? async () => [] : undefined));
  // Migration finishes before rendering; imported sources now have canonical keys.
  const publication = { ...previous, posts: previous.posts.map(ref => ref.key.startsWith('digests/') ? { ...ref, key: postKey(ref) } : ref) };
  const posts: StoredPost[] = [];
  await trace.run('source_loading', async () => {
    for (const ref of publication.posts) posts.push(await loadPost(bucket, ref));
  });
  await prepareHomepage(bucket, publication, posts, origin, previous, trace, { migrationComplete, allCards: true });
  await prepared.commit();
}
