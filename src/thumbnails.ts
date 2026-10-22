import { matchesEtag, parseIfNoneMatch } from './conditions';
import { emit, safeError, type OperationTrace } from './diagnostics';
import { boundary, OperationFailure } from './errors';
import { dimensions, readImageMetadata, type ImageMetadata } from './image-metadata';
import { IMAGE_CACHE } from './images';
import { noStoreHeaders } from './responses';
import { THUMBNAIL_PATH, THUMBNAIL_V2_PATH, thumbnailWidth } from './thumbnail-sizes';
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
  const v2 = THUMBNAIL_V2_PATH.exec(url.pathname);
  const match = v2 ?? THUMBNAIL_PATH.exec(url.pathname);
  if (!match || url.search) throw new HttpError(404, 'Not found');
  const [, hash, extension, preset, outputExtension] = match;
  if (v2 && outputExtension !== extension && outputExtension !== 'webp') throw new HttpError(404, 'Not found');
  const edge = Number(preset); const key = `images/${hash}.${extension}`;
  const condition = parseIfNoneMatch(request.headers.get('If-None-Match'));
  const original = await boundary('storage', () => request.method === 'HEAD' || condition ? env.SITE_BUCKET.head(key) : env.SITE_BUCKET.get(key));
  if (!original) throw new HttpError(404, 'Not found');
  let body = 'body' in original ? original as R2ObjectBody : null;
  const fallback = async (reason: string, error?: unknown): Promise<Response> => {
    try { if (body && !body.bodyUsed) await body.body.cancel(); } catch { /* Preserve fallback after encoder failure. */ }
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined;
    emit('thumbnail_fallback', trace.context, { reason, edge, ...(code !== undefined ? { images_code: code } : {}), ...(error ? safeError(error) : {}) }, 'warn');
    return new Response(null, { status: 302, headers: noStoreHeaders('text/plain; charset=utf-8', { Location: `/${key}`, ...(!v2 ? { Vary: 'Accept' } : {}) }) });
  };
  if (!env.IMAGES || typeof env.IMAGES.input !== 'function') return fallback('binding_unavailable');
  let phase: 'metadata' | 'source' | 'encoder' = 'metadata';
  try {
    let size = await readImageMetadata(env.SITE_BUCKET, hash);
    const sourceType = () => size?.type ?? (extension === 'jpg' ? 'image/jpeg' : `image/${extension}`);
    const format = () => v2 ? outputExtension === 'jpg' ? 'image/jpeg' : `image/${outputExtension}` : acceptsWebp(request.headers.get('Accept'), sourceType()) ? 'image/webp' : sourceType();
    const headersFor = () => new Headers({ 'Cache-Control': IMAGE_CACHE, 'Cloudflare-CDN-Cache-Control': IMAGE_CACHE,
      ...(!v2 ? { Vary: 'Accept' } : {}), 'X-Content-Type-Options': 'nosniff', 'Content-Type': format(),
      ETag: `W/"thumbnail-${v2 ? 'v2' : 'v1'}-${hash}-${edge}-${format().slice(6)}-q80"` });
    let headers = headersFor();
    if (matchesEtag(condition, headers.get('ETag')!)) { if (body) await body.body.cancel(); return new Response(null, { status: 304, headers }); }
    if (request.method === 'HEAD') return new Response(null, { headers });
    phase = 'source';
    body ??= await boundary('storage', () => env.SITE_BUCKET.get(key));
    if (!body) throw new HttpError(404, 'Not found');
    let input: ReadableStream<Uint8Array> = body.body;
    if (!size) {
      const bytes = new Uint8Array(await boundary('storage', () => body!.arrayBuffer()));
      try { size = dimensions(bytes); } catch (error) { return fallback('malformed_image', error); }
      input = new Blob([bytes]).stream(); headers = headersFor();
    }
    phase = 'encoder';
    const type = format() as ImageOutputOptions['format'];
    const output = await trace.run('thumbnail_transform', () => env.IMAGES!.input(input)
      .transform({ width: thumbnailWidth(size!, edge), fit: 'scale-down' })
      .output({ format: type, ...(type !== 'image/gif' ? { quality: 80 } : {}), ...(['image/webp', 'image/gif'].includes(type) ? { anim: true } : {}) }));
    return output.response({ headers });
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    return fallback(error instanceof OperationFailure && error.kind === 'storage' ? 'storage_error' : code === 9422 ? 'quota_exhausted' : phase === 'encoder' && !(error instanceof TypeError) ? 'transformation_failed' : 'unexpected_error', error);
  }
}
