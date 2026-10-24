import { expect, it } from 'vitest';
import fixture from '../fixtures/town-card.json';
import { validateWeather, renderWeather, renderWeatherChart } from '../../src/weather';
it.each([
  (d: any) => { d.observation = null; d.forecast = null; },
  (d: any) => { d.forecast.outlook = 42; },
  (d: any) => { d.forecast.high_f = -20; d.forecast.low_f = 40; },
  (d: any) => { d.observation.observed_at = new Date(Date.parse(d.published_at) + 300001).toISOString(); },
  (d: any) => { d.forecast.issued_at = new Date(Date.parse(d.published_at) + 300001).toISOString(); },
  (d: any) => { d.forecast.hours[0].temp_f = null; },
  (d: any) => { d.forecast.hours[1].valid_time = d.forecast.hours[0].valid_time; },
])('rejects internally inconsistent producer data', mutate => {
  const d = structuredClone(fixture.expected); mutate(d); expect(() => validateWeather(d)).toThrow();
});
it('renders observation-only and forecast-only cards without inventing values', () => {
  const d: any = structuredClone(fixture.expected); d.observation = null;
  expect(renderWeather(validateWeather(d)).summary).toContain('Station observation unavailable');
  d.observation = structuredClone(fixture.expected.observation); d.forecast = null;
  d.observation.temp_f = null; d.observation.wind_mph = null; d.observation.gust_mph = null; d.observation.rain_total_in = null;
  const result = renderWeather(validateWeather(d)); expect(result.details).toContain('Forecast unavailable'); expect(result.details).toContain('—');
});
it('draws isolated confidence bands and explicitly handles an empty forecast', () => {
  const hours = structuredClone(fixture.expected.forecast!.hours);
  expect(renderWeatherChart(hours.map(h => ({ ...h, temp_f: null, pop: null, bands: [] })))).toContain('Hourly temperature forecast unavailable');
  const isolated = hours.map((h, i) => i === 3 ? h : { ...h, temp_f: null, bands: [] });
  expect(renderWeatherChart(isolated)).toContain('stroke-width="8"');
});
