import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/town-card.json';
import worker from '../src/worker';
import { validateWeather, renderWeatherChart, WEATHER_KEY, WEATHER_URL } from '../src/weather';
import { composeHomepageConditions, replaceConditions } from '../src/homepage-conditions';
import { renderPage } from '../src/render';
import { publishDigest } from '../src/publishing';
import type { Env, Digest } from '../src/types';

const bindings = env as unknown as Env;
const bucket = bindings.SITE_BUCKET;
const base = 'https://lakearrowhead.town';
const sample = () => structuredClone(fixture.expected);
const publisher = () => bindings.PUBLISHER.getByName('site');
const page = (init: RequestInit = {}, overrides: Partial<Env> = {}) => worker.fetch(new Request(base, init), { ...bindings, ...overrides });
const digest: Digest = { title: 'News', source: 'test', items: [{ group: 'Community', group_url: 'https://example.com/', post_url: 'https://example.com/news', headline: 'A saved story', body: 'News body', posted_at: fixture.expected.published_at, category: 'announcement' }] };

beforeEach(async () => { vi.restoreAllMocks(); await reset(); vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('Open Sun contract and chart', () => {
  it('accepts the shared producer fixture and rejects incompatible identity, units, times, and bands', () => {
    expect(validateWeather(sample()).schema_version).toBe(1);
    const mutations = [
      (d: any) => d.schema_version = 2, (d: any) => d.station.latitude = 40,
      (d: any) => d.units.probability = 'percent', (d: any) => d.forecast.hours[1].valid_time = d.forecast.hours[0].valid_time,
      (d: any) => d.forecast.hours[2].pop = 50, (d: any) => d.observation.rain_date = '2025-01-01',
      (d: any) => d.forecast.hours[2].bands[0].low_f = 200,
    ];
    for (const mutate of mutations) { const d = sample(); mutate(d); expect(() => validateWeather(d)).toThrow(); }
  });
  it('renders bands, percentage probabilities, explicit times and gaps without bridging missing temperatures', () => {
    const d = validateWeather(sample()); const hours = d.forecast!.hours;
    hours[8] = { ...hours[8], temp_f: null, bands: [], pop: null };
    const html = renderWeatherChart(hours);
    expect(html).toContain('weather-band-0'); expect(html).toContain('90%, 60%, and 30%');
    expect(html.match(/<polyline/g)).toHaveLength(2);
    expect(html).toContain(`${Math.round(hours[2].pop! * 100)}%`);
    expect(html).toContain('rain chance unavailable'); expect(html).not.toContain('NaN');
  });
  it('uses absolute hourly instants through a daylight-saving fall-back', () => {
    const d = sample(); d.published_at = '2026-11-01T07:00:00Z';
    d.forecast.date_local = '2026-11-01'; d.forecast.issued_at = d.published_at;
    d.forecast.hours.forEach((h, i) => h.valid_time = new Date(Date.parse(d.published_at) + i * 3600000).toISOString());
    const html = renderWeatherChart(validateWeather(d).forecast!.hours);
    expect(html).toContain('1:00 AM PDT'); expect(html).toContain('1:00 AM PST');
  });
});

describe('static weather publication', () => {
  it('pulls conditionally, builds only on changes, and serves without upstream or conditions reads', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(sample()), { headers: { ETag: '"one"' } }));
    await publisher().pullWeatherV1(base);
    expect(fetcher).toHaveBeenCalledWith(WEATHER_URL, expect.anything());
    const initial = await bucket.get('pages/index.html'); const tag = initial!.etag;
    const html = await initial!.text();
    expect(html).toContain('Today on the mountain'); expect(html).toContain('weather-chart');
    const before = fetcher.mock.calls.length;
    const seen: string[] = [];
    const proxy = new Proxy(bucket, { get(target, name) { if (name === 'get') return (key: string, ...args: any[]) => { seen.push(key); if (key === WEATHER_KEY || key.startsWith('alerts/')) throw new Error('No conditions reads on page visits'); return (target.get as any)(key, ...args); }; const member = Reflect.get(target, name); return typeof member === 'function' ? member.bind(target) : member; } });
    expect(await (await page({}, { SITE_BUCKET: proxy })).text()).toBe(html);
    expect(fetcher.mock.calls).toHaveLength(before); expect(seen).toEqual(['pages/index.html']);
    expect((await page({ method: 'HEAD' })).body).toBeNull();
    const served = await page(); expect((await page({ headers: { 'If-None-Match': served.headers.get('etag')! } })).status).toBe(304); await served.text();
    fetcher.mockImplementation(async () => new Response(null, { status: 304 }));
    await publisher().pullWeatherV1(base);
    expect(fetcher.mock.lastCall?.[1]).toMatchObject({ headers: { 'If-None-Match': '"one"' } });
    expect((await bucket.head('pages/index.html'))!.etag).toBe(tag);
    fetcher.mockImplementation(async () => new Response(JSON.stringify(sample()), { headers: { ETag: '"two"' } }));
    await publisher().pullWeatherV1(base);
    expect((await bucket.head('pages/index.html'))!.etag).toBe(tag);
  });
  it('preserves the accepted page and document on upstream failure or invalid content', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(sample())));
    await publisher().pullWeatherV1(base);
    const tag = (await bucket.head('pages/index.html'))!.etag;
    for (const response of [() => new Response('offline', { status: 503 }), () => new Response('{'), () => new Response(JSON.stringify({ ...sample(), schema_version: 2 }))]) {
      fetcher.mockImplementation(async () => response()); await publisher().pullWeatherV1(base);
      expect((await bucket.head('pages/index.html'))!.etag).toBe(tag);
    }
  });
  it('changes only the conditions region and retains news, metadata, footer and RSS', async () => {
    await publishDigest(bucket, digest, base, new Date(fixture.expected.published_at));
    const before = await bucket.get('pages/index.html'); const body = await before!.text(); const metadata = before!.customMetadata;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(sample())));
    await publisher().pullWeatherV1(base);
    const after = await bucket.get('pages/index.html'); const html = await after!.text();
    const without = (s: string) => s.replace(/<!-- conditions:start -->[\s\S]*?<!-- conditions:end -->/, '');
    expect(without(html)).toBe(without(body)); expect(after!.customMetadata).toEqual(metadata);
    expect(html).toContain('A saved story'); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('retains a durable pending build after a write failure and recovers even on a 304', async () => {
    await bucket.put('pages/index.html', renderPage([], { origin: base }));
    await bucket.put(WEATHER_KEY, JSON.stringify(sample()));
    await runInDurableObject(publisher(), async (instance, state) => {
      const real = (instance as any).env.SITE_BUCKET;
      (instance as any).env.SITE_BUCKET = new Proxy(real, { get(target, key) { if (key === 'put') return async () => { throw new Error('write failed'); }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
      await state.storage.put('conditions:pending', true);
      await (instance as any).finishConditions(base);
      expect(await state.storage.get('conditions:pending')).toBe(true);
      (instance as any).env.SITE_BUCKET = real;
    });
    expect(await (await bucket.get('pages/index.html'))!.text()).not.toContain('Today on the mountain');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 304 }));
    await publisher().pullWeatherV1(base);
    expect(await (await bucket.get('pages/index.html'))!.text()).toContain('Today on the mountain');
    await runInDurableObject(publisher(), async (_, state) => expect(await state.storage.get('conditions:pending')).toBeUndefined());
  });
  it('rejects a conflicting homepage replacement and leaves the newer page intact', async () => {
    const initial = renderPage([], { origin: base }); await bucket.put('pages/index.html', initial);
    const proxy = new Proxy(bucket, { get(target, name) { if (name === 'put') return async (key: string, value: any, options: any) => { await target.put(key, initial + '\nnew publication'); return target.put(key, value, options); }; const member = Reflect.get(target, name); return typeof member === 'function' ? member.bind(target) : member; } });
    await bucket.put(WEATHER_KEY, JSON.stringify(sample()));
    await expect(composeHomepageConditions(proxy, base)).rejects.toMatchObject({ code: 'publication_conflict' });
    expect(await (await bucket.get('pages/index.html'))!.text()).toBe(initial + '\nnew publication');
    expect(replaceConditions(initial, '')).toBe(initial);
  });
  it('keeps alert source success recoverable when its derived page write fails', async () => {
    const alert = { client_ref: 'pending-alert', phase: 'open', category: 'traffic', kind: 'closure', routes: ['SR-18'], headline: 'A verified closure', source: 'caltrans', source_url: 'https://roads.dot.ca.gov/', observed_at: new Date().toISOString() };
    await bucket.put('pages/index.html', renderPage([], { origin: base }));
    await runInDurableObject(publisher(), async (instance, state) => {
      const original = (instance as any).env.SITE_BUCKET;
      (instance as any).env.SITE_BUCKET = new Proxy(original, { get(target, name) {
        if (name === 'put') return (key: string, ...args: any[]) => { if (key === 'pages/index.html') throw new Error('page unavailable'); return target.put(key, ...args); };
        const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const reply = await instance.submitAlertV1(alert as any, '1'.repeat(64));
      expect(reply.ok).toBe(true); expect(await state.storage.get('conditions:pending')).toBe(true);
      (instance as any).env.SITE_BUCKET = original;
    });
    expect(await (await bucket.get('pages/index.html'))!.text()).not.toContain('A verified closure');
    const retry = await publisher().submitAlertV1(alert as any, '1'.repeat(64));
    expect(retry).toMatchObject({ ok: true, result: { status: 'duplicate' } });
    expect(await (await bucket.get('pages/index.html'))!.text()).toContain('A verified closure');
    await runInDurableObject(publisher(), async (_, state) => {
      expect(await state.storage.get('conditions:pending')).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
  it('serializes a concurrent news publication and weather update without losing either', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(sample())));
    await Promise.all([publisher().pullWeatherV1(base), publisher().publishV2(digest, base)]);
    const index = await bucket.get('pages/index.html'); const html = await index!.text();
    expect(html).toContain('A saved story'); expect(html).toContain('Today on the mountain');
    expect(await (await bucket.get(index!.customMetadata!.rss))!.text()).toContain('A saved story');
  });
});

it('publishes news with an unavailable marker and recovers from repaired conditions', async () => {
  await bucket.put(WEATHER_KEY, '{broken');
  await publishDigest(bucket, digest, base, new Date());
  const degraded = (await bucket.get('pages/index.html'))!;
  expect(await degraded.text()).toContain('Mountain conditions are temporarily unavailable.');
  expect(degraded.customMetadata?.conditions_status).toBe('unavailable');
  await bucket.put(WEATHER_KEY, JSON.stringify(sample()));
  await runInDurableObject(publisher(), async instance => (instance as any).finishConditions(base));
  const repaired = (await bucket.get('pages/index.html'))!;
  expect(await repaired.text()).toContain('Today on the mountain');
  expect(repaired.customMetadata?.conditions_status).toBeUndefined();
});
it('replaces corrupt stored weather without sending its conditional ETag', async () => {
  await bucket.put(WEATHER_KEY, '{broken');
  await runInDurableObject(publisher(), async (_, state) => state.storage.put('weather:etag', '"bad"'));
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(sample()), { headers: { ETag: '"good"' } }));
  await publisher().pullWeatherV1(base);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ headers: {} });
  expect(await (await bucket.get(WEATHER_KEY))!.json()).toEqual(sample());
});
it('allows news publishing while upstream weather is still being fetched', async () => {
  let release!: (response: Response) => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  const pulling = publisher().pullWeatherV1(base);
  await started;
  try { expect(await publisher().publishV2(digest, base)).toMatchObject({ ok: true }); }
  finally { release(new Response(JSON.stringify(sample()))); await pulling; }
});
