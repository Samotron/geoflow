import { defineProject } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineProject({
  resolve: {
    alias: {
      '@geoflow/core': resolve(__dirname, '../core/src/index.ts'),
    },
  },
  test: {
    name: 'ground-model',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
