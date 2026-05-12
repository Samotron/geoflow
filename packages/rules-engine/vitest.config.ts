import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "rules-engine",
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
