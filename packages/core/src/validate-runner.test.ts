import { describe, expect, it } from "vitest";
import { Severity } from "./diagnostics.js";
import { Format } from "./render.js";
import { validateText, validateTextWithSource } from "./validate-runner.js";

describe("validate runner", () => {
  it("returns exit code 0 for clean input", () => {
    const result = validateText(
      `"GROUP","PROJ"\n"HEADING","PROJ_ID"\n"UNIT",""\n"TYPE","ID"\n"DATA","P1"\n`
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("summary: 0 error, 0 warning, 0 info");
  });

  it("returns exit code 1 when fail-on severity is met", () => {
    const result = validateText(
      `"GROUP","LOCA"\n"HEADING","LOCA_ID","LOCA_TYPE"\n"UNIT","",""\n"TYPE","ID","X"\n`,
      { failOn: Severity.Warning }
    );

    expect(result.exitCode).toBe(1);
    expect(result.diagnostics.some((diagnostic) => diagnostic.rule_id === "AGS-STRUCT-005")).toBe(true);
  });

  it("renders JSON output", () => {
    const result = validateText(
      `"GROUP","LOCA"\n"HEADING","LOCA_ID","LOCA_TYPE"\n"UNIT","",""\n"TYPE","ID","X"\n`,
      { format: Format.Json }
    );

    expect(result.output).toContain('"rule_id": "AGS-STRUCT-005"');
  });

  it("does not fail on warnings when fail-on is error", () => {
    const result = validateText(
      `"GROUP","LOCA"\n"HEADING","LOCA_ID","LOCA_TYPE"\n"UNIT","",""\n"TYPE","ID","X"\n`,
      { failOn: Severity.Error }
    );

    expect(result.exitCode).toBe(0);
  });

  it("injects the source path into diagnostics when provided", () => {
    const result = validateTextWithSource(
      `"GROUP","LOCA"\n"HEADING","LOCA_ID","LOCA_TYPE"\n"UNIT","",""\n"TYPE","ID","X"\n`,
      "/tmp/test.ags"
    );

    expect(result.output).toContain("file=/tmp/test.ags");
  });
});
