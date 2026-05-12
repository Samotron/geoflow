import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fixBytes, inspectBytes } from "./fix.js";

const AGS_FIXTURE_DIR = resolve(import.meta.dirname, "../../../tests/fixtures/ags");

describe("fix", () => {
  it("detects LF-only files for newline normalization", () => {
    const file = resolve(AGS_FIXTURE_DIR, "xref_multi_invalid.ags");
    const inspection = inspectBytes(readFileSync(file));

    expect(inspection.findings).toEqual(["normalize-line-endings"]);
  });

  it("emits a structured log entry for text-level normalization", () => {
    const file = resolve(AGS_FIXTURE_DIR, "xref_multi_invalid.ags");
    const result = fixBytes(readFileSync(file));

    expect(result.applied).toEqual(["normalize-line-endings"]);
    expect(result.log.changes).toEqual([
      {
        fix: "normalize-line-endings",
        group: "",
        before: "",
        after: "(text-level normalisation)",
        kind: "cell_value",
      },
    ]);
    expect(result.output).toContain("\r\n");
  });
});
