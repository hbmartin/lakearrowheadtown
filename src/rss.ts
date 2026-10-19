import MarkdownIt from 'markdown-it';
import { fingerprint } from './diagnostics';
import { selectFeedItems } from './feed';
import { escapeHtml } from './html';
import { SITE } from './site';
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

// XML 1.0 permits tabs/newlines and valid Unicode scalar values, but not lone surrogates.
function xml(text: string): string {
  return escapeHtml(text.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '\ufffd'));
}

export function renderRss(posts: StoredPost[], options: { origin: string; publication?: Publication }): string {
  const { origin, publication } = options;
  const items = selectFeedItems(posts, publication).map(({ item, postId, itemIndex, timestamp }) => {
    const body = markdown.render(item.body, { origin });
    const attribution = `<p>From <a href="${escapeHtml(item.group_url)}">${escapeHtml(item.group)}</a> · <a href="${escapeHtml(item.post_url)}">View original post</a></p>`;
    const guid = `urn:sha256:${fingerprint(JSON.stringify([postId, itemIndex]))}`;
    return `    <item>
      <title>${xml(item.headline)}</title>
      <link>${xml(item.post_url)}</link>
      <guid isPermaLink="false">${guid}</guid>
      <pubDate>${new Date(timestamp).toUTCString()}</pubDate>
      ${item.category ? `<category>${xml(item.category)}</category>\n      ` : ''}<description>${xml(body + attribution)}</description>
    </item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(SITE.title)}</title>
    <link>${xml(origin)}/</link>
    <description>${xml(SITE.description)}</description>
    <language>${SITE.language}</language>
    <atom:link href="${xml(origin)}/rss.xml" rel="self" type="application/rss+xml"/>
    ${publication?.published_at ? `<lastBuildDate>${new Date(publication.published_at).toUTCString()}</lastBuildDate>\n    ` : ''}${items.join('\n')}
  </channel>
</rss>
`;
}
