import MarkdownIt from 'markdown-it';
import template from '../index.html';
import type { DigestItem, Publication, StoredPost } from './types';

export const TIME_ZONE = 'America/Los_Angeles';
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
const dayFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const emptyContent = template.match(/<!-- digests:start -->([\s\S]*?)<!-- digests:end -->/)![1].trim();

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function renderItem(item: DigestItem): string {
  return `<article class="digest-item">
    <div class="item-meta"><a href="${escapeHtml(item.group_url)}" rel="noopener noreferrer">${escapeHtml(item.group)}</a>
      <time datetime="${escapeHtml(item.posted_at)}">${escapeHtml(timeFormat.format(new Date(item.posted_at)))}</time>
      ${item.category ? `<span class="category">${escapeHtml(item.category)}</span>` : ''}</div>
    <h3>${escapeHtml(item.headline)}</h3>
    <div class="markdown">${markdown.render(item.body)}</div>
    <a class="post-link" href="${escapeHtml(item.post_url)}" rel="noopener noreferrer">View original post <span aria-hidden="true">↗</span></a>
  </article>`;
}

export function renderDigest(digest: StoredPost): string {
  return `<section class="digest" aria-labelledby="post-${escapeHtml(digest.id)}">
    <header class="digest-header">
      <h2 id="post-${escapeHtml(digest.id)}"><time datetime="${escapeHtml(digest.received_at)}">${dayFormat.format(new Date(`${digest.date}T12:00:00Z`))}</time></h2>
      <p class="received-at">Received ${escapeHtml(timeFormat.format(new Date(digest.received_at)))}</p>
      <p class="digest-title">${escapeHtml(digest.title)}</p>
    </header>
    ${digest.items.length ? digest.items.map(renderItem).join('\n') : '<p class="empty-state">No updates in this digest.</p>'}
  </section>`;
}

export function renderPage(digests: StoredPost[], options: { origin: string; publication?: Publication }): string {
  const title = 'News from Lake Arrowhead . Town';
  const snapshot = options.publication;
  const dates = snapshot?.snapshot_date ? recentDates(new Date(`${snapshot.snapshot_date}T12:00:00Z`)) : [];
  const metadata = snapshot?.published_at && dates.length
    ? `<p class="snapshot-meta">Received ${escapeHtml(dayFormat.format(new Date(`${dates[6]}T12:00:00Z`)))} through ${escapeHtml(dayFormat.format(new Date(`${dates[0]}T12:00:00Z`)))}. Last published <time datetime="${escapeHtml(snapshot.published_at)}">${escapeHtml(timeFormat.format(new Date(snapshot.published_at)))}</time>.</p>` : '';
  const content = metadata + (digests.length ? digests.map(renderDigest).join('\n') : emptyContent);
  return template
    .replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(title)}</title>`)
    .replace('<!-- page-meta -->', () => `<link rel="canonical" href="${escapeHtml(options.origin + '/')}">\n  <meta property="og:title" content="${escapeHtml(title)}">`)
    .replace(/<!-- digests:start -->[\s\S]*?<!-- digests:end -->/, () => `<!-- digests:start -->\n${content}\n<!-- digests:end -->`);
}

// Calendar arithmetic uses date labels, avoiding 23/25-hour days around DST.
export function recentDates(now: Date): string[] {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  const today = new Date(`${part('year')}-${part('month')}-${part('day')}T12:00:00Z`);
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(today);
    day.setUTCDate(day.getUTCDate() - i);
    return day.toISOString().slice(0, 10);
  });
}
