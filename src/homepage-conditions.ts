import { boundary, HttpError } from './errors';
import { emit, safeError } from './diagnostics';
import { currentAlertViews } from './alerts';
import { renderAlertBanner } from './alert-banner';
import { renderPage } from './render';
import { indexCondition, PublicationConflict } from './publication-conflict';
import { validateWeather, WEATHER_KEY, weatherTime, renderWeather } from './weather';
import type { ContentBucket, OperationContext } from './types';

const marker = /<!-- conditions:start -->[\s\S]*?<!-- conditions:end -->/;

export async function renderConditions(bucket: ContentBucket, now = new Date()): Promise<string> {
  const [alerts, object] = await Promise.all([currentAlertViews(bucket, now), boundary('storage', () => bucket.get(WEATHER_KEY))]);
  const banner = renderAlertBanner(alerts);
  const body = object ? await boundary('storage', () => object.text()) : null;
  let weather;
  try { weather = body ? renderWeather(validateWeather(JSON.parse(body))) : null; }
  catch { throw new HttpError(500, 'Stored weather is damaged.', {}, { code: 'weather_damaged' }); }
  if (!banner && !weather) return '';
  return `<section class="homepage-conditions${banner ? ' has-alerts' : ''}${weather ? ' has-weather' : ''}" aria-label="Mountain conditions snapshot">
    <p class="conditions-as-of">Conditions snapshot: ${weatherTime(now.toISOString())}</p><div class="conditions-row">${banner}${weather?.summary ?? ''}</div>${weather?.details ?? ''}
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

export async function conditionsSnapshot(bucket: ContentBucket, context?: OperationContext, now = new Date()): Promise<{ html: string; available: boolean }> {
  try { return { html: await renderConditions(bucket, now), available: true }; }
  catch (error) {
    emit('conditions_unavailable', context, { ...safeError(error), error_code: error instanceof HttpError ? error.code : 'conditions_read_failed' }, 'error');
    return { html: '<section class="homepage-conditions conditions-unavailable" role="status" aria-label="Mountain conditions"><p>Mountain conditions are temporarily unavailable.</p></section>', available: false };
  }
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
  const body = replaceConditions(base, snapshot.html);
  if (body === base) return snapshot.available;
  const metadata: Record<string, string> = { ...index?.customMetadata, ...(!index ? { conditions_only: 'true' } : {}) };
  if (snapshot.available) delete metadata.conditions_status; else metadata.conditions_status = 'unavailable';
  const result = await bucket.put('pages/index.html', body, {
    onlyIf: indexCondition(index), customMetadata: metadata,
    httpMetadata: { ...index?.httpMetadata, contentType: 'text/html; charset=utf-8', cacheControl: 'public, max-age=0, must-revalidate' },
  });
  if (!result) throw new PublicationConflict();
  return snapshot.available;
}
