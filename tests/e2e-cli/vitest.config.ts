import { defineConfig } from "vitest/config";

// E2E CLI tests (Milestone 6) — placeholder until the test suite is added.
export default defineConfig({
  test: {
    name: "e2e-cli",
    include: ["**/*.e2e.ts"],
  },
});
