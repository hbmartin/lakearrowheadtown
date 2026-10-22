import MarkdownIt from 'markdown-it';
import type { AlertView } from './alerts';
import { escapeHtml } from './html';
import { TIME_ZONE } from './feed';

const markdown = new MarkdownIt({ html: false, linkify: false }).disable('image');
const dateFormat = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const time = (value: string) => `<time datetime="${escapeHtml(value)}">${escapeHtml(dateFormat.format(new Date(value)))}</time>`;
const sourceNames = { caltrans: 'Caltrans', nws: 'National Weather Service', sce: 'Southern California Edison' };
const kindNames = { closure: 'Closure', 'chain-control': 'Chain controls', 'one-way': 'One-way traffic', construction: 'Construction', storm: 'Storm', hazard: 'Hazard', outage: 'Power off', 'planned-outage': 'Planned outage', psps: 'PSPS' };
const stageNames = { watch: 'Watch', warning: 'Warning', scheduled: 'Scheduled', 'in-effect': 'Power off' };

function renderAlert(alert: AlertView): string {
  const location = [alert.routes?.join(', '), alert.area].filter(Boolean).join(' · ');
  const status = [alert.upcoming ? 'Upcoming' : '', kindNames[alert.kind], alert.chain_level ?? '',
    alert.category === 'power' && alert.kind !== 'outage' ? stageNames[alert.power!.stage] : ''].filter(Boolean).join(' · ');
  const count = alert.power?.customer_count;
  return `<details class="alert-row">
    <summary><span class="alert-summary"><span class="alert-location">${escapeHtml(location)}</span><span class="alert-headline">${escapeHtml(alert.headline)}</span><span class="alert-status">${escapeHtml(status)}</span></span></summary>
    <div class="alert-details">
      ${alert.detail ? `<div class="markdown">${markdown.render(alert.detail)}</div>` : ''}
      <dl class="alert-facts">
        <div><dt>Last reported</dt><dd>${time(alert.observed_at)}</dd></div>
        ${alert.starts_at ? `<div><dt>Starts</dt><dd>${time(alert.starts_at)}</dd></div>` : ''}
        ${alert.expected_end ? `<div><dt>${alert.category === 'power' ? 'Estimated restoration / end' : 'Expected end'}</dt><dd>${time(alert.expected_end)}</dd></div>` : ''}
        ${count === undefined ? '' : `<div><dt>${alert.power!.stage === 'in-effect' ? 'Customers affected' : 'Customers potentially affected'}</dt><dd>${count.toLocaleString('en-US')}</dd></div>`}
        ${alert.source_event_id ? `<div><dt>Source reference</dt><dd>${escapeHtml(alert.source_event_id)}</dd></div>` : ''}
      </dl>
      <p class="alert-source"><a href="${escapeHtml(alert.source_url)}" rel="noopener noreferrer">${sourceNames[alert.source]}</a></p>
    </div>
  </details>`;
}

export function renderAlertBanner(alerts: AlertView[]): string {
  const groups = (['traffic', 'power'] as const).map(category => {
    const selected = alerts.filter(alert => alert.category === category && alert.state === 'open')
      .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at) || a.alert_id.localeCompare(b.alert_id));
    return selected.length ? `<section class="alert-group" aria-labelledby="${category}-alerts"><h2 id="${category}-alerts">${category === 'traffic' ? 'Traffic' : 'Power'}</h2>${selected.map(renderAlert).join('\n')}</section>` : '';
  }).join('');
  return groups ? `<aside class="alerts-banner" aria-label="Local alerts">${groups}</aside>` : '';
}
