import { boundary, HttpError } from './errors';
import { emit, safeError } from './diagnostics';
import { currentAlertViews } from './alerts';
import { renderAlertBanner } from './alert-banner';
import { renderPage } from './render';
import { indexCondition, PublicationConflict } from './publication-conflict';
import { validateWeather, WEATHER_KEY, weatherTime, renderWeather } from './weather';
import { NEWS_ANCHOR, validateIndexMetadata } from './index-metadata';
import type { ContentBucket, OperationContext } from './types';

const marker = /<!-- conditions:start -->[\s\S]*?<!-- conditions:end -->/;

async function loadWeather(bucket: ContentBucket): Promise<ReturnType<typeof renderWeather> | null> {
  const object = await boundary('storage', () => bucket.get(WEATHER_KEY));
  const body = object ? await boundary('storage', () => object.text()) : null;
  try { return body === null ? null : renderWeather(validateWeather(JSON.parse(body))); }
  catch { throw new HttpError(500, 'Stored weather is damaged.', {}, { code: 'weather_damaged' }); }
}

function conditionsHtml(banner: string, weather: ReturnType<typeof renderWeather> | null, now: Date, notice = ''): string {
  if (!banner && !weather && !notice) return '';
  return `<section class="homepage-conditions${banner ? ' has-alerts' : ''}${weather ? ' has-weather' : ''}" aria-label="Mountain conditions snapshot">
    <p class="conditions-as-of">Conditions snapshot: ${weatherTime(now.toISOString())}</p>${notice}${banner || weather ? `<div class="conditions-row">${banner}${weather?.summary ?? ''}</div>` : ''}${weather?.details ?? ''}
    </section>${weather ? `<script id="weather-interaction">
    (() => {
      const root = document.querySelector('.homepage-conditions');
      const button = root?.querySelector('.weather-toggle');
      if (!button) return;
      root.classList.add('weather-interactive');
      button.closest('.weather-card').addEventListener('click', () => {
        if (!root.classList.contains('has-alerts') && window.matchMedia('(min-width: 960px)').matches) return;
        const expanded = button.getAttribute('aria-expanded') !== 'true';
        button.setAttribute('aria-expanded', String(expanded));
        button.innerHTML = expanded ? 'Hide weather details <span aria-hidden="true">↑</span>' : 'Show weather details <span aria-hidden="true">↓</span>';
        root.classList.toggle('weather-expanded', expanded);
      });
    })();
    </script>` : ''}`;
}

export async function renderConditions(bucket: ContentBucket, now = new Date()): Promise<string> {
  return (await conditionsSnapshot(bucket, undefined, now)).html;
}

export async function conditionsSnapshot(bucket: ContentBucket, context?: OperationContext, now = new Date()): Promise<{ html: string; available: boolean }> {
  const [alerts, weather] = await Promise.allSettled([
    currentAlertViews(bucket, now).then(renderAlertBanner), loadWeather(bucket),
  ]);
  for (const [subsystem, result] of [['alerts', alerts], ['weather', weather]] as const) if (result.status === 'rejected') {
    emit('conditions_unavailable', context, { subsystem, ...safeError(result.reason), error_code: result.reason instanceof HttpError ? result.reason.code : 'conditions_read_failed' }, 'error');
  }
  const failedAlerts = alerts.status === 'rejected'; const failedWeather = weather.status === 'rejected';
  const notice = failedAlerts && failedWeather ? 'Mountain conditions are temporarily unavailable.' : failedAlerts ? 'Road and power alerts are temporarily unavailable.' : failedWeather ? 'Weather is temporarily unavailable.' : '';
  return { html: conditionsHtml(alerts.status === 'fulfilled' ? alerts.value : '', weather.status === 'fulfilled' ? weather.value : null, now,
    notice ? `<div class="conditions-unavailable" role="status"><p>${notice}</p></div>` : ''), available: !failedAlerts && !failedWeather };
}

export function replaceConditions(html: string, conditions: string): string {
  const block = `<!-- conditions:start -->${conditions}<!-- conditions:end -->`;
  if (marker.test(html)) return html.replace(marker, () => block);
  // Existing news pages acquire the slot without touching their saved feed.
  if (!html.includes('<!-- digests:start -->')) throw new Error('Homepage conditions marker is missing');
  return html.replace('<!-- digests:start -->', () => `${block}\n<!-- digests:start -->`);
}

/** A derived homepage write: all committed news references and dates survive. */
export async function composeHomepageConditions(bucket: R2Bucket, origin: string, context?: OperationContext): Promise<boolean> {
  const index = await boundary('storage', () => bucket.get('pages/index.html'));
  const base = index ? await boundary('storage', () => index.text()) : renderPage([], { origin });
  const snapshot = await conditionsSnapshot(bucket, context);
  const rendered = replaceConditions(base, snapshot.html);
  const previous = marker.exec(base)?.[0];
  const proposed = marker.exec(rendered)![0];
  // Ignore only our generated snapshot clock, never observation/expiry times.
  const content = (block: string) => block.replace(/<p class="conditions-as-of">[\s\S]*?<\/p>/, '');
  const body = previous && content(previous) === content(proposed) ? base : rendered;
  const metadata: Record<string, string> = { ...index?.customMetadata, ...(!index ? { conditions_only: 'true' } : {}) };
  if (index && !metadata.manifest && metadata.conditions_only !== 'true') {
    metadata[NEWS_ANCHOR] ??= index.uploaded.toISOString();
    newsAnchor(metadata[NEWS_ANCHOR]);
  }
  if (snapshot.available) delete metadata.conditions_status; else metadata.conditions_status = 'unavailable';
  if (body === base && JSON.stringify(metadata) === JSON.stringify(index?.customMetadata ?? {})) return snapshot.available;
  validateIndexMetadata(metadata);
  const result = await bucket.put('pages/index.html', body, {
    onlyIf: indexCondition(index), customMetadata: metadata,
    httpMetadata: { ...index?.httpMetadata, contentType: 'text/html; charset=utf-8', cacheControl: 'public, max-age=0, must-revalidate' },
  });
  if (!result) throw new PublicationConflict();
  return snapshot.available;
}

export function newsAnchor(value: string): Date {
  const date = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new HttpError(503, 'The saved legacy news date is damaged. Restore its original publication anchor from a verified backup.', {}, { code: 'legacy_recovery_required' });
  }
  return date;
}
