import type { Publication, StoredItem, StoredPost } from './types';

export const TIME_ZONE = 'America/Los_Angeles';
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

export function localDate(now: Date): string {
  const parts = dateFormat.formatToParts(now);
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// Calendar arithmetic uses date labels, avoiding 23/25-hour days around DST.
export function recentDates(now: Date, count = 7): string[] {
  const today = new Date(`${localDate(now)}T12:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(today);
    day.setUTCDate(day.getUTCDate() - i);
    return day.toISOString().slice(0, 10);
  });
}

export function lastReceivedAt(post: StoredPost, item: StoredItem): string {
  return (item.updates ?? []).reduce((latest, update) => Date.parse(update.received_at) > Date.parse(latest) ? update.received_at : latest, post.received_at);
}

export function latestActivity(item: StoredItem, dates?: string[]): string | undefined {
  return [item.posted_at, ...(item.updates ?? []).map(update => update.posted_at)]
    .filter(time => !dates || dates.includes(localDate(new Date(time))))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

export function orderedUpdates(item: StoredItem) {
  return [...(item.updates ?? [])].sort((a, b) => Date.parse(a.posted_at) - Date.parse(b.posted_at));
}

export function snapshotDates(publication?: Publication): string[] {
  return publication?.snapshot_date ? recentDates(new Date(`${publication.snapshot_date}T12:00:00Z`)) : [];
}

export function selectFeedItems(posts: StoredPost[], publication?: Publication) {
  const dates = snapshotDates(publication);
  const history = publication?.snapshot_date ? recentDates(new Date(`${publication.snapshot_date}T12:00:00Z`), 30) : [];
  const items = posts.flatMap(post => post.items.flatMap((item, itemIndex) => {
    if (publication?.version === 2 && history.length && !history.includes(localDate(new Date(lastReceivedAt(post, item))))) return [];
    const activity = latestActivity(item, dates.length ? dates : undefined);
    return activity ? [{ item, postId: post.id, itemIndex, activity,
      date: localDate(new Date(activity)), timestamp: Date.parse(activity) }] : [];
  }));
  // Stable sorting preserves source and item order for equal instants, including duplicates.
  return items.sort((a, b) => b.timestamp - a.timestamp);
}
