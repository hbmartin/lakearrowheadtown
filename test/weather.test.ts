import { withoutIndexFence } from '../src/index-fence';
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/town-card.json';
import worker from '../src/worker';
import { validateWeather, renderWeatherChart, WEATHER_KEY, WEATHER_URL } from '../src/weather';
import { composeHomepageConditions, conditionsSnapshot, replaceConditions } from '../src/homepage-conditions';
import { submitAlert, validateAlertInput, ALERTS_KEY } from '../src/alerts';
import { NEWS_ANCHOR } from '../src/index-metadata';
import { renderPage } from '../src/render';
import { currentPublication, publishDigest } from '../src/publishing';
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
    const without = (s: string) => withoutIndexFence(s).replace(/<!-- conditions:start -->[\s\S]*?<!-- conditions:end -->/, '');
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
  expect(await degraded.text()).toContain('Weather is temporarily unavailable.');
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
  // Keep the synthetic pending fetch in one test I/O context; native upstream
  // fetches do not share the test runner's cross-RPC promise ownership.
  await runInDurableObject(publisher(), async instance => {
    const pulling = instance.pullWeatherV1(base);
    await started;
    try { expect(await instance.publishV2(digest, base)).toMatchObject({ ok: true }); }
    finally { release(new Response(JSON.stringify(sample()))); await pulling; }
  });
});

it.each([[false, false], [false, true], [true, false], [true, true]])('isolates alert failure=%s and weather failure=%s', async (badAlerts, badWeather) => {
  const now = new Date();
  await submitAlert(bucket, validateAlertInput({ client_ref: 'healthy-alert', phase: 'open', category: 'traffic', kind: 'closure',
    routes: ['SR-18'], headline: 'Fresh road closure', source: 'caltrans', source_url: 'https://roads.dot.ca.gov/', observed_at: now.toISOString() }), 'a'.repeat(64), now);
  await bucket.put(WEATHER_KEY, JSON.stringify(sample()));
  if (badAlerts) await bucket.put(ALERTS_KEY, '{broken');
  if (badWeather) await bucket.put(WEATHER_KEY, '{broken');
  const result = await conditionsSnapshot(bucket, undefined, now);
  expect(result.available).toBe(!badAlerts && !badWeather);
  expect(result.html.includes('Fresh road closure')).toBe(!badAlerts);
  expect(result.html.includes('Today on the mountain')).toBe(!badWeather);
  if (badAlerts || badWeather) expect(result.html).toContain('role="status"');
  if (badAlerts && badWeather) expect(result.html).toContain('Mountain conditions are temporarily unavailable.');
  else if (badAlerts) {
    expect(result.html).toContain('Road and power alerts are temporarily unavailable.');
    expect(result.html.indexOf('conditions-unavailable')).toBeLessThan(result.html.indexOf('conditions-row'));
    expect(result.html).toMatch(/<\/div><\/div><section id="weather-details"/);
  }
  else if (badWeather) expect(result.html).toContain('Weather is temporarily unavailable.');
});

it('treats an existing empty weather body as unavailable and retains composition intent', async () => {
  await bucket.put(WEATHER_KEY, '');
  await publishDigest(bucket, digest, base);
  await runInDurableObject(publisher(), async instance => (instance as any).finishConditions(base));
  expect((await conditionsSnapshot(bucket)).available).toBe(false);
  await runInDurableObject(publisher(), async (_, state) => expect(await state.storage.get('conditions:pending')).toBe(true));
});

it('clears an unavailable metadata marker even when fresh HTML already matches', async () => {
  vi.setSystemTime(new Date());
  try {
  await bucket.put(WEATHER_KEY, JSON.stringify(sample()));
  await composeHomepageConditions(bucket, base);
  const index = (await bucket.get('pages/index.html'))!; const html = await index.text();
  await bucket.put('pages/index.html', html, { customMetadata: { ...index.customMetadata, conditions_status: 'unavailable' } });
  await composeHomepageConditions(bucket, base);
  const healed = (await bucket.get('pages/index.html'))!;
  expect(withoutIndexFence(await healed.text())).toBe(withoutIndexFence(html)); expect(healed.customMetadata?.conditions_status).toBeUndefined();
  } finally { vi.useRealTimers(); }
});

it('retains a legacy saved news window through repeated conditions writes', async () => {
  const anchor = new Date('2026-10-10T20:00:00Z');
  await bucket.put('pages/index.html', renderPage([], { origin: base }));
  await bucket.put(WEATHER_KEY, JSON.stringify(sample()));
  let rewritten = false;
  const dated = (value: R2Object | R2ObjectBody | null) => value && !rewritten ? new Proxy(value, { get(target, property) {
    if (property === 'uploaded') return anchor;
    const found = Reflect.get(target, property); return typeof found === 'function' ? found.bind(target) : found;
  } }) : value;
  const store = new Proxy(bucket, { get(target, property) {
    if (property === 'head') return async (key: string) => dated(await target.head(key));
    if (property === 'get') return async (key: string) => key === 'pages/index.html' ? dated(await target.get(key)) : target.get(key);
    if (property === 'put') return async (key: string, body: any, options: any) => { const value = await target.put(key, body, options); rewritten = true; return value; };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const discover = async () => [{ id: 'legacy-2026-10-05', key: 'digests/2026-10-05.json', date: '2026-10-05', received_at: '2026-10-05T20:00:00Z' }];
  const before = await currentPublication(store, discover);
  await composeHomepageConditions(store, base);
  await bucket.put(WEATHER_KEY, '{broken'); await composeHomepageConditions(store, base);
  expect(await currentPublication(store, discover)).toEqual(before);
  expect((await bucket.head('pages/index.html'))!.customMetadata?.[NEWS_ANCHOR]).toBe(anchor.toISOString());
});

it('does not replace a legacy page when its preserved news anchor is invalid or cannot fit', async () => {
  for (const metadata of [{ [NEWS_ANCHOR]: 'broken' }, { padding: 'x'.repeat(8185) }] as Record<string, string>[]) {
    await bucket.put('pages/index.html', renderPage([], { origin: base }), { customMetadata: metadata });
    const before = (await bucket.head('pages/index.html'))!;
    await bucket.put(WEATHER_KEY, '{broken');
    await expect(composeHomepageConditions(bucket, base)).rejects.toMatchObject({ code: NEWS_ANCHOR in metadata ? 'legacy_recovery_required' : 'index_metadata_too_large' });
    expect((await bucket.head('pages/index.html'))!.version).toBe(before.version);
  }
});

it.each([[false, false], [false, true], [true, false], [true, true]])('avoids clock-only writes with alert failure=%s and weather failure=%s', async (badAlerts, badWeather) => {
  const now = new Date('2026-10-23T18:00:00Z'); vi.setSystemTime(now);
  try {
    await submitAlert(bucket, validateAlertInput({ client_ref: 'stable-alert', phase: 'open', category: 'traffic', kind: 'closure', routes: ['SR-18'], headline: 'Stable closure', source: 'caltrans', source_url: 'https://roads.dot.ca.gov/', observed_at: now.toISOString() }), 'a'.repeat(64), now);
    await bucket.put(WEATHER_KEY, JSON.stringify(sample()));
    if (badAlerts) await bucket.put(ALERTS_KEY, '{broken'); if (badWeather) await bucket.put(WEATHER_KEY, '{broken');
    await composeHomepageConditions(bucket, base);
    const before = (await bucket.get('pages/index.html'))!; const html = await before.text();
    vi.setSystemTime(new Date(+now + 300000));
    const put = vi.fn((key: string, value: any, options: any) => bucket.put(key, value, options));
    const store = new Proxy(bucket, { get(target, property) { if (property === 'put') return put; const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; } });
    expect(await composeHomepageConditions(store, base)).toBe(!badAlerts && !badWeather);
    expect(put).not.toHaveBeenCalled(); expect(await (await bucket.get('pages/index.html'))!.text()).toBe(html);
    if (badAlerts && badWeather) expect(html).not.toContain('<div class="conditions-row">');
    if (!badWeather) {
      const fresh = sample(); fresh.observation.temp_f += 1;
      await bucket.put(WEATHER_KEY, JSON.stringify(fresh)); await composeHomepageConditions(store, base);
      expect(put).toHaveBeenCalledTimes(1); expect(await (await bucket.get('pages/index.html'))!.text()).not.toBe(html);
    }
  } finally { vi.useRealTimers(); }
});

it('clears recovery markers without refreshing unchanged snapshot text after time advances', async () => {
  const now = new Date('2026-10-23T18:00:00Z'); vi.setSystemTime(now);
  try {
    await bucket.put(WEATHER_KEY, JSON.stringify(sample())); await composeHomepageConditions(bucket, base);
    const before = (await bucket.get('pages/index.html'))!; const html = await before.text();
    await bucket.put('pages/index.html', html, { customMetadata: { ...before.customMetadata, conditions_status: 'unavailable' } });
    vi.setSystemTime(new Date(+now + 300000));
    await runInDurableObject(publisher(), async (instance, state) => { await state.storage.put('conditions:pending', true); await (instance as any).finishConditions(base); expect(await state.storage.get('conditions:pending')).toBeUndefined(); });
    const healed = (await bucket.get('pages/index.html'))!; expect(withoutIndexFence(await healed.text())).toBe(withoutIndexFence(html)); expect(healed.customMetadata?.conditions_status).toBeUndefined();
  } finally { vi.useRealTimers(); }
});

it('logs the neutral conditions metadata code and retains pending intent without replacing the page', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  await bucket.put('pages/index.html', renderPage([], { origin: base }), { customMetadata: { padding: 'x'.repeat(8185) } });
  await bucket.put(WEATHER_KEY, '{broken'); const version = (await bucket.head('pages/index.html'))!.version;
  await runInDurableObject(publisher(), async (instance, state) => {
    await state.storage.put('conditions:pending', true);
    await (instance as any).finishConditions(base, { request_id: 'conditions-error', operation: 'alert', worker_version: 'test', environment: 'preview' });
    expect(await state.storage.get('conditions:pending')).toBe(true);
  });
  expect((await bucket.head('pages/index.html'))!.version).toBe(version);
  expect(errors.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({ event: 'conditions_composition_failed', error_code: 'index_metadata_too_large', stage: 'conditions_composition' }));
});

it.each([429, 503, 200])('logs upstream status and cancels unused weather bodies (%s)', async status => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {}); const cancel = vi.fn();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new ReadableStream({ cancel }), { status, headers: status === 200 ? { 'Content-Length': String(128 * 1024 + 1) } : {} }));
  await publisher().pullWeatherV1(base);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(errors.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({ event: 'weather_pull_failed', upstream_status: status,
    error_code: status === 200 ? 'body_too_large' : 'weather_upstream_failed', stage: status === 200 ? 'weather_body_read' : 'weather_fetch' }));
});

it.each(['pending', 'etag_put', 'etag_delete'] as const)('classifies weather %s persistence failures as storage errors', async fault => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(sample()), { headers: fault === 'etag_delete' ? {} : { ETag: '"new"' } }));
  await runInDurableObject(publisher(), async (instance, state) => {
    const method = fault === 'etag_delete' ? 'delete' : 'put'; const original = state.storage[method].bind(state.storage) as any;
    const injection = vi.spyOn(state.storage, method).mockImplementation(((key: string, ...args: any[]) => {
      if (key === (fault === 'pending' ? 'conditions:pending' : 'weather:etag')) throw new Error('Private durable storage outage');
      return original(key, ...args);
    }) as any);
    try { await instance.pullWeatherV1(base); } finally { injection.mockRestore(); }
  });
  expect(errors.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({ event: 'weather_pull_failed', error_code: 'storage_error',
    stage: fault === 'pending' ? 'weather_storage_write' : 'weather_etag_write', failure_kind: 'storage' }));
  expect(JSON.stringify(errors.mock.calls)).not.toContain('Private durable storage outage');
});
