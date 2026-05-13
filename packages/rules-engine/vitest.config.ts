import { defineProject } from "vitest/config";
import { resolve } from "node:path";

export default defineProject({
  resolve: {
    alias: {
      "@geoflow/core": resolve(__dirname, "../core/src/index.ts"),
    },
  },
  test: {
    name: "rules-engine",
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
