import { escapeHtml } from './html';
import { ASSETS, SITE } from './site';
import type { DigestItem } from './types';

export function renderMetadata(origin: string, items: DigestItem[], publishedAt?: string | null): string {
  const url = `${origin}/`;
  const image = `${origin}${ASSETS.social}`;
  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite', '@id': `${url}#website`, url,
        name: SITE.name, description: SITE.description, inLanguage: SITE.language,
      },
      {
        '@type': 'CollectionPage', '@id': `${url}#webpage`, url,
        name: SITE.title, description: SITE.description, inLanguage: SITE.language,
        isPartOf: { '@id': `${url}#website` },
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
    ],
  };
  const named: Record<string, string> = {
    description: SITE.description,
    'application-name': SITE.name,
    robots: origin === SITE.origin ? 'index, follow, max-image-preview:large' : 'noindex',
    'theme-color': SITE.background,
    'twitter:card': 'summary_large_image',
    'twitter:title': SITE.title,
    'twitter:description': SITE.description,
    'twitter:image': image,
    'twitter:image:alt': SITE.imageAlt,
  };
  const properties: Record<string, string> = {
    'og:type': 'website',
    'og:site_name': SITE.name,
    'og:title': SITE.title,
    'og:description': SITE.description,
    'og:url': url,
    'og:locale': SITE.locale,
    'og:image': image,
    ...(origin.startsWith('https://') ? { 'og:image:secure_url': image } : {}),
    'og:image:type': 'image/png',
    'og:image:width': '1200',
    'og:image:height': '630',
    'og:image:alt': SITE.imageAlt,
  };
  return [
    `<title>${escapeHtml(SITE.title)}</title>`,
    `<link rel="canonical" href="${escapeHtml(url)}">`,
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

export function sitemapXml(publishedAt?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${escapeHtml(SITE.origin)}/</loc>${publishedAt ? `<lastmod>${escapeHtml(publishedAt)}</lastmod>` : ''}</url></urlset>\n`;
}
