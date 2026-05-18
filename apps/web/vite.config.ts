import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Expose built-in rule packs as a virtual module. Pack YAMLs live at the repo
// root under rules/specs/ — outside apps/web — and are read at build time.
function geoflowPacks(): Plugin {
  const VIRTUAL_ID = 'virtual:geoflow-packs';
  const RESOLVED_ID = '\0' + VIRTUAL_ID;
  return {
    name: 'geoflow-packs',
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      const agsStandard = readFileSync(
        resolve(__dirname, '../../rules/specs/ags/standard/4.x/pack.yml'),
        'utf-8',
      );
      return `export const agsStandard = ${JSON.stringify(agsStandard)};\n`;
    },
  };
}

export default defineConfig({
  plugins: [react(), geoflowPacks()],
  base: '/geoflow/',
  build: { outDir: 'dist', sourcemap: true },
  optimizeDeps: { exclude: ['better-sqlite3', 'sql.js'] },
  resolve: {
    alias: {
      '@geoflow/core': resolve(__dirname, '../../packages/core/src/index.ts'),
      '@geoflow/rules-engine': resolve(__dirname, '../../packages/rules-engine/src/index.ts'),
      '@geoflow/transform': resolve(__dirname, '../../packages/transform/src/index.ts'),
    },
  },
});
