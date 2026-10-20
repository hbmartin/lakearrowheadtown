import MarkdownIt, { type Token } from 'markdown-it';
import template from '../index.html';
import { escapeHtml } from './html';
import { archivePath, type ArchiveDay, type ArchiveReference } from './archives';
import type { ImageMetadataMap } from './image-metadata';
import type { PageMetadata } from './metadata';
import { renderMetadata } from './metadata';
import { orderedUpdates, selectFeedItems, snapshotDates, TIME_ZONE } from './feed';
import type { DigestItem, Publication, StoredItem, StoredPost } from './types';
export { escapeHtml } from './html';
export { recentDates, TIME_ZONE } from './feed';

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
interface ImageContext extends Record<PropertyKey, unknown> { origin: string; images: ImageMetadataMap; count: number }
const defaultImage = markdown.renderer.rules.image!;
markdown.renderer.rules.image = (tokens, index, options, environment, renderer) => {
  const env = environment as unknown as ImageContext;
  const token = tokens[index];
  let url = String(token.attrGet('src') ?? '');
  try { url = new URL(url, `${env.origin}/`).href; } catch { /* Markdown retains safe authored text. */ }
  if (markdown.validateLink(url)) token.attrSet('src', url);
  const size = env.images[url];
  if (size) { token.attrSet('width', String(size.width)); token.attrSet('height', String(size.height)); }
  token.attrSet('loading', env.count++ === 0 ? 'eager' : 'lazy');
  token.attrSet('decoding', 'async');
  return defaultImage(tokens, index, options, env, renderer);
};
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

function renderBody(item: DigestItem, env: ImageContext): string {
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

function renderTime(value: string): string {
  return `<time class="post-time" datetime="${escapeHtml(value)}" title="${escapeHtml(fullTimeFormat.format(new Date(value)))}">${escapeHtml(timeFormat.format(new Date(value)))}</time>`;
}

function renderItem({ item }: { item: StoredItem }, context: ImageContext): string {
  const postedAt = new Date(item.posted_at);
  const updates = orderedUpdates(item);
  const exactTime = escapeHtml(fullTimeFormat.format(postedAt));
  const displayTime = escapeHtml(timeFormat.format(postedAt));
  return `<article class="digest-item">
    <div class="item-meta"><a class="item-group" href="${escapeHtml(item.group_url)}" rel="noopener noreferrer">${escapeHtml(item.group)}</a>
      <time class="post-time" datetime="${escapeHtml(item.posted_at)}" title="${exactTime}">${displayTime}</time>
      ${item.category ? `<span class="category">${escapeHtml(item.category)}</span>` : ''}</div>
    <h3><a class="headline-link" href="${escapeHtml(item.post_url)}" rel="noopener noreferrer">${escapeHtml(item.headline)}</a></h3>
    <div class="markdown">${renderBody(item, context)}</div>${updates.length ? `
    <p class="item-meta story-updated">Updated ${renderTime(updates.at(-1)!.posted_at)}</p>
    <div class="story-updates" aria-label="Story updates">${updates.map(update => `
      <div class="story-update">
        <div class="item-meta"><span>${update.body.trim() ? 'Update' : 'Additional source'}</span>${renderTime(update.posted_at)}
          <span>${update.group_url ? `<a href="${escapeHtml(update.group_url)}" rel="noopener noreferrer">${escapeHtml(update.group)}</a>` : escapeHtml(update.group)} · <a href="${escapeHtml(update.post_url)}" rel="noopener noreferrer">View source post</a></span></div>
        ${update.body ? `<div class="markdown">${renderBody({ ...item, ...update, group_url: update.group_url ?? '' }, context)}</div>` : ''}
      </div>`).join('\n')}
    </div>` : ''}
  </article>`;
}

function renderFeed(items: ReturnType<typeof selectFeedItems>, context: ImageContext): string {
  const days = new Map<string, typeof items>();
  for (const entry of items) {
    const { date } = entry;
    if (!days.has(date)) days.set(date, []);
    days.get(date)!.push(entry);
  }
  return [...days].map(([date, items]) => `<section class="digest" aria-labelledby="day-${date}">
    <header class="digest-header">
      <h2 id="day-${date}"><a href="${archivePath(date)}"><time datetime="${date}">${dayFormat.format(new Date(`${date}T12:00:00Z`))}</time></a></h2>
    </header>
    ${items.map(entry => renderItem(entry, context)).join('\n')}
  </section>`).join('\n') || emptyContent;
}

export function renderPage(digests: StoredPost[], options: { origin: string; publication?: Publication; images?: ImageMetadataMap }): string {
  const snapshot = options.publication;
  const dates = snapshotDates(snapshot);
  const metadata = snapshot?.published_at && dates.length
    ? `<p class="snapshot-meta">Posts from ${escapeHtml(dayFormat.format(new Date(`${dates[6]}T12:00:00Z`)))} through ${escapeHtml(dayFormat.format(new Date(`${dates[0]}T12:00:00Z`)))}. Last published <time datetime="${escapeHtml(snapshot.published_at)}">${escapeHtml(timeFormat.format(new Date(snapshot.published_at)))}</time>.</p>` : '';
  const items = selectFeedItems(digests, snapshot);
  const content = renderFeed(items, { origin: options.origin, images: options.images ?? {}, count: 0 });
  return template
    .replace('<!-- page-meta -->', () => renderMetadata(options.origin, items.map(({ item }) => item), snapshot?.published_at))
    .replace('<!-- snapshot-meta -->', () => metadata)
    .replace(/<!-- digests:start -->[\s\S]*?<!-- digests:end -->/, () => `<!-- digests:start -->\n${content}\n<!-- digests:end -->`);
}

export function renderContentPage(origin: string, page: PageMetadata, heading: string, body: string): string {
  return template
    .replace('<!-- page-meta -->', () => renderMetadata(origin, [], undefined, { type: 'WebPage', ...page }))
    .replace('<!-- snapshot-meta -->', '')
    .replace(/<!-- digests:start -->[\s\S]*?<!-- digests:end -->/, () => `<!-- digests:start --><section class="resource-page"><h2>${escapeHtml(heading)}</h2>${body}</section><!-- digests:end -->`);
}

export function renderArchivePage(origin: string, day: ArchiveDay, ref: ArchiveReference): string {
  const label = dayFormat.format(new Date(`${day.date}T12:00:00Z`));
  const title = `Lake Arrowhead news — ${label}`;
  const headline = day.stories[0]?.item.headline;
  const description = `${label}: ${headline ?? 'Community news and local updates from Lake Arrowhead, California.'}`.slice(0, 200);
  return template
    .replace('<!-- page-meta -->', () => renderMetadata(origin, day.stories.map(story => story.item), ref.modified, {
      path: archivePath(day.date), title, description, image: ref.image, imageAlt: `${label}: ${headline ?? 'Lake Arrowhead news'}`,
    }))
    .replace('<!-- snapshot-meta -->', () => `<p class="snapshot-meta">News archive for ${escapeHtml(label)}.${ref.modified ? ` Last published <time datetime="${escapeHtml(ref.modified)}">${escapeHtml(timeFormat.format(new Date(ref.modified)))}</time>.` : ''}</p>`)
    .replace(/<!-- digests:start -->[\s\S]*?<!-- digests:end -->/, () => `<!-- digests:start -->${renderFeed(day.stories, { origin, images: day.images, count: 0 })}<!-- digests:end -->`);
}
