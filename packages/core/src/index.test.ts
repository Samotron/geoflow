import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, parseStr, serialize, Severity } from "./index.js";

describe("@geoflow/core", () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@geoflow/core");
  });

  it("re-exports parser, serializer, and diagnostics surface", () => {
    const outcome = parseStr('"GROUP","PROJ"\n"HEADING","PROJ_ID"\n"UNIT",""\n"TYPE","ID"\n"DATA","P1"\n');

    expect(outcome.diagnostics).toEqual([]);
    expect(serialize(outcome.file)).toContain('"GROUP","PROJ"');
    expect(Severity.Error).toBe("error");
  });
});
