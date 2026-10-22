import { matchesEtag, parseIfNoneMatch } from './conditions';
import { emit, type OperationTrace } from './diagnostics';
import { boundary } from './errors';
import { dimensions, metadataKey, validImageMetadata, type ImageMetadata } from './image-metadata';
import { IMAGE_CACHE } from './images';
import { noStoreHeaders } from './responses';
import { THUMBNAIL_PATH, thumbnailWidth } from './thumbnail-sizes';
import type { Env } from './types';
import { HttpError } from './validation';

// Only explicit WebP support opts into transcoding. Wildcards retain the source
// encoding, and an explicit q=0 always wins over a less-specific wildcard.
export function acceptsWebp(value: string | null, sourceType?: string): boolean {
  const qualities = new Map<string, number>();
  for (const part of (value ?? '').split(',')) {
    const [media, ...parameters] = part.trim().toLowerCase().split(';');
    const type = media.trim();
    const q = parameters.map(parameter => parameter.trim()).find(parameter => parameter.startsWith('q='));
    const match = q === undefined ? undefined : /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.exec(q);
    const next = q === undefined ? 1 : match ? Number(match[1]) : 0;
    qualities.set(type, Math.min(qualities.get(type) ?? 1, next));
  }
  const webp = qualities.get('image/webp') ?? 0;
  const source = sourceType ? qualities.get(sourceType) ?? qualities.get('image/*') ?? qualities.get('*/*') ?? 0 : 0;
  return webp > 0 && webp >= source;
}

export async function thumbnailResponse(request: Request, env: Env, trace: OperationTrace): Promise<Response> {
  const url = new URL(request.url);
  const match = THUMBNAIL_PATH.exec(url.pathname);
  if (!match || url.search) throw new HttpError(404, 'Not found');
  const [, hash, extension, preset] = match;
  const edge = Number(preset);
  const key = `images/${hash}.${extension}`;
  // Missing originals stay 404 even when Images is unavailable.
  const original = await boundary('storage', () => env.SITE_BUCKET.get(key));
  if (!original) throw new HttpError(404, 'Not found');
  const fallback = async (reason: string, code?: number): Promise<Response> => {
    try { if (!original.bodyUsed) await original.body.cancel(); } catch { /* A failed encoder may still hold the stream lock. */ }
    emit('thumbnail_fallback', trace.context, { reason, edge, ...(code !== undefined ? { images_code: code } : {}) }, 'warn');
    return new Response(null, { status: 302, headers: noStoreHeaders('text/plain; charset=utf-8', { Location: `/${key}`, Vary: 'Accept' }) });
  };
  if (!env.IMAGES || typeof env.IMAGES.input !== 'function') return fallback('binding_unavailable');

  try {
    const saved = await boundary('storage', () => env.SITE_BUCKET.get(metadataKey(hash)));
    let size: ImageMetadata | undefined;
    if (saved) {
      try { size = JSON.parse(await saved.text()); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    let input: ReadableStream<Uint8Array> = original.body;
    if (!size || !validImageMetadata(size)) {
      // Legacy metadata discovery is read-only and bounded by the upload limit.
      const bytes = new Uint8Array(await original.arrayBuffer());
      size = dimensions(bytes);
      input = new Blob([bytes]).stream();
    }
    const format = acceptsWebp(request.headers.get('Accept'), size.type) ? 'image/webp' : size.type as ImageOutputOptions['format'];
    const headers = new Headers({ 'Cache-Control': IMAGE_CACHE, 'Cloudflare-CDN-Cache-Control': IMAGE_CACHE,
      Vary: 'Accept', 'X-Content-Type-Options': 'nosniff', 'Content-Type': format,
      ETag: `W/"thumbnail-v1-${hash}-${edge}-${format.slice(6)}-q80"` });
    if (matchesEtag(parseIfNoneMatch(request.headers.get('If-None-Match')), headers.get('ETag')!)) {
      await input.cancel();
      return new Response(null, { status: 304, headers });
    }
    const output = await trace.run('thumbnail_transform', () => env.IMAGES!.input(input)
      .transform({ width: thumbnailWidth(size!, edge), fit: 'scale-down' })
      .output({ format, ...(format !== 'image/gif' ? { quality: 80 } : {}),
        ...(['image/webp', 'image/gif'].includes(format) ? { anim: true } : {}) }));
    const response = output.response({ headers });
    // HEAD uses the same transform/failure path as GET, but never returns bytes.
    if (request.method === 'HEAD') {
      await response.body?.cancel();
      return new Response(null, response);
    }
    return response;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined;
    return fallback(code === 9422 ? 'quota_exhausted' : 'transformation_failed', code);
  }
}
