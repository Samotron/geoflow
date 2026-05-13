import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        "browser-stub": resolve(__dirname, "src/browser-stub.ts"),
      },
      formats: ["es"],
    },
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      external: ["@geoflow/core", "effect", "better-sqlite3", /^node:/],
    },
  },
});
