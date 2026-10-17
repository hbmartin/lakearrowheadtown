import MarkdownIt, { type Token } from 'markdown-it';
import template from '../index.html';
import type { DigestItem, Publication, StoredPost } from './types';

export const TIME_ZONE = 'America/Los_Angeles';
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const emptyContent = template.match(/<!-- digests:start -->([\s\S]*?)<!-- digests:end -->/)![1].trim();

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

const prunableTags = new Set(['a', 'em', 'strong', 's', 'p', 'blockquote', 'li', 'ol', 'ul', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const emptyToken = (token: Token): boolean => token.type === 'inline'
  ? (token.children ?? []).every(emptyToken)
  : token.type === 'text' ? !token.content.trim() : ['softbreak', 'hardbreak'].includes(token.type);

// Removing an image can leave an empty link, paragraph, or list item behind.
function pruneEmptyWrappers(tokens: Token[]): Token[] {
  const result: Token[] = [];
  const openings: number[] = [];
  for (const token of tokens) {
    if (token.nesting === 1) openings.push(result.length);
    if (token.nesting === -1) {
      const start = openings.pop()!;
      if (prunableTags.has(result[start].tag) && result.slice(start + 1).every(emptyToken)) {
        result.splice(start);
        continue;
      }
    }
    result.push(token);
  }
  return result.every(emptyToken) ? [] : result;
}

function renderBody(item: DigestItem): string {
  const env = {};
  const tokens = markdown.parse(item.body, env);
  let thumbnail: Token | undefined;
  const imageLink = (image: Token, primary = false): Token[] => {
    const open = new MarkdownIt.Token('link_open', 'a', 1);
    open.attrs = [
      ['class', `article-image${primary ? ' article-thumbnail' : ''}`],
      ['href', item.post_url], ['rel', 'noopener noreferrer'],
      ['aria-label', `View original post: ${item.headline}`],
    ];
    return [open, image, new MarkdownIt.Token('link_close', 'a', -1)];
  };
  for (const token of tokens) {
    if (token.type !== 'inline' || !token.children?.some(child => child.type === 'image')) continue;
    const closing = new Map<Token, Token>();
    const stack: Token[] = [];
    for (const child of token.children) {
      if (child.nesting === 1) stack.push(child);
      if (child.nesting === -1) closing.set(stack.pop()!, child);
    }
    const rewritten: Token[] = [];
    for (const child of token.children) {
      if (child.type === 'image') {
        if (!thumbnail) thumbnail = child;
        else {
          // Split surrounding links/formatting so image links never nest inside them.
          rewritten.push(...[...stack].reverse().map(open => closing.get(open)!));
          rewritten.push(...imageLink(child), ...stack);
        }
      } else {
        rewritten.push(child);
        if (child.nesting === 1) stack.push(child);
        if (child.nesting === -1) stack.pop();
      }
    }
    token.children = pruneEmptyWrappers(rewritten);
  }
  const image = thumbnail ? markdown.renderer.renderInline(imageLink(thumbnail, true), markdown.options, env) : '';
  return image + markdown.renderer.render(thumbnail ? pruneEmptyWrappers(tokens) : tokens, markdown.options, env);
}

function renderItem(item: DigestItem): string {
  return `<article class="digest-item">
    <div class="item-meta"><a href="${escapeHtml(item.group_url)}" rel="noopener noreferrer">${escapeHtml(item.group)}</a>
      <time datetime="${escapeHtml(item.posted_at)}">${escapeHtml(timeFormat.format(new Date(item.posted_at)))}</time>
      ${item.category ? `<span class="category">${escapeHtml(item.category)}</span>` : ''}</div>
    <h3><a class="headline-link" href="${escapeHtml(item.post_url)}" rel="noopener noreferrer">${escapeHtml(item.headline)}</a></h3>
    <div class="markdown">${renderBody(item)}</div>
  </article>`;
}

function localDate(now: Date): string {
  const parts = dateFormat.formatToParts(now);
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function renderFeed(digests: StoredPost[], dates: string[]): string {
  const items = digests.flatMap(digest => digest.items).map(item => ({
    item, date: localDate(new Date(item.posted_at)), timestamp: Date.parse(item.posted_at),
  })).filter(({ date }) => !dates.length || dates.includes(date));
  // Stable sorting preserves input order for equal instants, including duplicates.
  items.sort((a, b) => b.timestamp - a.timestamp);
  const days = new Map<string, DigestItem[]>();
  for (const { item, date } of items) {
    if (!days.has(date)) days.set(date, []);
    days.get(date)!.push(item);
  }
  return [...days].map(([date, items]) => `<section class="digest" aria-labelledby="day-${date}">
    <header class="digest-header">
      <h2 id="day-${date}"><time datetime="${date}">${dayFormat.format(new Date(`${date}T12:00:00Z`))}</time></h2>
    </header>
    ${items.map(renderItem).join('\n')}
  </section>`).join('\n') || emptyContent;
}

export function renderPage(digests: StoredPost[], options: { origin: string; publication?: Publication }): string {
  const title = 'News from Lake Arrowhead . Town';
  const snapshot = options.publication;
  const dates = snapshot?.snapshot_date ? recentDates(new Date(`${snapshot.snapshot_date}T12:00:00Z`)) : [];
  const metadata = snapshot?.published_at && dates.length
    ? `<p class="snapshot-meta">Posts from ${escapeHtml(dayFormat.format(new Date(`${dates[6]}T12:00:00Z`)))} through ${escapeHtml(dayFormat.format(new Date(`${dates[0]}T12:00:00Z`)))}. Last published <time datetime="${escapeHtml(snapshot.published_at)}">${escapeHtml(timeFormat.format(new Date(snapshot.published_at)))}</time>.</p>` : '';
  const content = renderFeed(digests, dates);
  return template
    .replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(title)}</title>`)
    .replace('<!-- page-meta -->', () => `<link rel="canonical" href="${escapeHtml(options.origin + '/')}">\n  <meta property="og:title" content="${escapeHtml(title)}">`)
    .replace('<!-- snapshot-meta -->', () => metadata)
    .replace(/<!-- digests:start -->[\s\S]*?<!-- digests:end -->/, () => `<!-- digests:start -->\n${content}\n<!-- digests:end -->`);
}

// Calendar arithmetic uses date labels, avoiding 23/25-hour days around DST.
export function recentDates(now: Date): string[] {
  const today = new Date(`${localDate(now)}T12:00:00Z`);
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(today);
    day.setUTCDate(day.getUTCDate() - i);
    return day.toISOString().slice(0, 10);
  });
}
