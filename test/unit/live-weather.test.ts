import { expect, it } from 'vitest';
import { validateWeather, WEATHER_URL } from '../../src/weather';
it.skipIf(process.env.TEST_LIVE_WEATHER !== '1')('accepts the live producer contract without publishing any state', async () => {
  const response = await fetch(WEATHER_URL, { signal: AbortSignal.timeout(30000) });
  expect(response.status).toBe(200);
  expect(validateWeather(await response.json()).schema_version).toBe(1);
}, 35000);
