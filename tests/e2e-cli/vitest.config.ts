import { defineProject } from "vitest/config";
import { resolve } from "node:path";

export default defineProject({
  resolve: {
    alias: {
      "@geoflow/core": resolve(__dirname, "../../packages/core/src/index.ts"),
      "@geoflow/rules-engine": resolve(__dirname, "../../packages/rules-engine/src/index.ts"),
      "@geoflow/db": resolve(__dirname, "../../packages/db/src/index.ts"),
    },
  },
  test: {
    name: "e2e-cli",
    environment: "node",
    include: ["**/*.e2e.ts"],
  },
});
