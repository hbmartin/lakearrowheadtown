import { currentAlertViews } from './alerts';
import { renderAlertBanner } from './alert-banner';
import { renderPage } from './render';
import { indexCondition, PublicationConflict } from './publication-conflict';
import { validateWeather, WEATHER_KEY, weatherTime, renderWeather } from './weather';
import type { ContentBucket } from './types';

const marker = /<!-- conditions:start -->[\s\S]*?<!-- conditions:end -->/;

export async function renderConditions(bucket: ContentBucket, now = new Date()): Promise<string> {
  const [alerts, object] = await Promise.all([currentAlertViews(bucket, now), bucket.get(WEATHER_KEY)]);
  const banner = renderAlertBanner(alerts);
  const weather = object ? renderWeather(validateWeather(JSON.parse(await object.text()))) : null;
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

export function replaceConditions(html: string, conditions: string): string {
  const block = `<!-- conditions:start -->${conditions}<!-- conditions:end -->`;
  if (marker.test(html)) return html.replace(marker, () => block);
  // Existing news pages acquire the slot without touching their saved feed.
  if (!html.includes('<!-- digests:start -->')) throw new Error('Homepage conditions marker is missing');
  return html.replace('<!-- digests:start -->', () => `${block}\n<!-- digests:start -->`);
}

/** A derived homepage write: all committed news references and dates survive. */
export async function composeHomepageConditions(bucket: R2Bucket, origin: string): Promise<void> {
  const index = await bucket.get('pages/index.html');
  const base = index ? await index.text() : renderPage([], { origin });
  const body = replaceConditions(base, await renderConditions(bucket));
  if (body === base) return;
  const result = await bucket.put('pages/index.html', body, {
    onlyIf: indexCondition(index), customMetadata: index?.customMetadata,
    httpMetadata: { ...index?.httpMetadata, contentType: 'text/html; charset=utf-8', cacheControl: 'public, max-age=0, must-revalidate' },
  });
  if (!result) throw new PublicationConflict();
}
