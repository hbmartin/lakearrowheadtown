import { localDate as dateAt } from './feed';
import { escapeHtml } from './html';
import { isDate, isTimestamp } from './validation';
import { record } from './primitives';

export const WEATHER_KEY = 'weather/town-card.json';
export const WEATHER_URL = 'https://raw.githubusercontent.com/hbmartin/open-sun/data/town-card.json';
export interface WeatherBand { coverage: number; low_f: number; high_f: number }
export interface WeatherHour { valid_time: string; temp_f: number | null; pop: number | null; bands: WeatherBand[] }
export interface TownWeather {
  schema_version: 1; published_at: string; timezone: 'America/Los_Angeles';
  station: { id: 'lake-arrowhead'; label: string; latitude: number; longitude: number };
  units: { temperature: 'F'; wind: 'mph'; rain: 'in'; probability: 'fraction' };
  observation: { observed_at: string; temp_f: number | null; wind_mph: number | null; gust_mph: number | null; rain_total_in: number | null; rain_date: string } | null;
  forecast: { issued_at: string; date_local: string; high_f: number | null; low_f: number | null; outlook: string | null; hours: WeatherHour[] } | null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nullable = (v: unknown, min = -150, max = 150): boolean => v === null || finite(v) && v >= min && v <= max;
const string = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const localDate = (at: string) => dateAt(new Date(at));

/** Validate at both the upstream boundary and the stored-document boundary. */
export function validateWeather(value: unknown): TownWeather {
  const bad = () => { throw new Error('Invalid Open Sun town-card document'); };
  if (!record(value) || value.schema_version !== 1 || !isTimestamp(value.published_at) || value.timezone !== 'America/Los_Angeles') return bad();
  const { station, units, observation: o, forecast: f } = value;
  if (!record(station) || station.id !== 'lake-arrowhead' || !string(station.label, 100)
    || !finite(station.latitude) || Math.abs(station.latitude - 34.2768) > .001
    || !finite(station.longitude) || Math.abs(station.longitude + 117.1692) > .001) return bad();
  if (!record(units) || units.temperature !== 'F' || units.wind !== 'mph' || units.rain !== 'in' || units.probability !== 'fraction') return bad();
  if (o !== null && (!record(o) || !isTimestamp(o.observed_at) || typeof o.rain_date !== 'string' || !isDate(o.rain_date) || o.rain_date !== localDate(o.observed_at)
    || !nullable(o.temp_f) || !nullable(o.wind_mph, 0, 300) || !nullable(o.gust_mph, 0, 300) || !nullable(o.rain_total_in, 0, 1000))) return bad();
  if (f !== null) {
    if (!record(f) || !isTimestamp(f.issued_at) || typeof f.date_local !== 'string' || !isDate(f.date_local) || f.date_local !== localDate(value.published_at) || !nullable(f.high_f) || !nullable(f.low_f)
      || finite(f.high_f) && finite(f.low_f) && f.high_f < f.low_f
      || !(f.outlook === null || string(f.outlook, 300)) || !Array.isArray(f.hours) || f.hours.length !== 24) return bad();
    let previous = 0;
    for (const h of f.hours) {
      if (!record(h) || !isTimestamp(h.valid_time) || !nullable(h.temp_f) || !nullable(h.pop, 0, 1) || !Array.isArray(h.bands)
        || ![0, 3].includes(h.bands.length)) return bad();
      const at = Date.parse(h.valid_time);
      if (at % 3_600_000 !== 0 || previous && at !== previous + 3_600_000) return bad();
      previous = at;
      let outer: WeatherBand | undefined;
      for (const [i, b] of h.bands.entries()) {
        if (!record(b) || b.coverage !== [.9, .6, .3][i] || !finite(b.low_f) || !finite(b.high_f)
          || b.low_f < -150 || b.high_f > 150 || b.low_f > b.high_f
          || outer && (b.low_f < outer.low_f || b.high_f > outer.high_f)) return bad();
        outer = b as unknown as WeatherBand;
      }
      if (h.temp_f === null && h.bands.length) return bad();
    }
  }
  if (o === null && f === null) return bad();
  const published = Date.parse(value.published_at);
  if (o && Date.parse((o as Record<string, unknown>).observed_at as string) > published + 300_000
    || f && Date.parse((f as Record<string, unknown>).issued_at as string) > published + 300_000) return bad();
  return value as unknown as TownWeather;
}

const dateTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const hourTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', timeZoneName: 'short' });
const dayTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' });
export const weatherTime = (at: string) => `<time datetime="${escapeHtml(at)}">${escapeHtml(dateTime.format(new Date(at)))}</time>`;
const temp = (n: number | null) => n === null ? '—' : `${Math.round(n)}°F`;
const metric = (label: string, value: string) => `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;

function runs(hours: WeatherHour[], usable: (h: WeatherHour) => boolean): number[][] {
  const all: number[][] = []; let run: number[] = [];
  hours.forEach((h, i) => { if (usable(h)) run.push(i); else if (run.length) { all.push(run); run = []; } });
  if (run.length) all.push(run);
  return all;
}

export function renderWeatherChart(hours: WeatherHour[]): string {
  const values = hours.flatMap(h => h.temp_f === null ? [] : [h.temp_f, ...h.bands.flatMap(b => [b.low_f, b.high_f])]);
  if (!values.length) return '<p>Hourly temperature forecast unavailable.</p>';
  const low = Math.floor((Math.min(...values) - 3) / 5) * 5;
  const high = Math.ceil((Math.max(...values) + 3) / 5) * 5;
  const x = (i: number) => 60 + i * 39;
  const y = (v: number) => 185 - (v - low) / (high - low) * 145;
  const point = (i: number, v: number) => `${x(i)},${y(v).toFixed(2)}`;
  const bands = runs(hours, h => h.temp_f !== null && h.bands.length === 3).map(run => [0, 1, 2].map(b => {
    if (run.length === 1) {
      const i = run[0], band = hours[i].bands[b];
      return `<line class="weather-band-${b}" x1="${x(i)}" x2="${x(i)}" y1="${y(band.low_f)}" y2="${y(band.high_f)}" stroke-width="8"/>`;
    }
    return `<path class="weather-band-${b}" d="M${run.map(i => point(i, hours[i].bands[b].high_f)).join(' L')} L${[...run].reverse().map(i => point(i, hours[i].bands[b].low_f)).join(' L')} Z"/>`;
  }).join('')).join('');
  const lines = runs(hours, h => h.temp_f !== null).map(run => `<polyline class="weather-line" points="${run.map(i => point(i, hours[i].temp_f!)).join(' ')}"/>`).join('');
  const grid = [low, (high + low) / 2, high].map(v => `<line class="weather-grid" x1="42" x2="980" y1="${y(v)}" y2="${y(v)}"/><text x="35" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}°</text>`).join('');
  const details = hours.map((h, i) => {
    const label = `${dateTime.format(new Date(h.valid_time))}: ${temp(h.temp_f)}, rain ${h.pop === null ? 'unavailable' : `${Math.round(h.pop * 100)}%`}${h.bands.length ? `; likely ${temp(h.bands[1].low_f)} to ${temp(h.bands[1].high_f)} (60% interval)` : ''}`;
    const dateChange = i === 0 || localDate(h.valid_time) !== localDate(hours[i - 1].valid_time);
    const nearBoundary = hours.some((hour, j) => j !== i && Math.abs(j - i) < 2 && (j === 0 || localDate(hour.valid_time) !== localDate(hours[j - 1].valid_time)));
    const tick = dateChange || i % 3 === 0 && !nearBoundary;
    return `${dateChange ? `<line class="weather-grid" x1="${x(i)}" x2="${x(i)}" y1="10" y2="250"/><text x="${x(i)}" y="22" text-anchor="middle">${escapeHtml(dayTime.format(new Date(h.valid_time)))}</text>` : ''}
      ${tick ? `<text x="${x(i)}" y="215" text-anchor="middle">${escapeHtml(hourTime.format(new Date(h.valid_time)))}</text>` : ''}
      ${h.temp_f === null ? '' : `<circle class="weather-point" cx="${x(i)}" cy="${y(h.temp_f)}" r="3.5"><title>${escapeHtml(label)}</title></circle>`}
      <text class="weather-rain" x="${x(i)}" y="244" text-anchor="middle"><title>${escapeHtml(label)}</title>${h.pop === null ? '—' : `${Math.round(h.pop * 100)}%`}</text>`;
  }).join('');
  return `<figure class="weather-chart"><figcaption>24-hour forecast · temperature and hourly rain chance</figcaption>
    <div class="weather-chart-scroll" tabindex="0" role="group" aria-label="24-hour forecast, scroll horizontally for later hours"><svg viewBox="0 0 1000 264" role="img" aria-labelledby="weather-chart-title weather-chart-description">
    <title id="weather-chart-title">24-hour temperature forecast</title><desc id="weather-chart-description">Shaded intervals show 90, 60 and 30 percent of the forecast distribution, from lightest to darkest. Hourly values follow in the accessible details.</desc>${grid}${bands}${lines}${details}</svg></div>
    <p class="weather-band-key">Lighter to darker shading: 90%, 60%, and 30% forecast intervals. Gaps indicate unavailable data.</p>
    <details class="weather-hourly-text"><summary>Hourly values and likely ranges</summary><ul>${hours.map(h => `<li>${weatherTime(h.valid_time)}: ${temp(h.temp_f)}${h.bands.length ? `; likely ${temp(h.bands[1].low_f)}–${temp(h.bands[1].high_f)} (60%)` : ''}; rain chance ${h.pop === null ? 'unavailable' : `${Math.round(h.pop * 100)}%`}.</li>`).join('')}</ul></details></figure>`;
}

export function renderWeather(weather: TownWeather): { summary: string; details: string } {
  const { observation: o, forecast: f } = weather;
  return {
    summary: `<div class="weather-card"><h2>Today on the mountain</h2><p class="weather-station">${escapeHtml(weather.station.label)} · ${escapeHtml(f?.date_local ?? (o ? localDate(o.observed_at) : ''))}</p>
      <p class="weather-temperature">${temp(o?.temp_f ?? null)}</p>${f ? `<p class="weather-high-low">Forecast high ${temp(f.high_f)} · low ${temp(f.low_f)}</p>` : ''}
      ${f?.outlook ? `<p class="weather-outlook">${escapeHtml(f.outlook)}</p>` : ''}<p class="weather-time">${o ? `Observed ${weatherTime(o.observed_at)}` : 'Station observation unavailable.'}</p>
      <button class="weather-toggle" type="button" aria-expanded="false" aria-controls="weather-details">Show weather details <span aria-hidden="true">↓</span></button></div>`,
    details: `<section id="weather-details" class="weather-details weather-card" aria-label="Mountain weather details"><h3>Mountain weather details</h3>
      <dl class="weather-metrics">${metric('Observed temperature', temp(o?.temp_f ?? null))}${metric('Wind', o?.wind_mph == null ? '—' : `${Math.round(o.wind_mph)} mph`)}${metric('Gusts', o?.gust_mph == null ? '—' : `${Math.round(o.gust_mph)} mph`)}
      ${metric(o ? `Rain on ${o.rain_date}` : 'Observed rainfall', o?.rain_total_in == null ? '—' : `${o.rain_total_in.toFixed(2)} in`)}${metric('Forecast high / low', f ? `${temp(f.high_f)} / ${temp(f.low_f)}` : '—')}</dl>
      ${f ? `<p class="weather-time">Forecast issued ${weatherTime(f.issued_at)}. All times Pacific.</p>${renderWeatherChart(f.hours)}` : '<p>Forecast unavailable.</p>'}
      <p class="weather-full-link"><a href="https://weather.lakearrowhead.town">Full forecast on Open Sun <span aria-hidden="true">↗</span></a></p></section>`,
  };
}
