import { matchesEtag, parseIfNoneMatch } from './conditions';
import { emit, safeError, type OperationTrace } from './diagnostics';
import { asHttpError, boundary, OperationFailure } from './errors';
import { dimensions, readImageMetadata, validImageMetadata, type ImageMetadata } from './image-metadata';
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
  const matches = (object: R2Object | null) => !!object && Object.entries(metadata).every(([key, value]) => object.customMetadata?.[key] === value);
  return { key: `thumbnail-cache/v1/${recipe}/${source.slice('images/'.length)}/${edge}.${extension}`, metadata,
    valid: (object: R2Object | null): object is R2Object => matches(object) && Number.isSafeInteger(object!.size) && object!.size > 0 && object!.httpMetadata?.contentType === type,
    oversized: (object: R2Object | null): boolean => matches(object) && object!.size === 0 && object!.customMetadata?.outcome === 'oversized-v1'
      && object!.customMetadata?.limit === String(IMAGE_LIMIT) && object!.httpMetadata?.contentType === 'application/octet-stream' };
}

// Every request owns its streams. Never let cleanup replace the original error.
async function discard(object: R2Object | Response | { body: ReadableStream | null; bodyUsed?: boolean } | null | undefined) {
  if (object && 'body' in object && object.body && !object.bodyUsed) await object.body.cancel().catch(() => {});
}

async function legacyMetadata(env: Env, hash: string, source: string) {
  const key = `thumbnail-cache/v1/source-metadata/${source.slice('images/'.length)}`;
  let size = await readImageMetadata(env.SITE_BUCKET, hash);
  let saved: R2Object | null = null;
  if (!size) {
    saved = await boundary('storage', () => env.SITE_BUCKET.head(key));
    const metadata = saved?.customMetadata;
    const detected = { width: Number(metadata?.width), height: Number(metadata?.height), type: metadata?.type ?? '' };
    if (saved?.size === 0 && metadata?.version === '1' && metadata.source === source && validImageMetadata(detected)) size = detected;
  }
  return { key, size, saved };
}

export async function thumbnailResponse(request: Request, env: Env, trace: OperationTrace, context?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  const url = new URL(request.url);
  const v2 = THUMBNAIL_V2_PATH.exec(url.pathname);
  const match = v2 ?? THUMBNAIL_PATH.exec(url.pathname);
  if (!match || url.search) throw new HttpError(404, 'Not found');
  const [, hash, extension, preset, outputExtension] = match;
  if (v2 && outputExtension !== extension && outputExtension !== 'webp') throw new HttpError(404, 'Not found');
  const edge = Number(preset); const key = `images/${hash}.${extension}`;
  const condition = parseIfNoneMatch(request.headers.get('If-None-Match'));
  let body: R2ObjectBody | null = null;
  let input: ReadableStream<Uint8Array> | undefined;
  let size: ImageMetadata | undefined;
  let resolvedFormat: string | undefined;
  let originalVerified = false; let malformed = false;
  const fallback = async (reason: string, error?: unknown): Promise<Response> => {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined;
    emit('thumbnail_fallback', trace.context, { reason, edge, ...(code !== undefined ? { images_code: code } : {}), ...(error ? safeError(error) : {}) }, 'warn');
    return new Response(null, { status: 302, headers: noStoreHeaders('text/plain; charset=utf-8', { Location: `/${key}`, ...(!v2 ? { Vary: 'Accept' } : {}) }) });
  };
  const format = () => {
    const sourceType = size?.type ?? (extension === 'jpg' ? 'image/jpeg' : `image/${extension}`);
    return resolvedFormat ?? (v2 ? outputExtension === 'jpg' ? 'image/jpeg' : `image/${outputExtension}` : acceptsWebp(request.headers.get('Accept'), sourceType) ? 'image/webp' : sourceType);
  };
  const headersFor = (length: number) => new Headers({ 'Cache-Control': IMAGE_CACHE, 'Cloudflare-CDN-Cache-Control': IMAGE_CACHE,
    ...(!v2 ? { Vary: 'Accept' } : {}), 'X-Content-Type-Options': 'nosniff', 'Content-Type': format(), 'Content-Length': String(length),
    ETag: `W/"thumbnail-${v2 ? 'v2' : 'v1'}-${hash}-${edge}-${format().slice(6)}-q80"` });
  const response = (length: number, bytes: BodyInit | null) => {
    const headers = headersFor(length); const unchanged = matchesEtag(condition, headers.get('ETag')!);
    return new Response(unchanged || request.method === 'HEAD' ? null : bytes, { status: unchanged ? 304 : 200, headers });
  };
  const readCache = (variant: ReturnType<typeof derivative>) => boundary('storage', () => request.method === 'HEAD' || condition ? env.SITE_BUCKET.head(variant.key) : env.SITE_BUCKET.get(variant.key));
  const cachedResponse = async (cached: R2Object | null, variant: ReturnType<typeof derivative>, initial = true): Promise<Response | null> => {
    if (variant.oversized(cached)) {
      await discard(cached); if (initial) emit('thumbnail_cache_outcome_hit', trace.context, { edge, format: format(), outcome: 'oversized' });
      return fallback('derivative_oversized');
    }
    if (!variant.valid(cached)) { await discard(cached); return null; }
    if (matchesEtag(condition, headersFor(cached.size).get('ETag')!) || request.method === 'HEAD') {
      await discard(cached); if (initial) emit('thumbnail_cache_hit', trace.context, { edge, format: format() }); return response(cached.size, null);
    }
    const full = 'body' in cached ? cached as R2ObjectBody : await boundary('storage', () => env.SITE_BUCKET.get(variant.key));
    if (!variant.valid(full)) { await discard(full); return null; }
    if (initial) emit('thumbnail_cache_hit', trace.context, { edge, format: format() });
    return response(full!.size, full!.body);
  };
  const loadInput = async () => {
    body = await boundary('storage', () => env.SITE_BUCKET.get(key));
    if (!body) throw new HttpError(404, 'Not found');
    input = body.body;
    if (!size) {
      const bytes = new Uint8Array(await boundary('storage', () => body!.arrayBuffer()));
      try { size = dimensions(bytes); } catch (error) { malformed = true; throw error; }
      input = new Blob([bytes]).stream();
    }
  };
  let phase: 'metadata' | 'source' | 'encoder' | 'cache_read' | 'cache_write' = 'metadata';
  try {
    // Settle both reads even on failure so an unused R2 body cannot escape.
    const [original, initial] = await Promise.allSettled([
      boundary('storage', () => env.SITE_BUCKET.head(key)),
      v2 ? readCache(derivative(key, edge, format())).then(cached => ({ cached, legacy: undefined }))
        : legacyMetadata(env, hash, key).then(legacy => ({ cached: undefined, legacy })),
    ]);
    if (original.status === 'rejected' || !original.value) {
      if (initial.status === 'fulfilled') await discard(initial.value.cached);
      throw original.status === 'rejected' ? original.reason : new HttpError(404, 'Not found');
    }
    originalVerified = true;
    if (initial.status === 'rejected') throw initial.reason;
    size = initial.value.legacy?.size;
    let cached = initial.value.cached;
    let detected = false;
    if (!v2 && !size) {
      const formats = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'].map(type =>
        acceptsWebp(request.headers.get('Accept'), type) ? 'image/webp' : type));
      if (formats.size === 1) {
        resolvedFormat = formats.values().next().value;
        phase = 'cache_read';
        const variant = derivative(key, edge, format()); cached = await readCache(variant);
        const hit = await cachedResponse(cached, variant); if (hit) return hit;
      }
      if (request.method === 'HEAD') return fallback('derivative_missing');
      if (!env.IMAGES || typeof env.IMAGES.input !== 'function') return fallback('binding_unavailable');
      phase = 'source'; await loadInput();
      detected = true;
    }
    phase = 'cache_read';
    const variant = derivative(key, edge, format());
    if (cached === undefined) cached = await readCache(variant);
    const hit = await cachedResponse(cached, variant);
    if (detected) {
      const legacy = initial.value.legacy!;
      const persist = boundary('storage', () => env.SITE_BUCKET.put(legacy.key, '', { onlyIf: legacy.saved ? { etagMatches: legacy.saved.etag } : { etagDoesNotMatch: '*' },
        customMetadata: { version: '1', source: key, width: String(size!.width), height: String(size!.height), type: size!.type } }))
        .catch(error => { emit('thumbnail_source_metadata_write_failed', trace.context, { edge, error_code: asHttpError(error).code, ...safeError(error) }, 'warn'); });
      if (context) context.waitUntil(persist); else await persist;
    }
    if (hit) return hit;
    if (cached) emit('thumbnail_cache_invalid', trace.context, { edge, format: format() }, 'warn');
    if (request.method === 'HEAD') return fallback('derivative_missing');
    if (!env.IMAGES || typeof env.IMAGES.input !== 'function') return fallback('binding_unavailable');
    phase = 'metadata';
    size ??= await readImageMetadata(env.SITE_BUCKET, hash);
    if (!input) { phase = 'source'; await loadInput(); }
    phase = 'encoder';
    const type = format() as ImageOutputOptions['format'];
    const output = await trace.run('thumbnail_transform', () => env.IMAGES!.input(input!)
      .transform({ width: thumbnailWidth(size!, edge), fit: 'scale-down' })
      .output({ format: type, ...(type !== 'image/gif' ? { quality: 80 } : {}), ...(['image/webp', 'image/gif'].includes(type) ? { anim: true } : {}) }));
    const rendered = output.response();
    try {
      if (rendered.status !== 200 || !rendered.body || rendered.headers.get('Content-Type') !== type) return fallback('unexpected_error');
      phase = 'cache_write';
      let bytes: ArrayBuffer | undefined;
      try {
        // Complete output must fit the memory budget before it becomes a derivative.
        bytes = await readLimited(new Request(url, { method: 'POST', body: rendered.body,
          ...(rendered.headers.has('Content-Length') ? { headers: { 'Content-Length': rendered.headers.get('Content-Length')! } } : {}) }), IMAGE_LIMIT);
      } catch (error) { if (!(error instanceof HttpError) || error.status !== 413) throw error; }
      if (bytes?.byteLength === 0) return fallback('unexpected_error');
      const oversized = bytes === undefined;
      const saved = await trace.run('thumbnail_cache_write', () => boundary('storage', () => env.SITE_BUCKET.put(variant.key, bytes ?? new Uint8Array(0), {
        onlyIf: cached ? { etagMatches: cached.etag } : { etagDoesNotMatch: '*' },
        customMetadata: { ...variant.metadata, ...(oversized ? { outcome: 'oversized-v1', limit: String(IMAGE_LIMIT) } : {}) },
        httpMetadata: { contentType: oversized ? 'application/octet-stream' : type, cacheControl: IMAGE_CACHE },
      })));
      emit('thumbnail_cache_fill', trace.context, { edge, format: type, bytes_written: saved?.size ?? 0, outcome: saved ? oversized ? 'oversized' : 'stored' : 'race' });
      if (saved && oversized && variant.oversized(saved)) return fallback('derivative_oversized');
      if (saved && bytes !== undefined && variant.valid(saved)) return response(bytes.byteLength, bytes);
      // Only a lost race needs a winner read. Never return the losing encoder's bytes.
      phase = 'cache_read';
      return await cachedResponse(await readCache(variant), variant, false) ?? fallback('cache_read_failed');
    } finally { await discard(rendered); }
  } catch (error) {
    if (!originalVerified || error instanceof HttpError && error.status === 404) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    return fallback(malformed ? 'malformed_image' : phase === 'cache_write' ? 'cache_write_failed' : error instanceof OperationFailure && error.kind === 'storage' ? 'storage_error' : code === 9422 ? 'quota_exhausted' : phase === 'encoder' && !(error instanceof TypeError) ? 'transformation_failed' : 'unexpected_error', error);
  } finally { await discard(body); if (input) await discard({ body: input }); }
}
