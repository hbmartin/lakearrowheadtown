import type { Publication, StoredPost } from './types';

export const TIME_ZONE = 'America/Los_Angeles';
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

function localDate(now: Date): string {
  const parts = dateFormat.formatToParts(now);
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
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

export function snapshotDates(publication?: Publication): string[] {
  return publication?.snapshot_date ? recentDates(new Date(`${publication.snapshot_date}T12:00:00Z`)) : [];
}

export function selectFeedItems(posts: StoredPost[], publication?: Publication) {
  const dates = snapshotDates(publication);
  const items = posts.flatMap(post => post.items.map((item, itemIndex) => ({
    item, postId: post.id, itemIndex,
    date: localDate(new Date(item.posted_at)), timestamp: Date.parse(item.posted_at),
  }))).filter(({ date }) => !dates.length || dates.includes(date));
  // Stable sorting preserves source and item order for equal instants, including duplicates.
  return items.sort((a, b) => b.timestamp - a.timestamp);
}
