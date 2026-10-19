import MarkdownIt, { type Token } from 'markdown-it';
import template from '../index.html';
import { escapeHtml } from './html';
import { renderMetadata } from './metadata';
import { selectFeedItems, snapshotDates, TIME_ZONE } from './feed';
import type { DigestItem, Publication, StoredPost } from './types';
export { escapeHtml } from './html';
export { recentDates, TIME_ZONE } from './feed';

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
const dayFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const fullTimeFormat = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
const emptyContent = template.match(/<!-- digests:start -->([\s\S]*?)<!-- digests:end -->/)![1].trim();

const emptyToken = (token: Token): boolean => token.type === 'inline'
  ? (token.children ?? []).every(emptyToken)
  : token.type === 'text' ? !token.content.trim() : ['softbreak', 'hardbreak'].includes(token.type);

// Only remove ancestors changed by image extraction or link splitting.
function removeEmptiedWrappers(tokens: Token[], affected: Set<Token>, preserveWhitespace = false): Token[] {
  const result: Token[] = [];
  const openings: number[] = [];
  for (const token of tokens) {
    if (token.nesting === 1) openings.push(result.length);
    if (token.nesting === -1) {
      const start = openings.pop()!;
      if (affected.has(result[start]) && result.slice(start + 1).every(emptyToken)) {
        if (preserveWhitespace) result.splice(start, 1);
        else result.splice(start);
        continue;
      }
    }
    result.push(token);
  }
  return result;
}

function renderBody(item: DigestItem): string {
  const env = {};
  const tokens = markdown.parse(item.body, env);
  let thumbnail: Token | undefined;
  const blocks: Token[] = [];
  const affectedBlocks = new Set<Token>();
  const itemLists = new Map<Token, Token>();
  const listSizes = new Map<Token, number>();
  const imageLink = (image: Token, primary = false): Token[] => {
    const open = new MarkdownIt.Token('link_open', 'a', 1);
    open.attrs = [
      ['class', `article-image${primary ? ' article-thumbnail' : ''}`],
      ['href', item.post_url], ['rel', 'noopener noreferrer'],
    ];
    if (!markdown.renderer.renderInlineAsText(image.children ?? [], markdown.options, env).trim()) {
      open.attrSet('aria-label', `View original post: ${item.headline}`);
    }
    return [open, image, new MarkdownIt.Token('link_close', 'a', -1)];
  };
  for (const token of tokens) {
    if (token.nesting === 1) {
      if (token.tag === 'li') {
        const list = blocks.at(-1)!;
        itemLists.set(token, list);
        listSizes.set(list, (listSizes.get(list) ?? 0) + 1);
      }
      blocks.push(token);
    }
    if (token.nesting === -1) blocks.pop();
    if (token.type !== 'inline' || !token.children?.some(child => child.type === 'image')) continue;
    const affectedInline = new Set<Token>();
    let extracted = false;
    const closing = new Map<Token, Token>();
    const stack: Token[] = [];
    for (const child of token.children) {
      if (child.nesting === 1) stack.push(child);
      if (child.nesting === -1) closing.set(stack.pop()!, child);
    }
    const rewritten: Token[] = [];
    for (const child of token.children) {
      if (child.type === 'image') {
        stack.forEach(open => affectedInline.add(open));
        if (!thumbnail) {
          thumbnail = child;
          extracted = true;
          blocks.forEach(open => {
            if (open.tag !== 'td' && open.tag !== 'th') affectedBlocks.add(open);
          });
        } else {
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
    token.children = removeEmptiedWrappers(rewritten, affectedInline, true);
    if (extracted) {
      // Moving a leading image can leave its caption's separator at the start.
      const leadingBreaks = new Set<Token>();
      for (const child of token.children) {
        if (child.nesting || (child.type === 'text' && !child.content.trim())) continue;
        if (!['softbreak', 'hardbreak'].includes(child.type)) break;
        leadingBreaks.add(child);
      }
      token.children = token.children.filter(child => !leadingBreaks.has(child));
    }
  }
  // Keep an extracted image's marker when siblings remain, including empty ones.
  for (const [listItem, list] of itemLists) {
    if (listSizes.get(list)! > 1) affectedBlocks.delete(listItem);
  }
  const image = thumbnail ? markdown.renderer.renderInline(imageLink(thumbnail, true), markdown.options, env) : '';
  return image + markdown.renderer.render(removeEmptiedWrappers(tokens, affectedBlocks), markdown.options, env);
}

function renderItem(item: DigestItem): string {
  const postedAt = new Date(item.posted_at);
  const exactTime = escapeHtml(fullTimeFormat.format(postedAt));
  const displayTime = escapeHtml(timeFormat.format(postedAt));
  return `<article class="digest-item">
    <div class="item-meta"><a class="item-group" href="${escapeHtml(item.group_url)}" rel="noopener noreferrer">${escapeHtml(item.group)}</a>
      <time class="post-time" datetime="${escapeHtml(item.posted_at)}" title="${exactTime}">${displayTime}</time>
      ${item.category ? `<span class="category">${escapeHtml(item.category)}</span>` : ''}</div>
    <h3><a class="headline-link" href="${escapeHtml(item.post_url)}" rel="noopener noreferrer">${escapeHtml(item.headline)}</a></h3>
    <div class="markdown">${renderBody(item)}</div>
  </article>`;
}

function renderFeed(items: ReturnType<typeof selectFeedItems>): string {
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
  const snapshot = options.publication;
  const dates = snapshotDates(snapshot);
  const metadata = snapshot?.published_at && dates.length
    ? `<p class="snapshot-meta">Posts from ${escapeHtml(dayFormat.format(new Date(`${dates[6]}T12:00:00Z`)))} through ${escapeHtml(dayFormat.format(new Date(`${dates[0]}T12:00:00Z`)))}. Last published <time datetime="${escapeHtml(snapshot.published_at)}">${escapeHtml(timeFormat.format(new Date(snapshot.published_at)))}</time>.</p>` : '';
  const items = selectFeedItems(digests, snapshot);
  const content = renderFeed(items);
  return template
    .replace('<!-- page-meta -->', () => renderMetadata(options.origin, items.map(({ item }) => item), snapshot?.published_at))
    .replace('<!-- snapshot-meta -->', () => metadata)
    .replace(/<!-- digests:start -->[\s\S]*?<!-- digests:end -->/, () => `<!-- digests:start -->\n${content}\n<!-- digests:end -->`);
}
