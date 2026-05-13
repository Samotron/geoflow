import { describe, expect, it } from "vitest";
import { Severity } from "./diagnostics.js";
import { Format } from "./render.js";
import { validateText, validateTextWithSource } from "./validate-runner.js";

describe("validate runner", () => {
  it("returns exit code 0 for clean input", () => {
    const result = validateText(
      [
        `"GROUP","PROJ"`,
        `"HEADING","PROJ_ID"`,
        `"UNIT",""`,
        `"TYPE","ID"`,
        `"DATA","P1"`,
        ``,
        `"GROUP","TRAN"`,
        `"HEADING","TRAN_AGS","TRAN_RCON"`,
        `"UNIT","",""`,
        `"TYPE","X","X"`,
        `"DATA","4.1","+"`,
        ``,
      ].join("\n")
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
    // Complete file with PROJ+TRAN to satisfy structural rules; LOCA has no DATA rows
    // triggering a warning (AGS-STRUCT-005) but no errors.
    const result = validateText(
      [
        `"GROUP","PROJ"`,
        `"HEADING","PROJ_ID"`,
        `"UNIT",""`,
        `"TYPE","ID"`,
        `"DATA","P1"`,
        ``,
        `"GROUP","TRAN"`,
        `"HEADING","TRAN_AGS"`,
        `"UNIT",""`,
        `"TYPE","X"`,
        `"DATA","4.1"`,
        ``,
        `"GROUP","LOCA"`,
        `"HEADING","LOCA_ID","LOCA_TYPE"`,
        `"UNIT","",""`,
        `"TYPE","ID","X"`,
        ``,
      ].join("\n"),
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
