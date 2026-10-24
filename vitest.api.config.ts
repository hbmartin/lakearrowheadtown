import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['test/api/**/*.test.ts'], fileParallelism: false,
  testTimeout: 30000, hookTimeout: 30000,
  reporters: ['default', 'junit'], outputFile: { junit: '.artifacts/api.xml' },
} });
