import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { maskCosmetic } from "../../../tests/parity/whitelist.js";
import { PACKAGE_NAME, runCli } from "./main.js";

const AGS_FIXTURE_DIR = resolve(import.meta.dirname, "../../../tests/fixtures/ags");
const DIGGS_FIXTURE_DIR = resolve(import.meta.dirname, "../../../tests/fixtures/diggs");
const CONVERT_BASELINE_DIR = resolve(import.meta.dirname, "../../../tests/parity/baselines/convert");

function normalizeConvertStdout(text: string): string {
  return maskCosmetic(text).replace(/ to .+$/m, " to <OUTFILE>");
}

function normalizeTextOutput(text: string): string {
  const masked = maskCosmetic(text).trimEnd();
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
  const parsed = JSON.parse(maskCosmetic(text)) as Array<{
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
    expect(readFileSync(diffFile, "utf8")).toBe(baselineDiff);
    expect(readFileSync(file, "utf8")).toBe(baselineFixed);
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
          expect(readFileSync(outFile, "utf8")).toBe(baselineOutput);
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
        expect(readFileSync(outFile, "utf8")).toBe(baselineOutput);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
