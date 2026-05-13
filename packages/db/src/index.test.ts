import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@geoflow/db skeleton", () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@geoflow/db");
  });
});
