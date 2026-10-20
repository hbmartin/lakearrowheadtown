import { escapeHtml } from './html';
import { ASSETS, SITE } from './site';
import type { DigestItem } from './types';

export interface PageMetadata {
  path?: string;
  title?: string;
  description?: string;
  image?: string;
  imageAlt?: string;
  socialTitle?: string;
  type?: 'CollectionPage' | 'WebPage';
}

export function renderMetadata(origin: string, items: DigestItem[], publishedAt?: string | null, page: PageMetadata = {}): string {
  const home = `${origin}/`;
  const url = `${origin}${page.path ?? '/'}`;
  const title = page.title ?? SITE.title;
  const description = page.description ?? SITE.description;
  const socialTitle = page.socialTitle ?? (page.title ? title : SITE.socialTitle);
  const image = `${origin}${page.image ?? ASSETS.social}`;
  const imageAlt = page.imageAlt ?? SITE.imageAlt;
  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite', '@id': `${home}#website`, url: home,
        name: SITE.name, alternateName: ['Lake Arrowhead Town', 'lakearrowhead.town'], description: SITE.description, inLanguage: SITE.language,
        publisher: { '@id': `${home}#publisher` }, about: { '@id': `${home}#place` },
      },
      {
        '@type': page.type ?? 'CollectionPage', '@id': `${url}#webpage`, url,
        name: title, description, inLanguage: SITE.language,
        isPartOf: { '@id': `${home}#website` },
        publisher: { '@id': `${home}#publisher` },
        about: { '@id': `${home}#place` }, spatialCoverage: { '@id': `${home}#place` },
        mainEntity: { '@id': `${url}#news` },
        image,
        ...(publishedAt ? { dateModified: publishedAt } : {}),
      },
      {
        '@type': 'ItemList', '@id': `${url}#news`, numberOfItems: items.length,
        itemListElement: items.map((item, index) => ({
          '@type': 'ListItem', position: index + 1, name: item.headline, url: item.post_url,
        })),
      },
      {
        '@type': 'Organization', '@id': `${home}#publisher`, name: SITE.name, url: home,
        logo: { '@type': 'ImageObject', url: `${origin}${ASSETS.icon512}`, width: 512, height: 512 },
      },
      {
        '@type': 'Place', '@id': `${home}#place`, name: 'Lake Arrowhead, California',
        address: { '@type': 'PostalAddress', addressLocality: 'Lake Arrowhead', addressRegion: 'CA', addressCountry: 'US' },
        geo: { '@type': 'GeoCoordinates', latitude: 34.2530894, longitude: -117.1944039 },
      },
    ],
  };
  const named: Record<string, string> = {
    description,
    'application-name': SITE.name,
    robots: origin === SITE.origin ? 'index, follow, max-image-preview:large' : 'noindex',
    'theme-color': SITE.background,
    'twitter:card': 'summary_large_image',
    'twitter:title': socialTitle,
    'twitter:description': description,
    'twitter:image': image,
    'twitter:image:alt': imageAlt,
  };
  const properties: Record<string, string> = {
    'og:type': 'website',
    'og:site_name': SITE.name,
    'og:title': socialTitle,
    'og:description': description,
    'og:url': url,
    'og:locale': SITE.locale,
    'og:image': image,
    ...(origin.startsWith('https://') ? { 'og:image:secure_url': image } : {}),
    'og:image:type': 'image/png',
    'og:image:width': '1200',
    'og:image:height': '630',
    'og:image:alt': imageAlt,
  };
  return [
    `<title>${escapeHtml(title)}</title>`,
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(SITE.title)}" href="${escapeHtml(origin)}/rss.xml">`,
    ...Object.entries(named).map(([name, content]) => `<meta name="${name}" content="${escapeHtml(content)}">`),
    ...Object.entries(properties).map(([property, content]) => `<meta property="${property}" content="${escapeHtml(content)}">`),
    '<link rel="icon" type="image/svg+xml" sizes="any" href="/favicon.svg">',
    `<link rel="icon" type="image/png" sizes="48x48" href="${ASSETS.favicon48}">`,
    `<link rel="alternate icon" type="image/x-icon" sizes="16x16 32x32 48x48" href="${ASSETS.favicon}">`,
    `<link rel="apple-touch-icon" sizes="180x180" href="${ASSETS.appleTouch}">`,
    '<link rel="manifest" href="/site.webmanifest">',
    // HTML script parsing precedes JSON parsing: literal < could close this element.
    `<script type="application/ld+json">${JSON.stringify(graph).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}</script>`,
  ].join('\n  ');
}

export function webManifest(): string {
  return JSON.stringify({
    id: '/', name: SITE.name, short_name: SITE.name, description: SITE.description,
    lang: SITE.language, start_url: '/', scope: '/', display: 'browser',
    background_color: SITE.background, theme_color: SITE.background,
    icons: [
      { src: ASSETS.icon192, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: ASSETS.icon512, sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  });
}

export function robotsText(indexable: boolean): string {
  return `User-agent: *\nAllow: /\nDisallow: /api/\n${indexable ? `\nSitemap: ${SITE.origin}/sitemap.xml\n` : ''}`;
}

export function sitemapXml(publishedAt?: string, pages: { path: string; modified?: string }[] = []): string {
  const entries = [{ path: '/', modified: publishedAt }, ...pages];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.map(({ path, modified }) => `<url><loc>${escapeHtml(SITE.origin + path)}</loc>${modified ? `<lastmod>${escapeHtml(modified)}</lastmod>` : ''}</url>`).join('')}</urlset>\n`;
}
