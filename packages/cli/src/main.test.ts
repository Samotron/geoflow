import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { maskCosmetic } from "../../../tests/parity/whitelist.js";
import { PACKAGE_NAME, runCli } from "./main.js";

// Probe whether better-sqlite3 native bindings are usable in this environment.
const _sqliteAvailable = (() => {
  try {
    const req = createRequire(import.meta.url);
    const Sqlite = req("better-sqlite3");
    const probe = new Sqlite(":memory:");
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

const AGS_FIXTURE_DIR = resolve(import.meta.dirname, "../../../tests/fixtures/ags");
const DIGGS_FIXTURE_DIR = resolve(import.meta.dirname, "../../../tests/fixtures/diggs");
const CONVERT_BASELINE_DIR = resolve(import.meta.dirname, "../../../tests/parity/baselines/convert");

function normalizeConvertStdout(text: string): string {
  return maskCosmetic(text).replace(/ to .+$/m, " to <OUTFILE>");
}

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function normalizeTextOutput(text: string): string {
  // Normalise Windows backslash path separators before masking so the masked
  // relative path (e.g. tests/fixtures/...) uses forward slashes on all platforms.
  const masked = maskCosmetic(text.replace(/\\/g, "/")).trimEnd();
  const lines = masked.split("\n");
  const summaryIndex = lines.findIndex((line) => line.startsWith("summary:"));
  if (summaryIndex === -1) {
    return masked;
  }

  const diagnostics = lines.slice(0, summaryIndex).filter((line) => line.length > 0).sort();
  const summary = lines.slice(summaryIndex).join("\n");
  return [...diagnostics, "", summary].join("\n");
}

function normalizeJsonOutput(text: string): string {
  // Parse first (without masking) so JSON escape sequences are decoded to
  // real chars; then normalize path separators and mask at the field level.
  const parsed = JSON.parse(text) as Array<{
    rule_id: string;
    severity: string;
    message: string;
    location: {
      file: string | null;
      line: number | null;
      column: number | null;
      group: string | null;
      row_index: number | null;
    };
    fix_id?: string;
  }>;

  for (const item of parsed) {
    if (item.location.file !== null) {
      item.location.file = maskCosmetic(item.location.file.replace(/\\/g, "/"));
    }
  }

  parsed.sort((left, right) => {
    const leftKey = [
      left.rule_id,
      left.severity,
      left.message,
      left.location.file ?? "",
      left.location.group ?? "",
      left.location.line ?? -1,
      left.location.column ?? -1,
      left.location.row_index ?? -1,
      left.fix_id ?? "",
    ].join("\u0000");
    const rightKey = [
      right.rule_id,
      right.severity,
      right.message,
      right.location.file ?? "",
      right.location.group ?? "",
      right.location.line ?? -1,
      right.location.column ?? -1,
      right.location.row_index ?? -1,
      right.fix_id ?? "",
    ].join("\u0000");
    return leftKey.localeCompare(rightKey);
  });

  return JSON.stringify(parsed, null, 2);
}

describe("@geoflow/cli", () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@geoflow/cli");
  });

  it("renders validate text output for a clean file", () => {
    const file = resolve(AGS_FIXTURE_DIR, "minimal_valid.ags");
    const result = runCli(["validate", file]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("summary:");
    expect(result.stderr).toBe("");
  });

  it("renders info output for a clean file", () => {
    const file = resolve(AGS_FIXTURE_DIR, "minimal_valid.ags");
    const result = runCli(["info", file]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ags version: 4.1");
    expect(result.stdout).toContain("project: Synthetic minimal AGS file");
    expect(result.stderr).toBe("");
  });

  it("writes fixed output and diff log for the captured fix baseline", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "geoflow-fix-"));
    const file = join(tempDir, "temp_fixed.ags");
    const diffFile = join(tempDir, "temp_diff.json");
    writeFileSync(file, readFileSync(resolve(AGS_FIXTURE_DIR, "xref_multi_invalid.ags")));

    const baselineStdout = readFileSync(
      resolve(
        import.meta.dirname,
        "../../../tests/parity/baselines/fix/temp_fixed.ags/__write___diff_file__home_samotron_dev_geoflow_temp_diff_json_stdout.txt"
      ),
      "utf8"
    );
    const baselineDiff = readFileSync(
      resolve(
        import.meta.dirname,
        "../../../tests/parity/baselines/fix/temp_fixed.ags/__write___diff_file__home_samotron_dev_geoflow_temp_diff_json_artifacts/diff.json"
      ),
      "utf8"
    );
    const baselineFixed = readFileSync(
      resolve(
        import.meta.dirname,
        "../../../tests/parity/baselines/fix/temp_fixed.ags/__write___diff_file__home_samotron_dev_geoflow_temp_diff_json_artifacts/fixed.ags"
      ),
      "utf8"
    );

    const result = runCli(["fix", file, "--write", "--diff-file", diffFile]);
    expect(result.exitCode).toBe(0);
    const normalizedStdout = result.stdout
      .replaceAll(diffFile, "/home/samotron/dev/geoflow/temp_diff.json")
      .replaceAll(file, "/home/samotron/dev/geoflow/temp_fixed.ags");
    expect(maskCosmetic(normalizedStdout)).toBe(maskCosmetic(baselineStdout));
    expect(result.stderr).toBe("");
    expect(normalizeEol(readFileSync(diffFile, "utf8"))).toBe(normalizeEol(baselineDiff));
    expect(normalizeEol(readFileSync(file, "utf8"))).toBe(normalizeEol(baselineFixed));
  });

  it("returns validation failure exit code for invalid files", () => {
    const file = resolve(AGS_FIXTURE_DIR, "abbr_codelist_invalid.ags");
    const result = runCli(["validate", file]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("AGS-ABBR-001");
  });

  it("renders JSON output", () => {
    const file = resolve(AGS_FIXTURE_DIR, "empty_group.ags");
    const result = runCli(["validate", file, "--format", "json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"rule_id": "AGS-STRUCT-005"');
  });

  it("treats warnings as success when fail-on is error", () => {
    const file = resolve(AGS_FIXTURE_DIR, "empty_group.ags");
    const result = runCli(["validate", file, "--fail-on", "error"]);

    expect(result.exitCode).toBe(0);
  });

  it("returns usage errors for bad arguments", () => {
    const result = runCli(["validate", "--format", "json"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown validate option: json");
  });

  for (const fixture of [
    "abbr_codelist_invalid.ags",
    "abbr_codelist_valid.ags",
    "browser_explorer.ags",
    "encoding_win1252.ags",
    "empty_group.ags",
    "fixable.ags",
    "geol_overlap.ags",
    "ice_mini_invalid.ags",
    "ice_mini_valid.ags",
    "key_dup_loca.ags",
    "minimal_valid.ags",
    "nonstandard_heading.ags",
    "samp_key_dup.ags",
    "short_row.ags",
    "tran_ags_4_1_1.ags",
    "tran_ags_4_2.ags",
    "tran_version_warn.ags",
    "unit_codelist_invalid.ags",
    "unit_codelist_valid.ags",
    "xref_multi_invalid.ags",
  ]) {
    it(`matches Rust text baseline for ${fixture}`, () => {
      const file = resolve(AGS_FIXTURE_DIR, fixture);
      const baseline = readFileSync(
        resolve(import.meta.dirname, `../../../tests/parity/baselines/validate/${fixture}/stdout.txt`),
        "utf8"
      );
      const exit = Number(
        readFileSync(
          resolve(import.meta.dirname, `../../../tests/parity/baselines/validate/${fixture}/exit.txt`),
          "utf8"
        ).trim()
      );

      const result = runCli(["validate", file]);
      expect(result.exitCode).toBe(exit);
      expect(normalizeTextOutput(result.stdout)).toBe(normalizeTextOutput(baseline));
      expect(result.stderr).toBe("");
    });

    it(`matches Rust json baseline for ${fixture}`, () => {
      const file = resolve(AGS_FIXTURE_DIR, fixture);
      const baseline = readFileSync(
        resolve(import.meta.dirname, `../../../tests/parity/baselines/validate/${fixture}/__format_json_stdout.txt`),
        "utf8"
      );
      const exit = Number(
        readFileSync(
          resolve(import.meta.dirname, `../../../tests/parity/baselines/validate/${fixture}/__format_json_exit.txt`),
          "utf8"
        ).trim()
      );

      const result = runCli(["validate", file, "--format", "json"]);
      expect(result.exitCode).toBe(exit);
      expect(normalizeJsonOutput(result.stdout)).toBe(normalizeJsonOutput(baseline));
      expect(result.stderr).toBe("");
    });
  }

  for (const fixture of [
    "abbr_codelist_invalid.ags",
    "abbr_codelist_valid.ags",
    "browser_explorer.ags",
    "empty_group.ags",
    "encoding_win1252.ags",
    "fixable.ags",
    "geol_overlap.ags",
    "ice_mini_invalid.ags",
    "ice_mini_valid.ags",
    "key_dup_loca.ags",
    "minimal_valid.ags",
    "nonstandard_heading.ags",
    "samp_key_dup.ags",
    "sample_v3.ags",
    "short_row.ags",
    "tran_ags_4_1_1.ags",
    "tran_ags_4_2.ags",
    "tran_version_warn.ags",
    "unit_codelist_invalid.ags",
    "unit_codelist_valid.ags",
    "xref_multi_invalid.ags",
  ]) {
    it(`matches Rust info baseline for ${fixture}`, () => {
      const file = resolve(AGS_FIXTURE_DIR, fixture);
      const baseline = readFileSync(
        resolve(import.meta.dirname, `../../../tests/parity/baselines/info/${fixture}/stdout.txt`),
        "utf8"
      );
      const exit = Number(
        readFileSync(
          resolve(import.meta.dirname, `../../../tests/parity/baselines/info/${fixture}/exit.txt`),
          "utf8"
        ).trim()
      );

      const result = runCli(["info", file]);
      expect(result.exitCode).toBe(exit);
      expect(maskCosmetic(result.stdout).trimEnd()).toBe(maskCosmetic(baseline).trimEnd());
      expect(result.stderr).toBe("");
    });
  }

  for (const fixture of [
    "abbr_codelist_invalid.ags",
    "abbr_codelist_valid.ags",
    "browser_explorer.ags",
    "empty_group.ags",
    "encoding_win1252.ags",
    "fixable.ags",
    "geol_overlap.ags",
    "ice_mini_invalid.ags",
    "ice_mini_valid.ags",
    "key_dup_loca.ags",
    "minimal_valid.ags",
    "nonstandard_heading.ags",
    "samp_key_dup.ags",
    "sample_v3.ags",
    "short_row.ags",
    "tran_ags_4_1_1.ags",
    "tran_ags_4_2.ags",
    "tran_version_warn.ags",
    "unit_codelist_invalid.ags",
    "unit_codelist_valid.ags",
    "xref_multi_invalid.ags",
  ]) {
    it(`convert: matches Rust DIGGS output baseline for ${fixture}`, () => {
      const file = resolve(AGS_FIXTURE_DIR, fixture);
      const baseKey = "_home_samotron_dev_geoflow_temp_out_diggs___to_diggs";
      const baseDir = join(CONVERT_BASELINE_DIR, fixture);
      const baselineStdout = readFileSync(join(baseDir, `${baseKey}_stdout.txt`), "utf8");
      const baselineExit = Number(readFileSync(join(baseDir, `${baseKey}_exit.txt`), "utf8").trim());
      const baselineOutput = readFileSync(join(baseDir, `${baseKey}_artifacts`, "output.diggs"), "utf8");

      const tmpDir = mkdtempSync(join(tmpdir(), "geoflow-convert-"));
      const outFile = join(tmpDir, "output.diggs");
      try {
        const result = runCli(["convert", file, outFile, "--to", "diggs"]);
        expect(result.exitCode).toBe(baselineExit);
        expect(normalizeConvertStdout(result.stdout).trimEnd()).toBe(normalizeConvertStdout(baselineStdout).trimEnd());
        expect(result.stderr).toBe("");
        if (baselineExit === 0) {
          expect(normalizeEol(readFileSync(outFile, "utf8"))).toBe(normalizeEol(baselineOutput));
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  }

  it("convert: matches Rust AGS output baseline for minimal_subset.diggs", () => {
    const file = resolve(DIGGS_FIXTURE_DIR, "minimal_subset.diggs");
    const baseKey = "_home_samotron_dev_geoflow_temp_out_ags___to_ags";
    const baseDir = join(CONVERT_BASELINE_DIR, "minimal_subset.diggs");
    const baselineStdout = readFileSync(join(baseDir, `${baseKey}_stdout.txt`), "utf8");
    const baselineExit = Number(readFileSync(join(baseDir, `${baseKey}_exit.txt`), "utf8").trim());
    const baselineOutput = readFileSync(join(baseDir, `${baseKey}_artifacts`, "output.ags"), "utf8");

    const tmpDir = mkdtempSync(join(tmpdir(), "geoflow-convert-"));
    const outFile = join(tmpDir, "output.ags");
    try {
      const result = runCli(["convert", file, outFile, "--to", "ags"]);
      expect(result.exitCode).toBe(baselineExit);
      expect(normalizeConvertStdout(result.stdout).trimEnd()).toBe(normalizeConvertStdout(baselineStdout).trimEnd());
      expect(result.stderr).toBe("");
      if (baselineExit === 0) {
        expect(normalizeEol(readFileSync(outFile, "utf8"))).toBe(normalizeEol(baselineOutput));
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── report command ──────────────────────────────────────────────────────────

  describe("report command", () => {
    const fixture = resolve(AGS_FIXTURE_DIR, "minimal_valid.ags");

    it("succeeds with exit code 0 for valid file", () => {
      const result = runCli(["report", fixture]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    });

    it("produces text output containing report header", () => {
      const result = runCli(["report", fixture]);
      expect(result.stdout).toContain("GI Factual Report");
    });

    it("includes project name in text output", () => {
      const result = runCli(["report", fixture]);
      expect(result.stdout).toContain("Synthetic minimal AGS file");
    });

    it("includes borehole count in text output", () => {
      const result = runCli(["report", fixture]);
      expect(result.stdout).toContain("Exploratory holes:");
    });

    it("includes LOCA schedule when boreholes present", () => {
      const result = runCli(["report", fixture]);
      expect(result.stdout).toContain("BH01");
      expect(result.stdout).toContain("BH02");
    });

    it("includes geology summary when GEOL present", () => {
      const result = runCli(["report", fixture]);
      expect(result.stdout).toContain("Geological Units");
    });

    it("produces valid JSON with --format json", () => {
      const result = runCli(["report", fixture, "--format", "json"]);
      expect(result.exitCode).toBe(0);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toHaveProperty("projName");
      expect(parsed).toHaveProperty("totalHoles");
      expect(parsed).toHaveProperty("loca");
      expect(parsed).toHaveProperty("stats");
    });

    it("JSON output loca array has correct length", () => {
      const result = runCli(["report", fixture, "--format", "json"]);
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed.loca)).toBe(true);
      expect(parsed.loca.length).toBe(2);
    });

    it("writes report to file with --out", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "geoflow-report-"));
      const outFile = join(tmpDir, "report.txt");
      try {
        const result = runCli(["report", fixture, "--out", outFile]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(outFile);
        const content = readFileSync(outFile, "utf8");
        expect(content).toContain("GI Factual Report");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("writes JSON report to file with --out and --format json", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "geoflow-report-"));
      const outFile = join(tmpDir, "report.json");
      try {
        const result = runCli(["report", fixture, "--format", "json", "--out", outFile]);
        expect(result.exitCode).toBe(0);
        const content = readFileSync(outFile, "utf8");
        expect(() => JSON.parse(content)).not.toThrow();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns exit code 2 for missing file", () => {
      const result = runCli(["report", "/nonexistent/file.ags"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.length).toBeGreaterThan(0);
    });

    it("returns exit code 2 with usage on missing argument", () => {
      const result = runCli(["report"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("report requires");
    });

    it("returns exit code 2 for unknown flag", () => {
      const result = runCli(["report", fixture, "--unknown"]);
      expect(result.exitCode).toBe(2);
    });
  });

  // ── enhance command ─────────────────────────────────────────────────────────

  describe("enhance command", () => {
    const fixture = resolve(AGS_FIXTURE_DIR, "minimal_valid.ags");

    it("succeeds with exit code 0 on a file", () => {
      const result = runCli(["enhance", fixture]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    });

    it("includes GEOL row content in text output", () => {
      const result = runCli(["enhance", fixture]);
      expect(result.stdout).toContain("BH01");
      expect(result.stdout).toContain("CLAY");
    });

    it("parses --text inline description", () => {
      const result = runCli([
        "enhance",
        "--text",
        "Soft brown sandy CLAY with trace of gravel",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("primary soil: clay");
      expect(result.stdout).toContain("consistency:  soft");
    });

    it("produces valid JSON with --format json on --text input", () => {
      const result = runCli([
        "enhance",
        "--text",
        "Stiff grey CLAY",
        "--format",
        "json",
      ]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.primary_soil_type).toBe("clay");
      expect(parsed.consistency).toBe("stiff");
      expect(parsed.uscs).toBe("CL");
    });

    it("produces valid JSON array with --format json on a file", () => {
      const result = runCli(["enhance", fixture, "--format", "json"]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]).toHaveProperty("parsed");
      expect(parsed[0]).toHaveProperty("loca_id");
    });

    it("returns exit code 2 with usage on missing argument", () => {
      const result = runCli(["enhance"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("enhance requires");
    });

    it("returns exit code 2 for unknown flag", () => {
      const result = runCli(["enhance", fixture, "--unknown"]);
      expect(result.exitCode).toBe(2);
    });
  });

  // ── export command ──────────────────────────────────────────────────────────

  describe("export command", () => {
    const fixture = resolve(AGS_FIXTURE_DIR, "minimal_valid.ags");

    it("exports LOCA group as CSV to stdout", () => {
      const result = runCli(["export", fixture, "--group", "LOCA"]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const lines = result.stdout.split("\n").filter((l) => l.length > 0);
      // First line is header
      expect(lines[0]).toContain("LOCA_ID");
      // At least one data row
      expect(lines.length).toBeGreaterThanOrEqual(2);
    });

    it("CSV output contains correct borehole IDs", () => {
      const result = runCli(["export", fixture, "--group", "LOCA"]);
      expect(result.stdout).toContain("BH01");
      expect(result.stdout).toContain("BH02");
    });

    it("exports GEOL group as CSV", () => {
      const result = runCli(["export", fixture, "--group", "GEOL"]);
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.split("\n").filter((l) => l.length > 0);
      expect(lines[0]).toContain("LOCA_ID");
      expect(lines[0]).toContain("GEOL_TOP");
    });

    it("exports PROJ group as CSV", () => {
      const result = runCli(["export", fixture, "--group", "PROJ"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("PROJ_ID");
      expect(result.stdout).toContain("Synthetic minimal AGS file");
    });

    it("accepts lowercase --group name and upcases it", () => {
      const result = runCli(["export", fixture, "--group", "loca"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("LOCA_ID");
    });

    it("produces TSV output with --format tsv", () => {
      const result = runCli(["export", fixture, "--group", "LOCA", "--format", "tsv"]);
      expect(result.exitCode).toBe(0);
      const header = result.stdout.split("\n")[0]!;
      // TSV uses tabs, not commas
      expect(header).toContain("\t");
      expect(header).not.toContain(",");
    });

    it("writes CSV to file with --out", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "geoflow-export-"));
      const outFile = join(tmpDir, "loca.csv");
      try {
        const result = runCli(["export", fixture, "--group", "LOCA", "--out", outFile]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(outFile);
        const content = readFileSync(outFile, "utf8");
        expect(content).toContain("LOCA_ID");
        expect(content).toContain("BH01");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns exit code 2 for non-existent group", () => {
      const result = runCli(["export", fixture, "--group", "NONEXISTENT"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("NONEXISTENT");
    });

    it("returns exit code 2 when --group not specified", () => {
      const result = runCli(["export", fixture]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--group");
    });

    it("returns exit code 2 for missing file", () => {
      const result = runCli(["export", "/nonexistent/file.ags", "--group", "LOCA"]);
      expect(result.exitCode).toBe(2);
    });

    it("returns exit code 2 for unsupported format", () => {
      const result = runCli(["export", fixture, "--group", "LOCA", "--format", "xlsx"]);
      expect(result.exitCode).toBe(2);
    });
  });

  // ── db commands ─────────────────────────────────────────────────────────────

  describe("db commands (conditional on better-sqlite3)", () => {
    const sqliteAvailable = _sqliteAvailable;

    it.skipIf(!sqliteAvailable)("db ingest creates database and reports groups", () => {
      const fixture = resolve(AGS_FIXTURE_DIR, "minimal_valid.ags");
      const tmpDir = mkdtempSync(join(tmpdir(), "geoflow-db-cli-"));
      const dbFile = join(tmpDir, "test.gpkg");
      try {
        const result = runCli(["db", "ingest", fixture, dbFile]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("ingested");
        expect(result.stdout).toContain("LOCA");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it.skipIf(!sqliteAvailable)("db query returns LOCA data", () => {
      const fixture = resolve(AGS_FIXTURE_DIR, "minimal_valid.ags");
      const tmpDir = mkdtempSync(join(tmpdir(), "geoflow-db-cli-"));
      const dbFile = join(tmpDir, "test.gpkg");
      try {
        runCli(["db", "ingest", fixture, dbFile]);
        const result = runCli(["db", "query", "--db", dbFile, "--group", "LOCA"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("LOCA_ID");
        expect(result.stdout).toContain("BH01");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it.skipIf(!sqliteAvailable)("db list shows import records", () => {
      const fixture = resolve(AGS_FIXTURE_DIR, "minimal_valid.ags");
      const tmpDir = mkdtempSync(join(tmpdir(), "geoflow-db-cli-"));
      const dbFile = join(tmpDir, "test.gpkg");
      try {
        runCli(["db", "ingest", fixture, dbFile]);
        const result = runCli(["db", "list", dbFile]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("#1");
        expect(result.stdout).toContain("LOCA");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("db ingest returns exit code 2 for missing file", () => {
      const result = runCli(["db", "ingest", "/nonexistent.ags", "/tmp/out.gpkg"]);
      expect(result.exitCode).toBe(2);
    });

    it("db query requires --db flag", () => {
      const result = runCli(["db", "query", "--group", "LOCA"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--db");
    });

    it("db query requires --group flag", () => {
      const result = runCli(["db", "query", "--db", "/tmp/test.gpkg"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--group");
    });

    it("db list requires a db file argument", () => {
      const result = runCli(["db", "list"]);
      expect(result.exitCode).toBe(2);
    });

    it("db unknown subcommand returns exit code 2", () => {
      const result = runCli(["db", "frobnicate"]);
      expect(result.exitCode).toBe(2);
    });
  });
});
