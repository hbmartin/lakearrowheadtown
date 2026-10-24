import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('.artifacts', { recursive: true });
writeFileSync('.artifacts/property-replay.json', JSON.stringify({ seed: Number(process.env.TEST_SEED ?? 20261024), extended: process.env.TEST_EXTENDED === '1', path: process.env.TEST_REPLAY_PATH ?? null }, null, 2));

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc', environment: 'preview' },
    miniflare: {
      bindings: {
        API_SECRET: 'test-secret-at-least-thirty-two-characters-long',
        TEST_SEED: process.env.TEST_SEED ?? '20261024',
        TEST_EXTENDED: process.env.TEST_EXTENDED ?? '0',
        TEST_REPLAY_PATH: process.env.TEST_REPLAY_PATH ?? '',
        TEST_LIVE_WEATHER: process.env.TEST_LIVE_WEATHER ?? '0',
        SITE_ORIGIN: 'https://lakearrowhead.town',
        ALERT_CONFIRMATIONS_ENABLED: 'true',
      },
    },
  })],
  test: {
    fileParallelism: false,
    include: ['test/*.test.ts', 'test/unit/**/*.test.ts'],
    reporters: ['default', 'junit'],
    outputFile: { junit: '.artifacts/workers.xml' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'html', 'lcovonly', 'json', 'json-summary'],
      reportsDirectory: './coverage/worker',
      thresholds: {
        lines: 97, statements: 94, functions: 97, branches: 90,
        'src/events.ts': { branches: 85 },
        'src/calendar.ts': { branches: 85 },
        'src/weather.ts': { branches: 90 },
        'src/repair-coordinator.ts': { branches: 90 },
        'src/changes.ts': { branches: 90 },
      },
    },
  },
});
