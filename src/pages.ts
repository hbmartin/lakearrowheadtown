import { fingerprint, canonicalJson } from './primitives';
import { localDate } from './feed';
import { archivePath, loadArchiveDay, loadCatalog } from './archives';
import { committedSnapshot } from './committed';
import { dateLabel } from './dates';
import { escapeHtml } from './html';
import { renderArchivePage, renderContentPage } from './render';
import { isDate } from './validation';
import { resourceResponse } from './public-metadata';
import { RESOURCE_PAGES } from './resources';
import { HTML_CACHE } from './publishing';
import { renderCalendarPage } from './calendar';
import { readEvents, currentEvents } from './events';
import { createImageResolver } from './image-metadata';
import type { ContentBucket } from './types';

const calendars = new WeakMap<ContentBucket, Map<string, Promise<string>>>();

export async function pageResource(request: Request, bucket: ContentBucket, origin: string): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === '/calendar' || path === '/calendar/') {
    const publication = await currentEvents(bucket); const now = new Date();
    const key = canonicalJson([fingerprint(canonicalJson(publication)), localDate(now), origin]);
    let cache = calendars.get(bucket); if (!cache) { cache = new Map(); calendars.set(bucket, cache); }
    let rendering = cache.get(key);
    if (!rendering) {
      rendering = (async () => { const events = await readEvents(bucket, new URLSearchParams(), now, publication); const images = await createImageResolver(bucket, origin)(events.events); return renderCalendarPage(origin, events, images); })();
      cache.set(key, rendering); if (cache.size > 16) cache.delete(cache.keys().next().value!);
      const pending = rendering; rendering.catch(() => { if (cache!.get(key) === pending) cache!.delete(key); });
    }
    return resourceResponse(request, { body: await rendering, type: 'text/html; charset=utf-8', cache: HTML_CACHE });
  }
  const resource = RESOURCE_PAGES.find(page => page.path === path);
  if (resource) return resourceResponse(request, {
    body: renderContentPage(origin, { path, title: `${resource.heading} | Lake Arrowhead . Town`, description: resource.description }, resource.heading, resource.body),
    type: 'text/html; charset=utf-8', cache: HTML_CACHE,
  });
  const match = /^\/(\d{4})\/(\d{2})\/(\d{2})\/$/.exec(path);
  if (path !== '/archive/' && !match) return;
  const date = match?.slice(1).join('-');
  if (date && !isDate(date)) return;
  // Keep private sources and uncommitted catalogues out of all public reads.
  const snapshot = await committedSnapshot(bucket);
  const catalog = await loadCatalog(bucket, await snapshot.archives());
  if (date) {
    const ref = catalog.days[date];
    if (!ref) return;
    const day = await loadArchiveDay(bucket, date, ref);
    const html = renderArchivePage(origin, day, ref);
    return resourceResponse(request, { body: html, type: 'text/html; charset=utf-8', cache: HTML_CACHE });
  }
  const dates = Object.keys(catalog.days).sort().reverse();
  const body = dates.length ? `<ul>${dates.map(date => `<li><a href="${archivePath(date)}">${escapeHtml(dateLabel(date))}</a></li>`).join('')}</ul>` : '<p>No news archives have been published yet.</p>';
  return resourceResponse(request, {
    body: renderContentPage(origin, { path, title: 'Lake Arrowhead news archive | Lake Arrowhead . Town', description: 'Browse daily community news archives from Lake Arrowhead, California.' }, 'News archive', body),
    type: 'text/html; charset=utf-8', cache: HTML_CACHE,
  });
}
