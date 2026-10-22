import { matchesEtag, parseIfNoneMatch } from './conditions';
import { emit, safeError, type OperationTrace } from './diagnostics';
import { boundary, OperationFailure } from './errors';
import { dimensions, readImageMetadata, type ImageMetadata } from './image-metadata';
import { IMAGE_CACHE, IMAGE_LIMIT } from './images';
import { noStoreHeaders } from './responses';
import { THUMBNAIL_PATH, THUMBNAIL_V2_PATH, thumbnailWidth } from './thumbnail-sizes';
import type { Env } from './types';
import { HttpError, readLimited } from './validation';

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

const recipe = 'scale-down-q80-anim-1';
function derivative(source: string, edge: number, type: string) {
  const extension = type === 'image/jpeg' ? 'jpg' : type.slice(6);
  const metadata = { recipe, source, edge: String(edge), format: type };
  return { key: `thumbnail-cache/v1/${recipe}/${source.slice('images/'.length)}/${edge}.${extension}`, metadata,
    valid: (object: R2Object | null): object is R2Object => !!object && Number.isSafeInteger(object.size) && object.size > 0
      && object.httpMetadata?.contentType === type && Object.entries(metadata).every(([key, value]) => object.customMetadata?.[key] === value) };
}

async function discard(object: R2Object | null) {
  if (object && 'body' in object) {
    const body = object as R2ObjectBody;
    if (!body.bodyUsed) await body.body.cancel().catch(() => {});
  }
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
  const original = await boundary('storage', () => env.SITE_BUCKET.head(key));
  if (!original) throw new HttpError(404, 'Not found');
  let body: R2ObjectBody | null = null;
  const fallback = async (reason: string, error?: unknown): Promise<Response> => {
    try { if (body && !body.bodyUsed) await body.body.cancel(); } catch { /* Preserve fallback after encoder failure. */ }
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined;
    emit('thumbnail_fallback', trace.context, { reason, edge, ...(code !== undefined ? { images_code: code } : {}), ...(error ? safeError(error) : {}) }, 'warn');
    return new Response(null, { status: 302, headers: noStoreHeaders('text/plain; charset=utf-8', { Location: `/${key}`, ...(!v2 ? { Vary: 'Accept' } : {}) }) });
  };
  let phase: 'metadata' | 'source' | 'encoder' | 'cache_read' | 'cache_write' = 'metadata';
  try {
    let size = v2 ? undefined : await readImageMetadata(env.SITE_BUCKET, hash);
    const sourceType = () => size?.type ?? (extension === 'jpg' ? 'image/jpeg' : `image/${extension}`);
    const format = () => v2 ? outputExtension === 'jpg' ? 'image/jpeg' : `image/${outputExtension}` : acceptsWebp(request.headers.get('Accept'), sourceType()) ? 'image/webp' : sourceType();
    const headersFor = () => new Headers({ 'Cache-Control': IMAGE_CACHE, 'Cloudflare-CDN-Cache-Control': IMAGE_CACHE,
      ...(!v2 ? { Vary: 'Accept' } : {}), 'X-Content-Type-Options': 'nosniff', 'Content-Type': format(),
      ETag: `W/"thumbnail-${v2 ? 'v2' : 'v1'}-${hash}-${edge}-${format().slice(6)}-q80"` });
    const cachedResponse = async (cached: R2Object | null, variant: ReturnType<typeof derivative>): Promise<Response | null> => {
      if (!variant.valid(cached)) { await discard(cached); return null; }
      const headers = headersFor(); headers.set('Content-Length', String(cached.size));
      if (matchesEtag(condition, headers.get('ETag')!) || request.method === 'HEAD') {
        await discard(cached);
        return new Response(null, { status: matchesEtag(condition, headers.get('ETag')!) ? 304 : 200, headers });
      }
      const full = 'body' in cached ? cached as R2ObjectBody : await boundary('storage', () => env.SITE_BUCKET.get(variant.key));
      if (!variant.valid(full)) { await discard(full); return null; }
      headers.set('Content-Length', String(full.size));
      return new Response(full!.body, { headers });
    };
    phase = 'cache_read';
    let variant = derivative(key, edge, format());
    const readKey = variant.key;
    const cached = await boundary('storage', () => request.method === 'HEAD' || condition ? env.SITE_BUCKET.head(variant.key) : env.SITE_BUCKET.get(variant.key));
    const hit = await cachedResponse(cached, variant);
    if (hit) { emit('thumbnail_cache_hit', trace.context, { edge, format: format() }); return hit; }
    if (cached) emit('thumbnail_cache_invalid', trace.context, { edge, format: format() }, 'warn');
    if (request.method === 'HEAD') return fallback('derivative_missing');
    if (!env.IMAGES || typeof env.IMAGES.input !== 'function') return fallback('binding_unavailable');
    phase = 'metadata';
    size ??= await readImageMetadata(env.SITE_BUCKET, hash);
    phase = 'source';
    body = await boundary('storage', () => env.SITE_BUCKET.get(key));
    if (!body) throw new HttpError(404, 'Not found');
    let input: ReadableStream<Uint8Array> = body.body;
    if (!size) {
      const bytes = new Uint8Array(await boundary('storage', () => body!.arrayBuffer()));
      try { size = dimensions(bytes); } catch (error) { return fallback('malformed_image', error); }
      input = new Blob([bytes]).stream();
    }
    phase = 'encoder';
    const type = format() as ImageOutputOptions['format'];
    const output = await trace.run('thumbnail_transform', () => env.IMAGES!.input(input)
      .transform({ width: thumbnailWidth(size!, edge), fit: 'scale-down' })
      .output({ format: type, ...(type !== 'image/gif' ? { quality: 80 } : {}), ...(['image/webp', 'image/gif'].includes(type) ? { anim: true } : {}) }));
    const rendered = output.response();
    if (rendered.status !== 200 || !rendered.body || rendered.headers.get('Content-Type') !== type) {
      await rendered.body?.cancel(); return fallback('unexpected_error');
    }
    phase = 'cache_write';
    variant = derivative(key, edge, type);
    // Conditional writes settle through full output consumption before success
    // is advertised. No request-owned streams/promises are shared with callers.
    const prior = variant.key === readKey ? cached : null;
    let saved: R2Object | null;
    try {
      // The Images binding returns a stream without a known R2 upload length.
      // Bound buffering by the existing image budget; oversized derivatives
      // retain the original-image fallback rather than exhausting the isolate.
      const bytes = await readLimited(new Request(url, { method: 'POST', body: rendered.body,
        ...(rendered.headers.has('Content-Length') ? { headers: { 'Content-Length': rendered.headers.get('Content-Length')! } } : {}) }), IMAGE_LIMIT);
      saved = await trace.run('thumbnail_cache_write', () => boundary('storage', () => env.SITE_BUCKET.put(variant.key, bytes, {
        onlyIf: prior ? { etagMatches: prior.etag } : { etagDoesNotMatch: '*' },
        customMetadata: variant.metadata, httpMetadata: { contentType: type, cacheControl: IMAGE_CACHE },
      })));
    } finally { if (!rendered.bodyUsed) await rendered.body.cancel().catch(() => {}); }
    emit('thumbnail_cache_fill', trace.context, { edge, format: type, bytes_written: saved?.size ?? 0, outcome: saved ? 'stored' : 'race' });
    phase = 'cache_read';
    const winner = await boundary('storage', () => condition ? env.SITE_BUCKET.head(variant.key) : env.SITE_BUCKET.get(variant.key));
    const result = await cachedResponse(winner, variant);
    return result ?? fallback('cache_read_failed');
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    return fallback(phase === 'cache_write' ? 'cache_write_failed' : error instanceof OperationFailure && error.kind === 'storage' ? 'storage_error' : code === 9422 ? 'quota_exhausted' : phase === 'encoder' && !(error instanceof TypeError) ? 'transformation_failed' : 'unexpected_error', error);
  }
}
