import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: '/geoflow/',
  build: { outDir: 'dist', sourcemap: true },
  optimizeDeps: { exclude: ['better-sqlite3', 'sql.js'] },
  resolve: {
    alias: {
      '@geoflow/core': resolve(__dirname, '../../packages/core/src/index.ts'),
      '@geoflow/rules-engine': resolve(__dirname, '../../packages/rules-engine/src/index.ts'),
    },
  },
});
