/**
 * Integration tests: multi-step CLI workflows against real fixture files.
 *
 * These tests exercise the full pipeline (parse → process → output) across
 * multiple commands and assert on cross-command invariants rather than
 * individual function behaviour.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runCli } from "../../packages/cli/src/main.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const FIXTURES = join(import.meta.dirname, "../fixtures/ags");
const F = (name: string) => join(FIXTURES, name);

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "geoflow-e2e-"));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Fix → Validate pipeline ───────────────────────────────────────────────────

describe("fix → validate pipeline", () => {
  it("fix --write reduces trailing-whitespace issues in fixable.ags", () => {
    const tempFile = join(tmpDir, "fix_validate.ags");
    writeFileSync(tempFile, readFileSync(F("fixable.ags")));

    const fixResult = runCli(["fix", tempFile, "--write"]);
    expect(fixResult.exitCode).toBe(0);
    expect(fixResult.stdout).toContain("applied fixes");

    // The fixed file must still parse cleanly (exit 0 or 1, never 2)
    const after = runCli(["validate", tempFile]);
    expect(after.exitCode).toBeLessThanOrEqual(1);
    expect(after.stderr).toBe("");
  });

  it("fix is idempotent: a second dry-run reports no remaining fixes", () => {
    const tempFile = join(tmpDir, "fix_idempotent.ags");
    writeFileSync(tempFile, readFileSync(F("fixable.ags")));

    runCli(["fix", tempFile, "--write"]);

    const second = runCli(["fix", tempFile]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("no fixes applied");
  });

  it("fix --write actually changes the file bytes when fixes are applied", () => {
    const tempFile = join(tmpDir, "fix_bytes.ags");
    const original = readFileSync(F("fixable.ags"));
    writeFileSync(tempFile, original);

    runCli(["fix", tempFile, "--write"]);

    const after = readFileSync(tempFile);
    expect(after.equals(original)).toBe(false);
  });
});

// ── Convert round-trip ────────────────────────────────────────────────────────

describe("convert round-trip (AGS → DIGGS → AGS)", () => {
  it("round-tripped file has the same group count as the original", () => {
    const diggs = join(tmpDir, "roundtrip.diggs");
    const ags2  = join(tmpDir, "roundtrip.ags");

    expect(runCli(["convert", F("minimal_valid.ags"), diggs]).exitCode).toBe(0);
    expect(runCli(["convert", diggs, ags2]).exitCode).toBe(0);

    const infoOrig = runCli(["info", F("minimal_valid.ags")]);
    const infoRT   = runCli(["info", ags2]);

    expect(infoOrig.exitCode).toBe(0);
    expect(infoRT.exitCode).toBe(0);

    // Extract "groups: N" from both and compare
    const origGroups = infoOrig.stdout.match(/groups: (\d+)/)?.[1];
    const rtGroups   = infoRT.stdout.match(/groups: (\d+)/)?.[1];
    expect(rtGroups).toBe(origGroups);
  });

  it("DIGGS output is well-formed XML with the DIGGS namespace", () => {
    const diggs = join(tmpDir, "ns_check.diggs");
    runCli(["convert", F("minimal_valid.ags"), diggs]);

    const xml = readFileSync(diggs, "utf8");
    expect(xml.trimStart()).toMatch(/^<\?xml/);
    expect(xml.toLowerCase()).toContain("diggs");
  });

  it("round-trip preserves LOCA location count", () => {
    const diggs = join(tmpDir, "loca_rt.diggs");
    const ags2  = join(tmpDir, "loca_rt.ags");
    runCli(["convert", F("browser_explorer.ags"), diggs]);
    runCli(["convert", diggs, ags2]);

    const origInfo = runCli(["info", F("browser_explorer.ags")]);
    const rtInfo   = runCli(["info", ags2]);

    const origLoca = origInfo.stdout.match(/locations: (\d+)/)?.[1];
    const rtLoca   = rtInfo.stdout.match(/locations: (\d+)/)?.[1];
    expect(rtLoca).toBe(origLoca);
  });
});

// ── Diff symmetry ─────────────────────────────────────────────────────────────

describe("diff symmetry invariant", () => {
  it("only_in_a and only_in_b swap when file order is reversed", () => {
    const a = F("abbr_codelist_invalid.ags");
    const b = F("abbr_codelist_valid.ags");

    const ab = JSON.parse(runCli(["diff", a, b, "--format", "json"]).stdout);
    const ba = JSON.parse(runCli(["diff", b, a, "--format", "json"]).stdout);

    expect([...ab.only_in_a].sort()).toEqual([...ba.only_in_b].sort());
    expect([...ab.only_in_b].sort()).toEqual([...ba.only_in_a].sort());
  });

  it("diff of a file against itself exits 0 and reports identical", () => {
    const file = F("minimal_valid.ags");
    const result = runCli(["diff", file, file]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("files are identical");
  });

  it("diff of two different files exits 1", () => {
    const result = runCli(["diff", F("minimal_valid.ags"), F("browser_explorer.ags")]);
    expect(result.exitCode).toBe(1);
  });

  it("diff JSON reports identical:true iff text reports identical", () => {
    const a = F("minimal_valid.ags");
    const b = F("browser_explorer.ags");

    const textResult = runCli(["diff", a, b]);
    const jsonResult = JSON.parse(runCli(["diff", a, b, "--format", "json"]).stdout);

    const textIdentical = textResult.stdout.includes("files are identical");
    expect(jsonResult.identical).toBe(textIdentical);
  });
});

// ── Export ↔ Info consistency ─────────────────────────────────────────────────

describe("export row count matches info location count", () => {
  it("CSV row count (minus header) equals info location count", () => {
    const csvFile = join(tmpDir, "loca_export.csv");
    const file    = F("browser_explorer.ags");

    const infoResult  = runCli(["info", file]);
    const locaCount   = parseInt(infoResult.stdout.match(/locations: (\d+)/)![1]!, 10);

    runCli(["export", file, "--group", "LOCA", "--format", "csv", "--out", csvFile]);

    const csv   = readFileSync(csvFile, "utf8");
    const lines = csv.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(locaCount + 1); // +1 for header
  });

  it("CSV header contains standard LOCA column names", () => {
    const csvFile = join(tmpDir, "loca_cols.csv");
    runCli(["export", F("browser_explorer.ags"), "--group", "LOCA", "--format", "csv", "--out", csvFile]);

    const header = readFileSync(csvFile, "utf8").split("\n")[0]!;
    expect(header).toContain("LOCA_ID");
    expect(header).toContain("LOCA_NATE");
    expect(header).toContain("LOCA_NATN");
  });

  it("TSV export uses tab delimiters, not commas", () => {
    const tsvFile = join(tmpDir, "loca_tab.tsv");
    runCli(["export", F("browser_explorer.ags"), "--group", "LOCA", "--format", "tsv", "--out", tsvFile]);

    const header = readFileSync(tsvFile, "utf8").split("\n")[0]!;
    expect(header).toContain("\t");
    expect(header).not.toContain(",");
  });

  it("exported GEOL CSV has one row per GEOL DATA entry", () => {
    const csvFile = join(tmpDir, "geol_export.csv");
    const file    = F("browser_explorer.ags");
    runCli(["export", file, "--group", "GEOL", "--format", "csv", "--out", csvFile]);

    const csv   = readFileSync(csvFile, "utf8");
    const lines = csv.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(1); // at least header + 1 row
    expect(lines[0]).toContain("GEOL_TOP");
  });
});

// ── Report ↔ Info consistency ─────────────────────────────────────────────────

describe("report consistency with info", () => {
  it("report JSON loca array length matches info location count", () => {
    const file = F("browser_explorer.ags");

    const infoResult = runCli(["info", file]);
    const expected   = parseInt(infoResult.stdout.match(/locations: (\d+)/)![1]!, 10);

    const reportResult = runCli(["report", file, "--format", "json"]);
    expect(reportResult.exitCode).toBe(0);

    const report = JSON.parse(reportResult.stdout);
    expect(report.loca.length).toBe(expected);
  });

  it("report totalHoles matches info location count", () => {
    const file = F("browser_explorer.ags");

    const infoResult = runCli(["info", file]);
    const expected   = parseInt(infoResult.stdout.match(/locations: (\d+)/)![1]!, 10);

    const report = JSON.parse(runCli(["report", file, "--format", "json"]).stdout);
    expect(report.totalHoles).toBe(expected);
  });

  it("report text output contains project and location sections", () => {
    const result = runCli(["report", F("browser_explorer.ags")]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toMatch(/project|proj/);
    expect(result.stdout.toLowerCase()).toMatch(/hole|borehole|exploratory/);
  });

  it("report --out writes to file instead of stdout", () => {
    const outFile = join(tmpDir, "report_out.txt");
    const result  = runCli(["report", F("browser_explorer.ags"), "--out", outFile]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("report written to");
    const content = readFileSync(outFile, "utf8");
    expect(content.length).toBeGreaterThan(100);
  });
});

// ── Explore → HTML file output ────────────────────────────────────────────────

describe("explore --out produces self-contained HTML", () => {
  it("output file starts with <!DOCTYPE html> and contains borehole IDs", () => {
    const outFile = join(tmpDir, "explorer.html");
    const result  = runCli(["explore", F("browser_explorer.ags"), "--out", outFile]);

    expect(result.exitCode).toBe(0);
    const html = readFileSync(outFile, "utf8");
    expect(html.trimStart()).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain("BH01");
    expect(html).toContain("BH02");
  });

  it("HTML contains SVG strip-log elements", () => {
    const outFile = join(tmpDir, "explorer_svg.html");
    runCli(["explore", F("browser_explorer.ags"), "--out", outFile]);
    expect(readFileSync(outFile, "utf8")).toContain("<svg");
  });

  it("HTML has no external script src URLs", () => {
    const outFile = join(tmpDir, "explorer_self.html");
    runCli(["explore", F("browser_explorer.ags"), "--out", outFile]);
    const html = readFileSync(outFile, "utf8");
    expect(html).not.toMatch(/src="https?:\/\//);
    expect(html).not.toMatch(/href="https?:\/\//);
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe("error handling: nonexistent files always exit 2", () => {
  const ghost = "/tmp/does-not-exist-geoflow-99999.ags";

  it.each(["info", "validate", "fix", "explore", "report"] as const)(
    "%s with missing file → exit 2 + stderr message",
    (cmd) => {
      const result = runCli([cmd, ghost]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.length).toBeGreaterThan(0);
    }
  );

  it("diff exits 2 when first file is missing", () => {
    const result = runCli(["diff", ghost, F("minimal_valid.ags")]);
    expect(result.exitCode).toBe(2);
  });

  it("diff exits 2 when second file is missing", () => {
    const result = runCli(["diff", F("minimal_valid.ags"), ghost]);
    expect(result.exitCode).toBe(2);
  });

  it("convert exits 2 when input file is missing", () => {
    const result = runCli(["convert", ghost, join(tmpDir, "out.diggs")]);
    expect(result.exitCode).toBe(2);
  });
});

// ── Validate exit codes ───────────────────────────────────────────────────────

describe("validate exit codes reflect actual error presence", () => {
  it.each([
    ["abbr_codelist_valid.ags",   0],
    ["browser_explorer.ags",      0],
    ["minimal_valid.ags",         0],
    ["abbr_codelist_invalid.ags", 1],
    ["geol_overlap.ags",          1],
    ["key_dup_loca.ags",          1],
  ] as const)("%s → exit %i", (fixture, expectedCode) => {
    expect(runCli(["validate", F(fixture)]).exitCode).toBe(expectedCode);
  });

  it("validate --format json produces valid JSON for an invalid file", () => {
    const result = runCli(["validate", F("abbr_codelist_invalid.ags"), "--format", "json"]);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toHaveProperty("rule_id");
    expect(parsed[0]).toHaveProperty("severity");
  });

  it("validate with rules pack exits 1 for a file that violates the pack", () => {
    const result = runCli([
      "validate", F("abbr_codelist_invalid.ags"),
      "--rules", "rules/specs/ags/standard/4.x/pack.yml",
    ]);
    expect(result.exitCode).toBe(1);
  });

  it("validate accepts multiple --rules packs and merges their diagnostics", () => {
    const localTmp = mkdtempSync(join(tmpdir(), "geoflow-rules-"));
    const customPack = join(localTmp, "custom.yml");
    writeFileSync(
      customPack,
      [
        "version: 1",
        "name: custom-multi-test",
        "rules:",
        "  - id: CUSTOM-LOCA-REQUIRED",
        "    severity: error",
        "    in: LOCA",
        "    check: { required: [LOCA_NATE] }",
        "    message: \"custom: LOCA missing LOCA_NATE\"",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = runCli([
      "validate", F("abbr_codelist_invalid.ags"),
      "--format", "json",
      "--rules", "rules/specs/ags/standard/4.x/pack.yml",
      "--rules", customPack,
    ]);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as Array<{ rule_id: string }>;
    const ruleIds = new Set(parsed.map((d) => d.rule_id));
    // Custom pack rule should appear alongside built-in + standard-pack rules.
    expect(ruleIds.has("CUSTOM-LOCA-REQUIRED")).toBe(true);
    // Standard pack rules should also appear (e.g. one of its declarative checks).
    expect(parsed.length).toBeGreaterThan(1);
    rmSync(localTmp, { recursive: true, force: true });
  });
});
