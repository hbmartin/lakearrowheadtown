import { boundary } from './errors';
import { archiveUnavailable, validArchiveKey } from './committed';
export { archiveUnavailable } from './committed';
import { latestActivity, localDate, selectFeedItems, snapshotDates } from './feed';
import { hashBytes, IMAGE_CACHE } from './images';
import { createImageResolver, validImageMetadata, type ImageMetadataMap, type ImageResolver } from './image-metadata';
import { dailyCard, DAILY_CARD_VERSION } from './social';
import { isDate, isTimestamp, validateStoredDigest } from './validation';
import type { ContentBucket, Publication, StoredPost } from './types';
import type { OperationTrace } from './diagnostics';

export type ArchiveStory = ReturnType<typeof selectFeedItems>[number];
export interface ArchiveDay { date: string; stories: ArchiveStory[]; images: ImageMetadataMap }
export interface ArchiveReference { key: string; image: string; modified?: string; cardVersion?: number; identities: string[] }
export interface ArchiveCatalog { version: 1; days: Record<string, ArchiveReference> }
export const stableJson = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const identity = (story: Pick<ArchiveStory, 'postId' | 'itemIndex'>) => `${story.postId}:${story.itemIndex}`;
export const archivePath = (date: string) => `/${date.replaceAll('-', '/')}/`;
const fallbackHeadline = 'Lake Arrowhead community news';

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

export async function loadCatalog(bucket: ContentBucket, key?: string): Promise<ArchiveCatalog> {
  if (key === undefined) return { version: 1, days: {} };
  if (!validArchiveKey(key)) throw archiveUnavailable();
  const value = await readJson(bucket, key) as ArchiveCatalog;
  if (!value || value.version !== 1 || !value.days || typeof value.days !== 'object' || Array.isArray(value.days)
    || !Object.entries(value.days).every(([date, ref]) => isDate(date) && ref && /^archive-days\/[a-f0-9]{64}\.json$/.test(ref.key)
      && /^\/assets\/daily\/[a-f0-9]{64}\.png$/.test(ref.image) && Array.isArray(ref.identities)
      && ref.identities.every(id => typeof id === 'string') && (ref.modified === undefined || isTimestamp(ref.modified)))) throw archiveUnavailable();
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

// A catalogue is only public once its reference is committed by the homepage index.
// Daily records contain independent content, never mutable source references.
export async function prepareArchives(bucket: ContentBucket, posts: StoredPost[], publication: Publication, origin: string,
  previous: string | undefined, trace: OperationTrace, resolve: ImageResolver = createImageResolver(bucket, origin),
  options: { cards?: ReturnType<typeof createCardCache>; allCards?: boolean } = {}): Promise<string> {
  const catalog = await trace.run('archive_loading', () => loadCatalog(bucket, previous));
  const cards = options.cards ?? createCardCache(bucket);
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
  const checked = options.allCards ? new Set([...affected, ...Object.keys(catalog.days)]) : affected;
  for (const date of [...checked].sort()) {
    const ref = catalog.days[date];
    const old = ref ? await loadArchiveDay(bucket, date, ref) : undefined;
    const stories = new Map((old?.stories ?? []).flatMap(story => {
      const item = active.get(identity(story));
      // A deliberate operator correction of a currently selected batch also updates archived copies.
      if (!item && knownPosts.has(story.postId)) return [];
      return [[identity(story), item ? { ...story, item } : story] as const];
    }));
    for (const entry of additions.get(date) ?? []) stories.set(identity(entry), entry);
    const ordered = [...stories.values()].sort((a, b) => b.timestamp - a.timestamp);
    const images = affected.has(date) ? await trace.run('archive_images', () => resolve(ordered.map(story => story.item))) : {};
    const day: ArchiveDay = { date, stories: ordered, images: { ...old?.images, ...images } };
    const body = stableJson(day);
    const key = `archive-days/${await hashBytes(new TextEncoder().encode(body))}.json`;
    const headline = ordered[0]?.item.headline ?? fallbackHeadline;
    const cardInputHash = await hashBytes(new TextEncoder().encode(stableJson([date, headline, DAILY_CARD_VERSION])));
    const reusable = ref?.cardVersion === DAILY_CARD_VERSION
      && await trace.run('archive_card_loading', () => cards.matches(ref.image, cardInputHash));
    if (key === ref?.key && reusable) continue;
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
    catalog.days[date] = { key, image: image!, ...(modified ? { modified } : {}), cardVersion: DAILY_CARD_VERSION, identities: ordered.map(identity) };
  }
  const body = stableJson(catalog);
  const key = `archive-catalogs/${await hashBytes(new TextEncoder().encode(body))}.json`;
  if (key !== previous) await trace.run('archive_catalog_write', () => boundary('storage', () => bucket.put(key, body, { httpMetadata: { contentType: 'application/json' } })));
  return key;
}
