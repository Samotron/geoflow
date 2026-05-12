import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderInfo, summarizeInfo, summarizeInfoBytes } from "./info.js";

const AGS_FIXTURE_DIR = resolve(import.meta.dirname, "../../../tests/fixtures/ags");

describe("info summary", () => {
  it("renders project, locations, and depth range for a standard file", () => {
    const file = resolve(AGS_FIXTURE_DIR, "minimal_valid.ags");
    const summary = summarizeInfo(readFileSync(file, "utf8"), file);

    expect(summary.agsVersion).toBe("4.1");
    expect(summary.groups).toBe(4);
    expect(summary.rows).toBe(8);
    expect(summary.locations).toBe(2);
    expect(summary.project).toBe("Synthetic minimal AGS file");
    expect(summary.depthRange).toEqual({ min: 0, max: 6.4 });
    expect(summary.diagnostics).toBe(0);
    expect(renderInfo(summary)).toContain("depth range: 0..6.4 m");
  });

  it("reports parser diagnostic count for malformed files", () => {
    const file = resolve(AGS_FIXTURE_DIR, "short_row.ags");
    const summary = summarizeInfo(readFileSync(file, "utf8"), file);

    expect(summary.diagnostics).toBe(2);
    expect(renderInfo(summary)).toContain("diagnostics: 2");
  });

  it("handles AGS 3 input as diagnostics without version metadata", () => {
    const file = resolve(AGS_FIXTURE_DIR, "sample_v3.ags");
    const summary = summarizeInfo(readFileSync(file, "utf8"), file);

    expect(summary.groups).toBe(0);
    expect(summary.rows).toBe(0);
    expect(summary.locations).toBeUndefined();
    expect(summary.agsVersion).toBeUndefined();
    expect(summary.diagnostics).toBe(1);
  });

  it("decodes Windows-1252 fixture text through the byte path", () => {
    const file = resolve(AGS_FIXTURE_DIR, "encoding_win1252.ags");
    const summary = summarizeInfoBytes(readFileSync(file), file);

    expect(summary.project).toBe("Tést Projét");
  });
});
