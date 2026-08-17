import { resolve } from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config({ path: resolve(import.meta.dirname, '.env.local'), quiet: true });

export default defineConfig({
  resolve: {
    alias: {
      '@': import.meta.dirname,
      'server-only': resolve(import.meta.dirname, 'test/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    sequence: { concurrent: false },
  },
});
