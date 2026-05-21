import { Option } from "effect";
import { describe, expect, it } from "vitest";
import type { Diagnostic} from "./diagnostics.js";
import { Severity } from "./diagnostics.js";
import { Format, render } from "./render.js";

function sampleDiagnostics(): Diagnostic[] {
  return [
    {
      rule_id: "R1",
      severity: Severity.Error,
      message: "boom",
      location: {
        file: Option.some("/tmp/file.ags"),
        line: Option.none(),
        column: Option.none(),
        group: Option.some("LOCA"),
        row_index: Option.none(),
      },
      fix_id: Option.none(),
    },
    {
      rule_id: "R2",
      severity: Severity.Warning,
      message: "watch out",
      location: {
        file: Option.none(),
        line: Option.some(3),
        column: Option.none(),
        group: Option.none(),
        row_index: Option.none(),
      },
      fix_id: Option.some("normalize-whitespace"),
    },
  ];
}

describe("render", () => {
  it("renders text output with summary", () => {
    const output = render(sampleDiagnostics(), Format.Text);
    expect(output).toContain('error: [R1] boom (file=/tmp/file.ags, group=LOCA)');
    expect(output).toContain("warning: [R2] watch out (line=3) [auto-fixable: normalize-whitespace]");
    expect(output).toContain("summary: 1 error, 1 warning, 0 info");
  });

  it("renders JSON output with null locations", () => {
    const output = render(sampleDiagnostics(), Format.Json);
    expect(output).toContain('"rule_id": "R1"');
    expect(output).toContain('"file": "/tmp/file.ags"');
    expect(output).toContain('"line": null');
  });

  it("renders JUnit output", () => {
    const output = render(sampleDiagnostics(), Format.Junit);
    expect(output).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(output).toContain('<testsuite name="geoflow" tests="2" failures="1" errors="0" skipped="1">');
    expect(output).toContain('<failure message="boom"/>');
    expect(output).toContain('<skipped message="watch out"/>');
  });

  it("parses format strings", () => {
    expect(Format.parse("text")).toBe(Format.Text);
    expect(Format.parse("json")).toBe(Format.Json);
    expect(Format.parse("junit")).toBe(Format.Junit);
    expect(Format.parse("yaml")).toBeNull();
  });
});
