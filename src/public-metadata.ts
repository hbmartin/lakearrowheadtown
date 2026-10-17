import faviconSvg from '../favicon.svg';
import social from '../assets/social-card-v1.png';
import favicon from '../assets/favicon-v1.ico';
import favicon48 from '../assets/favicon-48-v1.png';
import appleTouch from '../assets/apple-touch-icon-v1.png';
import icon192 from '../assets/icon-192-v1.png';
import icon512 from '../assets/icon-512-v1.png';
import { matchesEtag, parseIfNoneMatch } from './conditions';
import { hashBytes, IMAGE_CACHE } from './images';
import { robotsText, sitemapXml, webManifest } from './metadata';
import { HTML_CACHE } from './publishing';
import { ASSETS, SITE } from './site';
import type { ContentBucket } from './types';

interface Resource {
  body: string | ArrayBuffer;
  type: string;
  cache: string;
  etag?: Promise<string>;
}

const resources = new Map<string, Resource>([
  ['/favicon.svg', { body: faviconSvg, type: 'image/svg+xml', cache: 'public, max-age=86400' }],
  // Browsers also request this conventional URL without consulting the head.
  ['/favicon.ico', { body: favicon, type: 'image/x-icon', cache: 'public, max-age=86400' }],
  [ASSETS.favicon, { body: favicon, type: 'image/x-icon', cache: IMAGE_CACHE }],
  ...([
    [ASSETS.social, social], [ASSETS.favicon48, favicon48], [ASSETS.appleTouch, appleTouch],
    [ASSETS.icon192, icon192], [ASSETS.icon512, icon512],
  ] as const).map(([path, body]): [string, Resource] => [path, { body, type: 'image/png', cache: IMAGE_CACHE }]),
  ['/site.webmanifest', { body: webManifest(), type: 'application/manifest+json; charset=utf-8', cache: 'public, max-age=3600' }],
]);
const robots = [false, true].map(indexable => ({ body: robotsText(indexable), type: 'text/plain; charset=utf-8', cache: 'public, max-age=3600' }));

async function resourceResponse(request: Request, resource: Resource): Promise<Response> {
  // Cache hashes for bundled resources, without caching request-specific headers.
  resource.etag ??= hashBytes(typeof resource.body === 'string' ? new TextEncoder().encode(resource.body) : new Uint8Array(resource.body))
    .then(hash => `${typeof resource.body === 'string' ? 'W/' : ''}"${hash}"`);
  const etag = await resource.etag;
  const unchanged = matchesEtag(parseIfNoneMatch(request.headers.get('if-none-match')), etag);
  return new Response(request.method === 'HEAD' || unchanged ? null : resource.body, {
    status: unchanged ? 304 : 200,
    headers: {
      'Content-Type': resource.type, 'Cache-Control': resource.cache, ETag: etag,
      'Cloudflare-CDN-Cache-Control': resource.cache === HTML_CACHE ? 'no-store' : resource.cache,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function committedPublicationTime(bucket: ContentBucket): Promise<string | undefined> {
  const index = await bucket.head('pages/index.html');
  const key = index?.customMetadata?.manifest;
  if (!key) return;
  const manifest = await bucket.get(key);
  if (!manifest) return;
  // Transport/storage failures remain errors; malformed or absent metadata simply
  // cannot supply an honest lastmod. Never scan sources or use index upload time.
  const text = await manifest.text();
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { if (error instanceof SyntaxError) return; throw error; }
  const time = value && typeof value === 'object' && 'published_at' in value ? value.published_at : undefined;
  if (typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time)) return;
  const date = new Date(time);
  return Number.isFinite(date.getTime()) && date.toISOString() === time ? time : undefined;
}

export function isIndexable(origin: string, requestOrigin: string): boolean {
  return origin === SITE.origin && requestOrigin === SITE.origin;
}

export async function metadataResource(request: Request, bucket: ContentBucket, origin: string): Promise<Response | undefined> {
  const url = new URL(request.url);
  const indexable = isIndexable(origin, url.origin);
  if (url.pathname === '/robots.txt') return resourceResponse(request, robots[Number(indexable)]);
  if (url.pathname === '/sitemap.xml' && indexable) {
    return resourceResponse(request, {
      body: sitemapXml(await committedPublicationTime(bucket)), type: 'application/xml; charset=utf-8', cache: HTML_CACHE,
    });
  }
  const resource = resources.get(url.pathname);
  if (resource) return resourceResponse(request, resource);
}
