import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc', environment: 'preview' },
    miniflare: {
      bindings: {
        API_SECRET: 'test-secret-at-least-thirty-two-characters-long',
        SITE_ORIGIN: 'https://lakearrowhead.town',
      },
    },
  })],
  test: { fileParallelism: false, include: ['test/**/*.test.ts'] },
});
