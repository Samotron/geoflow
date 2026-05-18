import { defineProject } from "vitest/config";
import { resolve } from "node:path";

export default defineProject({
  resolve: {
    alias: {
      "@geoflow/core": resolve(__dirname, "../../packages/core/src/index.ts"),
      "@geoflow/rules-engine": resolve(__dirname, "../../packages/rules-engine/src/index.ts"),
      "@geoflow/transform": resolve(__dirname, "../../packages/transform/src/index.ts"),
    },
  },
  test: {
    name: "web",
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
