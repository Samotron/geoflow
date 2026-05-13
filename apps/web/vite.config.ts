import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/geoflow/',
  build: { outDir: 'dist', sourcemap: true },
  optimizeDeps: { exclude: ['better-sqlite3'] },
});
