import { dateLabel } from './dates';
import { addDays, eventDates, type EventsResult, type EventItem, type ReadEvent } from './events';
import { localDate, TIME_ZONE } from './feed';
import { escapeHtml } from './html';
import type { ImageMetadataMap } from './image-metadata';
import { renderBody, renderContentPage } from './render';

const timeFormat = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const fullTimeFormat = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

function eventTime(item: EventItem): string {
  const dates = eventDates(item);
  if (item.all_day) return `All day${dates.first !== dates.last ? ` · ${escapeHtml(dateLabel(dates.first))} – ${escapeHtml(dateLabel(dates.last))}` : ''}`;
  const time = (value: string, full: boolean) => `<time datetime="${escapeHtml(value)}" title="${escapeHtml(fullTimeFormat.format(new Date(value)))}">${escapeHtml((full ? fullTimeFormat : timeFormat).format(new Date(value)))}</time>`;
  const multiDay = dates.first !== dates.last;
  return time(item.starts_at, multiDay) + (item.ends_at ? ` – ${time(item.ends_at, multiDay)}` : '');
}

export function renderCalendarPage(origin: string, result: EventsResult, images: ImageMetadataMap = {}): string {
  const first = localDate(new Date(result.as_of));
  const last = addDays(first, result.days - 1);
  const days = new Map<string, ReadEvent[]>();
  for (const item of result.events) {
    const start = eventDates(item).first;
    const date = start < first ? first : start;
    if (!days.has(date)) days.set(date, []);
    days.get(date)!.push(item);
  }
  const context = { origin, images, counter: { value: 0 } };
  const content = [...days].map(([date, items]) => `<section class="digest" aria-labelledby="events-${date}">
    <header class="digest-header"><h3 id="events-${date}"><time datetime="${date}">${escapeHtml(dateLabel(date))}</time></h3></header>
    ${items.map(item => `<article class="digest-item">
      <div class="item-meta event-when">${eventDates(item).first < first ? '<span>Continues</span>' : ''}<span>${eventTime(item)}</span>${item.category ? `<span class="category">${escapeHtml(item.category)}</span>` : ''}</div>
      <h4><a class="headline-link" href="${escapeHtml(item.post_url)}" rel="noopener noreferrer">${escapeHtml(item.headline)}</a></h4>
      ${item.location ? `<p class="event-location">${escapeHtml(item.location)}</p>` : ''}
      <div class="markdown">${renderBody(item, context)}</div>
      <p class="item-meta event-source"><a href="${escapeHtml(item.group_url)}" rel="noopener noreferrer">${escapeHtml(item.group)}</a></p>
    </article>`).join('\n')}
  </section>`).join('\n') || '<p class="empty-state">No events in the next 30 days. Check back for events from around the mountain.</p>';
  const body = `<p class="calendar-intro">${escapeHtml(dateLabel(first))} through ${escapeHtml(dateLabel(last))}. All times are local to Lake Arrowhead (Pacific Time).</p>${content}`;
  return renderContentPage(origin, { path: '/calendar/', type: 'CollectionPage', title: 'Lake Arrowhead events calendar | Lake Arrowhead . Town',
    description: 'Community events in Lake Arrowhead, California for the next 30 days.' }, 'Community calendar', body,
  { className: 'calendar-page', items: result.events, publishedAt: result.published_at })
    .replace('</body>', () => `<script id="calendar-window">
    (() => {
      const date = ${JSON.stringify(first)};
      const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
      function refresh() {
        if (document.visibilityState === 'hidden') return;
        const parts = formatter.formatToParts(new Date());
        const part = name => parts.find(value => value.type === name).value;
        const today = part('year') + '-' + part('month') + '-' + part('day');
        if (today <= date) return;
        try {
          const key = 'lakearrowhead-calendar-refresh'; const marker = date + ':' + today;
          if (sessionStorage.getItem(key) === marker) return;
          sessionStorage.setItem(key, marker);
        } catch { return; }
        location.reload();
      }
      setInterval(refresh, 60000);
      document.addEventListener('visibilitychange', refresh);
      refresh();
    })();
  </script></body>`);
}
