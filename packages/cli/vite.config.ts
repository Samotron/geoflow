import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    ssr: true,
    target: "node20",
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, "src/main.ts"),
      formats: ["es"],
      fileName: () => "main.js",
    },
    rollupOptions: {
      external: [
        /^@geoflow\//,
        /^@effect\//,
        "effect",
        /^node:/,
        "better-sqlite3",
      ],
    },
  },
});
