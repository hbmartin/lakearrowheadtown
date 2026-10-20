import MarkdownIt from 'markdown-it';
import { fingerprint } from './diagnostics';
import { orderedUpdates, selectFeedItems } from './feed';
import { escapeHtml } from './html';
import { xmlText as xml } from './xml';
import { bodyImages, type ImageMetadataMap } from './image-metadata';
import { ASSETS, SITE } from './site';
import type { Publication, StoredPost } from './types';

export const RSS_TYPE = 'application/rss+xml; charset=utf-8';
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });

// Feed readers have no page URL against which to resolve relative links or images.
for (const [rule, attribute] of [['link_open', 'href'], ['image', 'src']] as const) {
  const render = markdown.renderer.rules[rule] ?? ((tokens, index, options, _env, renderer) => renderer.renderToken(tokens, index, options));
  markdown.renderer.rules[rule] = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const value = token.attrGet(attribute);
    if (value !== null) {
      try {
        const absolute = new URL(String(value), `${env?.origin}/`).href;
        if (markdown.validateLink(absolute)) token.attrSet(attribute, absolute);
      } catch { /* Preserve Markdown's safe output for malformed URL text. */ }
    }
    return render(tokens, index, options, env, renderer);
  };
}

export function renderRss(posts: StoredPost[], options: { origin: string; publication?: Publication; images?: ImageMetadataMap }): string {
  const { origin, publication } = options;
  const items = selectFeedItems(posts, publication).map(({ item, postId, itemIndex }) => {
    const body = markdown.render(item.body, { origin });
    const attribution = `<p>From <a href="${escapeHtml(item.group_url)}">${escapeHtml(item.group)}</a> · <a href="${escapeHtml(item.post_url)}">View original post</a></p>`;
    const updates = orderedUpdates(item).map(update => `<section><p><strong>${update.body.trim() ? 'Update' : 'Additional source'}</strong> · ${escapeHtml(update.posted_at)} · ${update.group_url ? `<a href="${escapeHtml(update.group_url)}">${escapeHtml(update.group)}</a>` : escapeHtml(update.group)} · <a href="${escapeHtml(update.post_url)}">View source post</a></p>${markdown.render(update.body, { origin })}</section>`).join('');
    const thumbnail = [item.body, ...orderedUpdates(item).map(update => update.body)].flatMap(body => bodyImages(body, origin))[0];
    const image = thumbnail ? options.images?.[thumbnail] : undefined;
    const media = thumbnail ? `<media:content url="${xml(thumbnail)}" medium="image"${image ? ` type="${image.type}" width="${image.width}" height="${image.height}"` : ''}/>` : '';
    const guid = `urn:sha256:${fingerprint(JSON.stringify([postId, itemIndex]))}`;
    return `    <item>
      <title>${xml(item.headline)}</title>
      <link>${xml(item.post_url)}</link>
      <guid isPermaLink="false">${guid}</guid>
      <dc:creator>${xml(item.group)}</dc:creator>
      ${media}
      <pubDate>${new Date(item.posted_at).toUTCString()}</pubDate>
      ${item.category ? `<category>${xml(item.category)}</category>\n      ` : ''}<description>${xml(body + attribution + updates)}</description>
    </item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${xml(SITE.title)}</title>
    <link>${xml(origin)}/</link>
    <description>${xml(SITE.description)}</description>
    <image><url>${xml(origin)}${ASSETS.favicon48}</url><title>${xml(SITE.name)}</title><link>${xml(origin)}/</link><width>48</width><height>48</height></image>
    <ttl>15</ttl>
    <language>${SITE.language}</language>
    <atom:link href="${xml(origin)}/rss.xml" rel="self" type="application/rss+xml"/>
    ${publication?.published_at ? `<lastBuildDate>${new Date(publication.published_at).toUTCString()}</lastBuildDate>\n    ` : ''}${items.join('\n')}
  </channel>
</rss>
`;
}
