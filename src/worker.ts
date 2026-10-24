import { validRssKey } from './committed';
import { matchesEtag, parseIfNoneMatch } from './conditions';
import { boundary } from './errors';
import { hashBytes, IMAGE_CACHE } from './images';
import { pageResource } from './pages';
import { metadataResource } from './public-metadata';
import { HTML_CACHE } from './publishing';
import { renderPage } from './render';
import { renderRss, RSS_TYPE } from './rss';
import { thumbnailResponse } from './thumbnails';
import type { Env } from './types';
import { HttpError } from './validation';
export { DigestPublisher } from './publisher';

import { api } from './http/api';
import { beginRequest, errorResponse, finishRequest, originFor, type RequestState } from './http/lifecycle';
// Cache each empty representation per serving origin instead of hashing every request.
const fallbackPages = new Map<string, Promise<{ body: string; etag: string }>>();
function fallbackFor(origin: string, rss = false): Promise<{ body: string; etag: string }> {
  const key = `${origin}${rss ? '/rss.xml' : '/'}`;
  let page = fallbackPages.get(key);
  if (!page) {
    page = (async () => {
      const body = rss ? renderRss([], { origin }) : renderPage([], { origin });
      return { body, etag: `W/"${await hashBytes(new TextEncoder().encode(body))}"` };
    })();
    fallbackPages.set(key, page);
  }
  return page;
}

async function emptyResponse(request: Request, origin: string, rss = false): Promise<Response> {
  const { body, etag } = await fallbackFor(origin, rss);
  const unchanged = matchesEtag(parseIfNoneMatch(request.headers.get('if-none-match')), etag);
  return new Response(request.method === 'HEAD' || unchanged ? null : body, {
    status: unchanged ? 304 : 200,
    headers: { 'Cache-Control': HTML_CACHE, 'Cloudflare-CDN-Cache-Control': 'no-store',
      'Content-Type': rss ? RSS_TYPE : 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ETag: etag },
  });
}

function rssUnavailable(): HttpError {
  return new HttpError(503, 'RSS feed is temporarily unavailable. Please try again later.', { 'Retry-After': '60' });
}

async function publicObject(request: Request, env: Env, key: string, type: 'html' | 'image' | 'rss' = 'html'): Promise<Response> {
  const image = type === 'image';
  const condition = parseIfNoneMatch(request.headers.get('if-none-match'));
  const object = await boundary('storage', () => request.method === 'HEAD'
    ? env.SITE_BUCKET.head(key)
    : env.SITE_BUCKET.get(key, condition ? { onlyIf: new Headers({ 'If-None-Match': condition.header }) } : undefined));
  const headers = new Headers({ 'Cloudflare-CDN-Cache-Control': image ? IMAGE_CACHE : 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (!object) {
    if (type === 'rss') throw rssUnavailable();
    if (key !== 'pages/index.html') throw new HttpError(404, 'Not found');
    return emptyResponse(request, originFor(request, env));
  }
  object.writeHttpMetadata(headers);
  if (!image) headers.set('Content-Type', type === 'rss' ? RSS_TYPE : 'text/html; charset=utf-8');
  // Serving policy overrides metadata on older stored objects too.
  headers.set('Cache-Control', image ? IMAGE_CACHE : HTML_CACHE);
  const etag = image ? object.httpEtag : `W/"${object.etag}"`;
  headers.set('ETag', etag);
  const body = (object as Partial<R2ObjectBody>).body;
  if (matchesEtag(condition, etag)) {
    if (body) await body.cancel();
    return new Response(null, { status: 304, headers });
  }
  if (request.method === 'HEAD') return new Response(null, { headers });
  if (!body) throw new Error('Unexpected conditional read result');
  return new Response(body, { headers });
}


async function handlePublic(request: Request, env: Env, state: RequestState, execution?: ExecutionContext): Promise<Response> {
  const { trace } = state;
  const path = new URL(request.url).pathname;
  try {
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    let origin = '';
    try { origin = originFor(request, env); }
    catch (error) { if (!(error instanceof HttpError && error.status === 503)) throw error; }
    return await trace.run('public_read', async () => {
      if (path.startsWith('/thumbnails/')) return thumbnailResponse(request, env, trace, execution);
      const metadata = await metadataResource(request, env.SITE_BUCKET, origin);
      if (metadata) return metadata;
      const page = await pageResource(request, env.SITE_BUCKET, origin);
      if (page) return page;
      if (path === '/rss.xml') {
        const index = await boundary('storage', () => env.SITE_BUCKET.head('pages/index.html'));
        if (!index) return emptyResponse(request, originFor(request, env), true);
        const key = index.customMetadata?.rss;
        if (!validRssKey(key)) throw rssUnavailable();
        return publicObject(request, env, key, 'rss');
      }
      if (path === '/' || path === '/index.html') return publicObject(request, env, 'pages/index.html');
      if (/^\/assets\/daily\/[a-f0-9]{64}\.png$/.test(path)) return publicObject(request, env, path.slice(1), 'image');
      if (/^\/images\/[a-f0-9]{64}\.(jpg|png|webp|gif)$/.test(path)) return publicObject(request, env, path.slice(1), 'image');
      throw new HttpError(404, 'Not found');
    });
  } catch (error) { return errorResponse(error, request, state); }
}
export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const origin = env.SITE_ORIGIN || 'https://lakearrowheadtown-preview.harold-martin.workers.dev';
    await env.PUBLISHER.getByName('site').pullWeatherV1(origin);
  },
  async fetch(request: Request, env: Env, execution?: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/api' || path.startsWith('/api/')) return api.fetch(request, env, execution);
    const state = beginRequest(request, env);
    return finishRequest(request, env, state, await handlePublic(request, env, state, execution));
  },
} satisfies ExportedHandler<Env>;
