import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      'server-only': path.resolve(__dirname, 'test/server-only.ts'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
