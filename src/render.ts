import MarkdownIt, { type Token } from 'markdown-it';
import template from '../index.html';
import { escapeHtml } from './html';
import { renderMetadata } from './metadata';
import type { DigestItem, Publication, StoredPost } from './types';
export { escapeHtml } from './html';

export const TIME_ZONE = 'America/Los_Angeles';
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const fullTimeFormat = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
const emptyContent = template.match(/<!-- digests:start -->([\s\S]*?)<!-- digests:end -->/)![1].trim();

const emptyToken = (token: Token): boolean => token.type === 'inline'
  ? (token.children ?? []).every(emptyToken)
  : token.type === 'text' ? !token.content.trim() : ['softbreak', 'hardbreak'].includes(token.type);

// Only remove ancestors changed by image extraction or link splitting.
function removeEmptiedWrappers(tokens: Token[], affected: Set<Token>): Token[] {
  const result: Token[] = [];
  const openings: number[] = [];
  for (const token of tokens) {
    if (token.nesting === 1) openings.push(result.length);
    if (token.nesting === -1) {
      const start = openings.pop()!;
      if (affected.has(result[start]) && result.slice(start + 1).every(emptyToken)) {
        result.splice(start);
        continue;
      }
    }
    result.push(token);
  }
  return result;
}

function textEdge(tokens: Token[], last = false): string {
  for (let i = last ? tokens.length - 1 : 0; i >= 0 && i < tokens.length; i += last ? -1 : 1) {
    const token = tokens[i];
    if (token.nesting || (token.type === 'text' && !token.content)) continue;
    if (!['text', 'code_inline'].includes(token.type)) return '';
    const characters = Array.from(token.content);
    return (last ? characters.at(-1) : characters[0]) ?? '';
  }
  return '';
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
    for (const [index, child] of token.children.entries()) {
      if (child.type === 'image') {
        stack.forEach(open => affectedInline.add(open));
        if (!thumbnail) {
          thumbnail = child;
          extracted = true;
          blocks.forEach(open => affectedBlocks.add(open));
          // A moved inline image must not concatenate the words around it.
          if (/[\p{L}\p{N}_]/u.test(textEdge(rewritten, true)) && /[\p{L}\p{N}_]/u.test(textEdge(token.children.slice(index + 1)))) {
            const space = new MarkdownIt.Token('text', '', 0);
            space.content = ' ';
            rewritten.push(space);
          }
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
    token.children = removeEmptiedWrappers(rewritten, affectedInline);
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
  return `<article class="digest-item">
    <div class="item-meta"><a class="item-group" href="${escapeHtml(item.group_url)}" rel="noopener noreferrer">${escapeHtml(item.group)}</a>
      <time class="post-time" datetime="${escapeHtml(item.posted_at)}" title="${exactTime}" aria-label="${exactTime}">${escapeHtml(timeFormat.format(postedAt))}</time>
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

function feedItems(digests: StoredPost[], dates: string[]) {
  const items = digests.flatMap(digest => digest.items).map(item => ({
    item, date: localDate(new Date(item.posted_at)), timestamp: Date.parse(item.posted_at),
  })).filter(({ date }) => !dates.length || dates.includes(date));
  // Stable sorting preserves input order for equal instants, including duplicates.
  items.sort((a, b) => b.timestamp - a.timestamp);
  return items;
}

function renderFeed(items: ReturnType<typeof feedItems>): string {
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
  const dates = snapshot?.snapshot_date ? recentDates(new Date(`${snapshot.snapshot_date}T12:00:00Z`)) : [];
  const metadata = snapshot?.published_at && dates.length
    ? `<p class="snapshot-meta">Posts from ${escapeHtml(dayFormat.format(new Date(`${dates[6]}T12:00:00Z`)))} through ${escapeHtml(dayFormat.format(new Date(`${dates[0]}T12:00:00Z`)))}. Last published <time datetime="${escapeHtml(snapshot.published_at)}">${escapeHtml(timeFormat.format(new Date(snapshot.published_at)))}</time>.</p>` : '';
  const items = feedItems(digests, dates);
  const content = renderFeed(items);
  return template
    .replace('<!-- page-meta -->', () => renderMetadata(options.origin, items.map(({ item }) => item), snapshot?.published_at))
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
