import { NEVER, boolean, custom, object, string, unknown } from 'zod';
import { digestSubmissionSchema } from './content';
import { isDate, isTimestamp } from './primitives';
import { record } from '../primitives';
import type { EventDigest, EventItem } from '../events';

// Base-field errors precede all event-field errors in API v3.
export const eventSchema = unknown().transform((value, ctx): EventDigest => {
  const base = digestSubmissionSchema.safeParse(value);
  if (!base.success) for (const issue of base.error.issues) ctx.addIssue({ ...issue });
  const inputs = record(value) && Array.isArray(value.items) ? value.items : [];
  const items: EventItem[] = [];
  for (const [index, raw] of inputs.entries()) {
    if (!record(raw)) continue;
    const allDay = raw.all_day === true;
    const validTime = (v: unknown): v is string => allDay ? typeof v === 'string' && isDate(v) : isTimestamp(v);
    const time = custom<string>(validTime, {
      error: allDay ? 'Expected a real YYYY-MM-DD date for an all-day event.' : 'Expected an ISO timestamp with an explicit timezone for a timed event.',
      params: { api_code: 'invalid_timestamp' },
    });
    const extension = object({
      all_day: boolean({ error: 'Expected a boolean.' }).optional(),
      starts_at: time,
      ends_at: time.refine(end => !validTime(raw.starts_at) || Date.parse(end) > Date.parse(raw.starts_at), {
        error: 'ends_at must be later than starts_at; all-day end dates are exclusive.', params: { api_code: 'invalid_range' },
        when: payload => validTime(payload.value),
      }).optional(),
      location: string({ error: 'Expected a string.' }).optional(),
    }).safeParse(raw);
    if (!extension.success) for (const issue of extension.error.issues) ctx.addIssue({ ...issue, path: ['items', index, ...issue.path] });
    if (base.success && extension.success) items.push({ ...base.data.items[index], starts_at: extension.data.starts_at, all_day: allDay,
      ...(extension.data.ends_at === undefined ? {} : { ends_at: extension.data.ends_at }),
      ...(extension.data.location === undefined ? {} : { location: extension.data.location }) });
  }
  if (!base.success || ctx.issues.length) return NEVER;
  return { title: base.data.title, source: base.data.source, items };
});
