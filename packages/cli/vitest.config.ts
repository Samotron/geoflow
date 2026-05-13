import { defineProject } from "vitest/config";
import { resolve } from "node:path";

export default defineProject({
  resolve: {
    alias: {
      "@geoflow/core": resolve(__dirname, "../core/src/index.ts"),
      "@geoflow/rules-engine": resolve(__dirname, "../rules-engine/src/index.ts"),
    },
  },
  test: {
    name: "cli",
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
