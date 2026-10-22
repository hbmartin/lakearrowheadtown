import { boundary } from './errors';
import { archiveUnavailable, validArchiveKey } from './committed';
import { latestActivity, localDate, selectFeedItems, snapshotDates } from './feed';
import { hashBytes, IMAGE_CACHE } from './images';
import { createImageResolutionCache, createImageResolver, validImageMetadata, type ImageMetadataMap, type ImageResolver, type ImageResolutionCache } from './image-metadata';
import { dailyCard, DAILY_CARD_VERSION } from './social';
import { isDate, isTimestamp, validateStoredDigest } from './validation';
import type { ArchiveProgress, ContentBucket, Publication, StoredPost } from './types';
import type { OperationTrace } from './diagnostics';
import { fingerprint, record } from './primitives';
import { prepareWrites } from './prepared-writes';

export type ArchiveStory = ReturnType<typeof selectFeedItems>[number];
export interface ArchiveDay { date: string; stories: ArchiveStory[]; images: ImageMetadataMap }
export interface ArchiveReference { key: string; image: string; modified?: string; cardVersion?: number; identities: string[] }
export interface ArchiveCatalog { version: 1; days: Record<string, ArchiveReference> }
export const stableJson = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const identity = (story: Pick<ArchiveStory, 'postId' | 'itemIndex'>) => `${story.postId}:${story.itemIndex}`;
export const archivePath = (date: string) => `/${date.replaceAll('-', '/')}/`;

// Share checks across the saved-week seed and new publication. An updated cache
// entry makes freshly written cards reusable immediately within the same commit.
export function createCardCache(bucket: ContentBucket) {
  const cache = new Map<string, Promise<string | undefined>>();
  return {
    async matches(image: string, input: string): Promise<boolean> {
      let pending = cache.get(image);
      if (!pending) {
        pending = boundary('storage', async () => (await bucket.head(image.slice(1)))?.customMetadata?.cardInputHash);
        cache.set(image, pending);
      }
      return await pending === input;
    },
    saved(image: string, input: string) { cache.set(image, Promise.resolve(input)); },
  };
}

async function readJson(bucket: ContentBucket, key: string): Promise<unknown> {
  const object = await boundary('storage', () => bucket.get(key));
  if (!object) throw archiveUnavailable();
  const body = await boundary('storage', () => object.text());
  try { return JSON.parse(body); }
  catch { throw archiveUnavailable(); }
}

function validReference(ref: unknown): ref is ArchiveReference {
  return record(ref) && typeof ref.key === 'string' && /^archive-days\/[a-f0-9]{64}\.json$/.test(ref.key)
    && typeof ref.image === 'string' && /^\/assets\/daily\/[a-f0-9]{64}\.png$/.test(ref.image) && Array.isArray(ref.identities)
    && ref.identities.every(id => typeof id === 'string') && (ref.modified === undefined || isTimestamp(ref.modified));
}

export async function loadCatalog(bucket: ContentBucket, key?: string): Promise<ArchiveCatalog> {
  if (key === undefined) return { version: 1, days: {} };
  if (!validArchiveKey(key)) throw archiveUnavailable();
  const value = await readJson(bucket, key) as ArchiveCatalog;
  if (!value || value.version !== 1 || !value.days || typeof value.days !== 'object' || Array.isArray(value.days)
    || !Object.entries(value.days).every(([date, ref]) => isDate(date) && validReference(ref))) throw archiveUnavailable();
  return value;
}

export async function loadArchiveDay(bucket: ContentBucket, date: string, ref: ArchiveReference): Promise<ArchiveDay> {
  const value = await readJson(bucket, ref.key) as ArchiveDay;
  try {
    if (!value || value.date !== date || !Array.isArray(value.stories) || !value.images || typeof value.images !== 'object' || Array.isArray(value.images) || !Object.values(value.images).every(validImageMetadata)) throw new Error();
    validateStoredDigest({ title: 'News archive', source: 'archive', items: value.stories.map(story => story.item) });
    if (!value.stories.every(story => story.date === date && typeof story.postId === 'string' && Number.isSafeInteger(story.itemIndex)
      && story.itemIndex >= 0 && isTimestamp(story.activity) && localDate(new Date(story.activity)) === date && story.timestamp === Date.parse(story.activity))) throw new Error();
  } catch { throw archiveUnavailable(); }
  return value;
}

function archivePlan(posts: StoredPost[], publication: Publication, catalog: ArchiveCatalog, allCards = false) {
  const active = new Map<string, import('./types').StoredItem>(posts.flatMap(post => post.items.map((item, itemIndex) => [`${post.id}:${itemIndex}`, item] as const)));
  const knownPosts = new Set(posts.map(post => post.id));
  const visible = selectFeedItems(posts, publication);
  const dates = snapshotDates(publication);
  const additions = new Map<string, ArchiveStory[]>();
  for (const entry of visible) {
    const activities = [entry.item.posted_at, ...(entry.item.updates ?? []).map(update => update.posted_at)];
    for (const date of new Set(activities.map(time => localDate(new Date(time))).filter(date => dates.includes(date)))) {
      const activity = latestActivity(entry.item, [date])!;
      if (!additions.has(date)) additions.set(date, []);
      additions.get(date)!.push({ ...entry, date, activity, timestamp: Date.parse(activity) });
    }
  }
  const affected = new Set([...additions.keys(), ...Object.entries(catalog.days)
    .filter(([, ref]) => ref.identities.some(id => active.has(id) || knownPosts.has(id.slice(0, id.lastIndexOf(':')))))
    .map(([date]) => date)]);
  const checked = allCards ? new Set([...affected, ...Object.keys(catalog.days)]) : affected;
  return { active, knownPosts, additions, affected, dates: [...checked].sort(),
    input(date: string) {
      const ref = catalog.days[date];
      const sources = (ref?.identities ?? []).flatMap(id => {
        const known = knownPosts.has(id.slice(0, id.lastIndexOf(':')));
        return known ? [[id, active.get(id) ?? null]] : [];
      });
      return fingerprint(stableJson([date, ref ?? null, sources, additions.get(date) ?? [], DAILY_CARD_VERSION]));
    },
  };
}

async function prepareDay(bucket: ContentBucket, date: string, ref: ArchiveReference | undefined, plan: ReturnType<typeof archivePlan>,
  publication: Publication, trace: OperationTrace, resolve: ImageResolver, cards: ReturnType<typeof createCardCache>): Promise<ArchiveReference | undefined> {
  const old = ref ? await loadArchiveDay(bucket, date, ref) : undefined;
  const stories = new Map((old?.stories ?? []).flatMap(story => {
    const item = plan.active.get(identity(story));
    // A deliberate operator correction of a currently selected batch also updates archived copies.
    if (!item && plan.knownPosts.has(story.postId)) return [];
    return [[identity(story), item ? { ...story, item } : story] as const];
  }));
  for (const entry of plan.additions.get(date) ?? []) stories.set(identity(entry), entry);
  const ordered = [...stories.values()].sort((a, b) => b.timestamp - a.timestamp);
  if (!ordered.length) return;
  const images = plan.affected.has(date) ? await trace.run('archive_images', () => resolve(ordered.map(story => story.item))) : {};
  const day: ArchiveDay = { date, stories: ordered, images: { ...old?.images, ...images } };
  const body = stableJson(day);
  const key = `archive-days/${fingerprint(body)}.json`;
  const headline = ordered[0].item.headline;
  const cardInputHash = fingerprint(stableJson([date, headline, DAILY_CARD_VERSION]));
  const reusable = ref?.cardVersion === DAILY_CARD_VERSION
    && await trace.run('archive_card_loading', () => cards.matches(ref.image, cardInputHash));
  if (key === ref?.key && reusable) return ref;
  // Compare semantic content only if bytes changed; card repairs never advance lastmod.
  const contentChanged = key !== ref?.key && (!old || body !== stableJson(old));
  let image = ref?.image;
  if (!reusable) {
    const png = await trace.run('archive_card_rendering', () => boundary('rendering', () => dailyCard(date, headline)));
    image = `/assets/daily/${await hashBytes(png)}.png`;
    await trace.run('archive_image_write', () => boundary('storage', () => bucket.put(image!.slice(1), png,
      { httpMetadata: { contentType: 'image/png', cacheControl: IMAGE_CACHE }, customMetadata: { cardInputHash } })));
    cards.saved(image, cardInputHash);
  }
  if (key !== ref?.key) await trace.run('archive_day_write', () => boundary('storage', () => bucket.put(key, body, { httpMetadata: { contentType: 'application/json' } })));
  const modified = contentChanged ? publication.published_at : ref?.modified;
  return { key, image: image!, ...(modified ? { modified } : {}), cardVersion: DAILY_CARD_VERSION, identities: ordered.map(identity) };
}

async function saveCatalog(bucket: ContentBucket, catalog: ArchiveCatalog, previous: string | undefined, trace: OperationTrace, phase?: 'commit'): Promise<string> {
  const body = stableJson(catalog);
  const key = `archive-catalogs/${fingerprint(body)}.json`;
  if (key !== previous) await trace.run('archive_catalog_write', () => boundary('storage', () => bucket.put(key, body, { httpMetadata: { contentType: 'application/json' } })), phase ? { phase } : {});
  return key;
}

// A catalogue is only public once its reference is committed by the homepage index.
export async function prepareArchives(bucket: ContentBucket, posts: StoredPost[], publication: Publication, origin: string,
  previous: string | undefined, trace: OperationTrace, resolve: ImageResolver = createImageResolver(bucket, origin),
  options: { cards?: ReturnType<typeof createCardCache>; allCards?: boolean } = {}): Promise<string> {
  const catalog = await trace.run('archive_loading', () => loadCatalog(bucket, previous));
  const plan = archivePlan(posts, publication, catalog, options.allCards);
  const cards = options.cards ?? createCardCache(bucket);
  for (const date of plan.dates) {
    const ref = await prepareDay(bucket, date, catalog.days[date], plan, publication, trace, resolve, cards);
    if (ref) catalog.days[date] = ref;
    else delete catalog.days[date];
  }
  return saveCatalog(bucket, catalog, previous, trace);
}

export const REBUILD_ARCHIVE_BATCH = 10;
export type PendingArchiveRebuild = { kind: 'pending'; checkpoint: string; progress: ArchiveProgress };
type ArchiveRebuildResult = PendingArchiveRebuild
  | { kind: 'prepared'; archives: string; progress: ArchiveProgress };
interface DayResult { input: string; reference: ArchiveReference | null }
interface ArchiveWork { version: 1; days: Record<string, DayResult> }
const validResult = (value: unknown): value is DayResult => record(value) && typeof value.input === 'string'
  && /^[a-f0-9]{64}$/.test(value.input) && (value.reference === null || validReference(value.reference));

async function cachedJson(bucket: ContentBucket, key: string): Promise<unknown> {
  const object = await boundary('storage', () => bucket.get(key));
  if (!object) return;
  const body = await boundary('storage', () => object.text());
  try { return JSON.parse(body); } catch { return; } // Private work caches can be recomputed.
}

// Checkpoints contain references only, never image bytes. A per-day receipt also
// survives failure between artifact persistence and the Durable Object checkpoint.
export async function rebuildArchives(bucket: ContentBucket, posts: StoredPost[], publication: Publication, origin: string,
  trace: OperationTrace, jobId: string, checkpoint?: string, imageCache: ImageResolutionCache = createImageResolutionCache()): Promise<ArchiveRebuildResult> {
  const saved = checkpoint && checkpoint.startsWith(`rebuild-work/${jobId}/checkpoints/`)
    ? await trace.run('rebuild_archive_loading', () => cachedJson(bucket, checkpoint)) : undefined;
  const work: ArchiveWork = record(saved) && saved.version === 1 && record(saved.days)
    && Object.entries(saved.days).every(([date, result]) => isDate(date) && validResult(result)) ? saved as unknown as ArchiveWork : { version: 1, days: {} };
  const base = await trace.run('archive_loading', () => loadCatalog(bucket, publication.archives));
  const catalog: ArchiveCatalog = { version: 1, days: { ...base.days } };
  const plan = archivePlan(posts, publication, base, true);
  const next: ArchiveWork = { version: 1, days: {} };
  let processed = 0;
  for (const date of plan.dates) {
    const input = plan.input(date);
    let result = work.days[date];
    if (result?.input !== input) {
      if (processed === REBUILD_ARCHIVE_BATCH) continue;
      processed++;
      const receipt = `rebuild-work/${jobId}/days/${date}/${input}.json`;
      const cached = await trace.run('rebuild_day_loading', () => cachedJson(bucket, receipt));
      if (record(cached) && cached.version === 1 && validResult(cached.result) && cached.result.input === input) result = cached.result;
      else {
        const prepared = prepareWrites(bucket, trace);
        try {
          const reference = await prepareDay(prepared.bucket, date, base.days[date], plan, publication, trace,
            createImageResolver(prepared.bucket, origin, imageCache), createCardCache(prepared.bucket));
          await prepared.commit(null);
          result = { input, reference: reference ?? null };
        } finally { prepared.close(); }
        await trace.run('rebuild_day_checkpoint', () => boundary('storage', () => bucket.put(receipt, stableJson({ version: 1, result }), { httpMetadata: { contentType: 'application/json' } })), { phase: 'commit' });
      }
    }
    next.days[date] = result;
    if (result.reference) catalog.days[date] = result.reference;
    else delete catalog.days[date];
  }
  const progress = { completed_days: Object.keys(next.days).length, total_days: plan.dates.length };
  if (progress.completed_days === progress.total_days) {
    return { kind: 'prepared', progress, archives: await saveCatalog(bucket, catalog, publication.archives, trace, 'commit') };
  }
  const body = stableJson(next);
  const key = `rebuild-work/${jobId}/checkpoints/${fingerprint(body)}.json`;
  if (key !== checkpoint) await trace.run('rebuild_archive_checkpoint', () => boundary('storage', () => bucket.put(key, body, { httpMetadata: { contentType: 'application/json' } })), { phase: 'commit' });
  return { kind: 'pending', checkpoint: key, progress };
}
