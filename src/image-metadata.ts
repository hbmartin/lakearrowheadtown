import MarkdownIt from 'markdown-it';
import { imageSize } from 'image-size';
import { boundary } from './errors';
import type { ContentBucket, StoredItem } from './types';

export interface ImageMetadata { width: number; height: number; type: string }
export type ImageMetadataMap = Record<string, ImageMetadata>;
const markdown = new MarkdownIt({ html: false });

export function dimensions(bytes: Uint8Array): ImageMetadata {
  const chunk = new TextDecoder().decode(bytes.subarray(12, 16));
  if (chunk.startsWith('VP8') && bytes.length < (chunk === 'VP8L' ? 25 : 30)) throw new Error('Truncated WebP header');
  const result = imageSize(bytes);
  let { width, height } = result;
  if (result.orientation && result.orientation >= 5) [width, height] = [height, width];
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new Error('Invalid image dimensions');
  return { width, height, type: `image/${result.type === 'jpg' ? 'jpeg' : result.type}` };
}

export function bodyImages(body: string, origin: string): string[] {
  return markdown.parse(body, {}).flatMap(token => (token.children ?? []).flatMap(child => {
    if (child.type !== 'image') return [];
    try {
      const url = new URL(String(child.attrGet('src') ?? ''), `${origin}/`);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? [url.href] : [];
    } catch { return []; }
  }));
}

export const metadataKey = (hash: string) => `image-metadata/${hash}.json`;
export const validImageMetadata = (value: ImageMetadata): boolean => !!value && Number.isSafeInteger(value.width) && value.width > 0
  && Number.isSafeInteger(value.height) && value.height > 0 && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(value.type);

export type ImageResolver = (items: StoredItem[]) => Promise<ImageMetadataMap>;

// Share values and admission across staging views, never the views themselves.
// The owner discards this state after one publication or rebuild alarm.
export function createImageResolutionCache() {
  const entries = new Map<string, Promise<ImageMetadata | undefined>>();
  let active = 0;
  const waiting: Array<() => void> = [];
  async function limited<T>(action: () => Promise<T>): Promise<T> {
    if (active < 2) active++;
    else await new Promise<void>(resolve => waiting.push(resolve));
    try { return await action(); }
    finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }
  return { entries, limited };
}
export type ImageResolutionCache = ReturnType<typeof createImageResolutionCache>;

// One cache belongs to one publication, including its archive seed and homepage.
export function createImageResolver(bucket: ContentBucket, origin: string, cache = createImageResolutionCache()): ImageResolver {
  async function read(path: string, hash: string): Promise<ImageMetadata | undefined> {
    const key = metadataKey(hash);
    const saved = await boundary('storage', () => bucket.get(key));
    if (saved) {
      let value: ImageMetadata | undefined;
      try { value = JSON.parse(await boundary('storage', () => saved.text())); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      if (value && validImageMetadata(value)) return value;
    }
    const object = await boundary('storage', () => bucket.get(path));
    if (!object) return;
    const bytes = new Uint8Array(await boundary('storage', () => object.arrayBuffer()));
    let value: ImageMetadata;
    try { value = dimensions(bytes); }
    catch { return; } // Malformed legacy uploads keep their existing rendering.
    await boundary('storage', () => bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } }));
    return value;
  }
  return async items => {
    const urls = new Set(items.flatMap(item => [item.body, ...(item.updates ?? []).map(update => update.body)].flatMap(body => bodyImages(body, origin))));
    const result: ImageMetadataMap = {};
    const resolved = await Promise.allSettled([...urls].map(async url => {
      const parsed = new URL(url);
      const match = /^\/images\/([a-f0-9]{64})\.(jpg|png|gif|webp)$/.exec(parsed.pathname);
      if (parsed.origin !== origin || !match) return;
      const path = parsed.pathname.slice(1);
      let pending = cache.entries.get(path);
      if (!pending) {
        pending = cache.limited(() => read(path, match[1]));
        cache.entries.set(path, pending);
      }
      const value = await pending;
      if (value) result[url] = value;
    }));
    for (const value of resolved) if (value.status === 'rejected') throw value.reason;
    return result;
  };
}
