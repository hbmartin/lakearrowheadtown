import type { DigestItem, PublicationWarning } from './types';

export const CATEGORY_VOCABULARY_VERSION = 1;
export const CATEGORY_VOCABULARY = ['alert', 'announcement', 'discussion', 'event', 'traffic', 'weather'] as const;
export const POSTED_AT_FUTURE_GRACE_MS = 15 * 60 * 1000;
export const POSTED_AT_STALE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const categories = new Set<string>(CATEGORY_VOCABULARY);

// Inputs have already passed timestamp validation; these checks are advisory only.
export function postedAtWarnings(value: string, now: Date, field = 'posted_at'): PublicationWarning[] {
  const age = now.getTime() - Date.parse(value);
  if (age < -POSTED_AT_FUTURE_GRACE_MS) {
    return [{ field, code: 'posted_at_in_future', message: 'posted_at is more than 15 minutes ahead of server time; check the source timestamp and timezone.', value, server_time: now.toISOString() }];
  }
  if (age > POSTED_AT_STALE_AGE_MS) {
    return [{ field, code: 'posted_at_stale', message: 'posted_at is more than 30 elapsed days old; check the source timestamp or confirm the intended backfill.', value, server_time: now.toISOString() }];
  }
  return [];
}

export function digestItemWarnings(item: DigestItem, index: number, now: Date): PublicationWarning[] {
  const warnings: PublicationWarning[] = [];
  if (item.category !== '' && !categories.has(item.category)) {
    warnings.push({ index, field: `items[${index}].category`, code: 'unknown_category',
      message: `Category '${item.category}' is not in category vocabulary v${CATEGORY_VOCABULARY_VERSION} (${CATEGORY_VOCABULARY.join(', ')}). Accepted as submitted.`, value: item.category });
  }
  warnings.push(...postedAtWarnings(item.posted_at, now, `items[${index}].posted_at`).map(warning => ({ ...warning, index })));
  return warnings;
}
