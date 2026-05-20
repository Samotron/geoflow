import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Option } from "effect";
import {
  Format,
  Registry,
  Severity,
  activateCustomDict,
  assessQuality,
  buildGiReport,
  buildProjectSummary,
  decodeBytes,
  applyConflictResolutions,
  mergeAgsFilesN,
  toAgsi,
  deactivateCustomDict,
  diffFiles,
  diffToSummary,
  enhanceGeol,
  fixBytes,
  isIdentical,
  locationsToGeoJson,
  parseDescription,
  parseDictYaml,
  parseStr,
  readDiggs,
  renderDiffText,
  renderExplorerFromBytes,
  renderGiReportJson,
  renderGiReportText,
  renderInfo,
  renderQualityJson,
  renderQualityText,
  render,
  serialize,
  summarizeInfoBytes,
  validateFileBytes,
  writeDiggs,
} from "../../core/src/index.js";
import { evaluatePackYaml } from "../../rules-engine/src/index.js";
import * as dbModule from "../../db/src/index.js";
import type { GeoflowDb } from "../../db/src/index.js";
import type { Diagnostic } from "../../core/src/index.js";

export const PACKAGE_NAME = "@geoflow/cli";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function run(argv: readonly string[] = process.argv.slice(2)): number {
  const result = runCli(argv);
  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  return result.exitCode;
}

export const CLI_VERSION = "0.1.0";

export function runCli(argv: readonly string[]): RunResult {
  if (argv.length === 0) {
    return usageError("missing command");
  }

  const command = argv[0];
  switch (command) {
    case "info":
      return runInfo(argv.slice(1));
    case "fix":
      return runFix(argv.slice(1));
    case "validate":
      return runValidate(argv.slice(1));
    case "convert":
      return runConvert(argv.slice(1));
    case "diff":
      return runDiff(argv.slice(1));
    case "rules":
      return runRules(argv.slice(1));
    case "explore":
      return runExplore(argv.slice(1));
    case "quality":
      return runQualityCmd(argv.slice(1));
    case "report":
      return runReport(argv.slice(1));
    case "export":
      return runExport(argv.slice(1));
    case "enhance":
      return runEnhance(argv.slice(1));
    case "stats":
      return runStats(argv.slice(1));
    case "merge":
      return runMerge(argv.slice(1));
    case "validate-dir":
      return runValidateDir(argv.slice(1));
    case "agsi":
      return runAgsi(argv.slice(1));
    case "db":
      return runDb(argv.slice(1));
    case "--version":
    case "-V":
    case "version":
      return { exitCode: 0, stdout: `geoflow ${CLI_VERSION}\n`, stderr: "" };
    case "--help":
    case "-h":
    case "help":
      return {
        exitCode: 0,
        stdout: usageText(),
        stderr: "",
      };
    default:
      return usageError(`unknown command: ${command}`);
  }
}

function runInfo(argv: readonly string[]): RunResult {
  if (argv.length === 0) {
    return usageError("info requires a file path");
  }

  const file = argv[0]!;

  try {
    const resolved = resolve(file);
    const bytes = readFileSync(resolved);
    return {
      exitCode: 0,
      stdout: renderInfo(summarizeInfoBytes(bytes, resolved)),
      stderr: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${message}\n`,
    };
  }
}

function runFix(argv: readonly string[]): RunResult {
  if (argv.length === 0) {
    return usageError("fix requires a file path");
  }

  const file = argv[0]!;
  let write = false;
  let diffFile: string | null = null;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--write") {
      write = true;
      continue;
    }
    if (arg === "--diff-file") {
      const value = argv[++i];
      if (!value) {
        return usageError("--diff-file requires a value");
      }
      diffFile = value;
      continue;
    }
    return usageError(`unknown fix option: ${arg}`);
  }

  try {
    const resolved = resolve(file);
    const bytes = readFileSync(resolved);
    const result = fixBytes(bytes);

    let stdout = "";
    if (diffFile !== null) {
      const resolvedDiff = resolve(diffFile);
      writeFileSync(resolvedDiff, JSON.stringify(result.log, null, 2));
      stdout += `fix log written to ${resolvedDiff}\n`;
    }

    if (result.applied.length === 0) {
      stdout += `no fixes applied to ${resolved}\n`;
      return { exitCode: 0, stdout, stderr: "" };
    }

    const applied = [...result.applied].sort();
    stdout += `applied fixes to ${resolved}: ${JSON.stringify(applied)}\n`;
    if (write) {
      writeFileSync(resolved, result.output);
      stdout += "changes written to disk.\n";
    } else {
      stdout += "dry-run: no changes written. Use --write to apply.\n";
    }

    return { exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${message}\n`,
    };
  }
}

function runValidate(argv: readonly string[]): RunResult {
  if (argv.length === 0) {
    return usageError("validate requires a file path");
  }

  const file = argv[0]!;
  let format = Format.Text;
  let failOn = Severity.Error;
  const rulesPaths: string[] = [];
  let dictPath: string | null = null;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--format") {
      const value = argv[++i];
      if (!value) {
        return usageError("--format requires a value");
      }
      const parsed = Format.parse(value);
      if (parsed === null) {
        return usageError(`unsupported format: ${value}`);
      }
      format = parsed;
      continue;
    }

    if (arg === "--fail-on") {
      const value = argv[++i];
      if (!value) {
        return usageError("--fail-on requires a value");
      }
      const parsed = parseSeverity(value);
      if (parsed === null) {
        return usageError(`unsupported fail-on severity: ${value}`);
      }
      failOn = parsed;
      continue;
    }

    if (arg === "--rules") {
      const value = argv[++i];
      if (!value) {
        return usageError("--rules requires a path to a YAML rule pack");
      }
      rulesPaths.push(value);
      continue;
    }

    if (arg === "--dict") {
      const value = argv[++i];
      if (!value) {
        return usageError("--dict requires a path to a YAML dictionary");
      }
      dictPath = value;
      continue;
    }

    return usageError(`unknown validate option: ${arg}`);
  }

  let customDictActivated = false;
  try {
    if (dictPath !== null) {
      const yamlText = readFileSync(resolve(dictPath), "utf8");
      activateCustomDict(parseDictYaml(yamlText));
      customDictActivated = true;
    }

    const resolved = resolve(file);
    const bytes = readFileSync(resolved);
    const result = validateFileBytes(bytes, resolved, { format, failOn });

    // If --rules packs were supplied, evaluate them and merge diagnostics
    if (rulesPaths.length > 0) {
      const text = decodeBytes(bytes);
      const { file: agsFile } = parseStr(text);
      const packDiags: Diagnostic[] = [];

      for (const rulesPath of rulesPaths) {
        const yaml = readFileSync(resolve(rulesPath), "utf8");
        const pd = evaluatePackYaml(yaml, agsFile);
        for (const d of pd) {
          packDiags.push({
            rule_id: d.rule_id,
            severity: d.severity as Severity,
            message: d.message,
            location: {
              file: Option.some(resolved),
              line: Option.none(),
              column: Option.none(),
              group: d.location.group !== null ? Option.some(d.location.group) : Option.none(),
              row_index: d.location.row_index !== null ? Option.some(d.location.row_index) : Option.none(),
            },
            fix_id: Option.none(),
          });
        }
      }

      if (packDiags.length > 0) {
        const allDiags = [...result.diagnostics, ...packDiags];
        const threshold = severityRank(failOn);
        const exitCode = allDiags.some((d) => severityRank(d.severity) >= threshold) ? 1 : 0;
        return {
          exitCode,
          stdout: render(allDiags, format),
          stderr: "",
        };
      }
    }

    return {
      exitCode: result.exitCode,
      stdout: result.output,
      stderr: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${message}\n`,
    };
  } finally {
    if (customDictActivated) deactivateCustomDict();
  }
}

function severityRank(severity: Severity): number {
  switch (severity) {
    case Severity.Info: return 1;
    case Severity.Warning: return 2;
    case Severity.Error: return 3;
  }
}

function runConvert(argv: readonly string[]): RunResult {
  let toFormat: "ags" | "diggs" | null = null;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--to") {
      const value = argv[++i];
      if (!value) return usageError("--to requires a value (ags or diggs)");
      if (value !== "ags" && value !== "diggs") {
        return usageError(`unsupported --to format: ${value}`);
      }
      toFormat = value;
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 2) {
    return usageError("convert requires an input and output file path");
  }

  const [inFile, outFile] = positional as [string, string];

  if (toFormat === null) {
    const lower = inFile.toLowerCase();
    if (lower.endsWith(".ags")) toFormat = "diggs";
    else if (lower.endsWith(".diggs") || lower.endsWith(".xml")) toFormat = "ags";
    else return usageError("cannot infer --to format from file extension");
  }

  try {
    const resolvedIn = resolve(inFile);
    const resolvedOut = resolve(outFile);
    const inputBytes = readFileSync(resolvedIn);

    if (toFormat === "diggs") {
      const text = decodeBytes(inputBytes);
      const parsed = parseStr(text);
      const { xml } = writeDiggs(parsed.file);
      writeFileSync(resolvedOut, xml);
    } else {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(inputBytes);
      const agsFile = readDiggs(text);
      writeFileSync(resolvedOut, serialize(agsFile));
    }

    return {
      exitCode: 0,
      stdout: `converted ${resolvedIn} to ${resolvedOut}\n`,
      stderr: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, stdout: "", stderr: `${message}\n` };
  }
}

function runDiff(argv: readonly string[]): RunResult {
  let format = Format.Text;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--format") {
      const value = argv[++i];
      if (!value) return usageError("--format requires a value");
      const parsed = Format.parse(value);
      if (parsed === null) return usageError(`unsupported format: ${value}`);
      format = parsed;
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 2) {
    return usageError("diff requires exactly two file paths");
  }

  try {
    const [fileA, fileB] = positional as [string, string];
    const bytesA = readFileSync(resolve(fileA));
    const bytesB = readFileSync(resolve(fileB));
    const parsedA = parseStr(new TextDecoder().decode(bytesA));
    const parsedB = parseStr(new TextDecoder().decode(bytesB));
    const result = diffFiles(parsedA.file, parsedB.file);

    let stdout: string;
    if (format === Format.Json) {
      stdout = JSON.stringify(diffToSummary(result), null, 2) + "\n";
    } else {
      stdout = renderDiffText(result);
    }
    const exitCode = isIdentical(result) ? 0 : 1;
    return { exitCode, stdout, stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, stdout: "", stderr: `${message}\n` };
  }
}

const INSTALLED_PACKS = ["ags:standard@4.x", "ice:mini@0.1", "bgs:standard@1.x"] as const;

function runRules(argv: readonly string[]): RunResult {
  const subcommand = argv[0];
  if (!subcommand || subcommand === "list") {
    return runRulesList();
  }
  if (subcommand === "show") {
    const id = argv[1];
    if (!id) {
      return usageError("rules show requires a rule id");
    }
    return runRulesShow(id);
  }
  return usageError(`unknown rules subcommand: ${subcommand}`);
}

function runRulesList(): RunResult {
  const registry = Registry.standard();
  let stdout = "";
  for (const rule of registry.allRules()) {
    stdout += `${rule.id.padEnd(20)} ${rule.severity.padEnd(8)} ${rule.description}\n`;
  }
  for (const packRef of INSTALLED_PACKS) {
    stdout += `PACK ${packRef.padEnd(15)} installed rule pack\n`;
  }
  return { exitCode: 0, stdout, stderr: "" };
}

function runRulesShow(id: string): RunResult {
  const registry = Registry.standard();
  const rule = registry.find(id);
  if (!rule) {
    return { exitCode: 1, stdout: "", stderr: `unknown rule id ${JSON.stringify(id)}\n` };
  }
  const stdout = [
    `id:          ${rule.id}`,
    `severity:    ${rule.severity}`,
    `description: ${rule.description}`,
    "",
  ].join("\n");
  return { exitCode: 0, stdout, stderr: "" };
}

function runExplore(argv: readonly string[]): RunResult {
  if (argv.length === 0) {
    return usageError("explore requires a file path");
  }

  const file = argv[0]!;
  let outPath: string | null = null;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--out") {
      const value = argv[++i];
      if (!value) return usageError("--out requires a path");
      outPath = value;
      continue;
    }
    return usageError(`unknown explore option: ${arg}`);
  }

  try {
    const resolved = resolve(file);
    const bytes = readFileSync(resolved);
    const html = renderExplorerFromBytes(bytes, resolved);

    if (outPath !== null) {
      const resolvedOut = resolve(outPath);
      writeFileSync(resolvedOut, html);
      return { exitCode: 0, stdout: `explorer written to ${resolvedOut}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: html, stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, stdout: "", stderr: `${message}\n` };
  }
}

function runQualityCmd(argv: readonly string[]): RunResult {
  if (argv.length === 0) {
    return usageError("quality requires a file path");
  }

  const file = argv[0]!;
  let format: "text" | "json" = "text";
  let failOn: Severity | null = null;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--format") {
      const value = argv[++i];
      if (!value) return usageError("--format requires a value");
      if (value !== "text" && value !== "json") return usageError(`unsupported format: ${value}`);
      format = value;
      continue;
    }
    if (arg === "--fail-on") {
      const value = argv[++i];
      if (!value) return usageError("--fail-on requires a value");
      const parsed = parseSeverity(value);
      if (parsed === null) return usageError(`unsupported fail-on severity: ${value}`);
      failOn = parsed;
      continue;
    }
    return usageError(`unknown quality option: ${arg}`);
  }

  try {
    const resolved = resolve(file);
    const bytes = readFileSync(resolved);
    const text = decodeBytes(bytes);
    const { file: agsFile } = parseStr(text);
    const report = assessQuality(agsFile);

    const stdout = format === "json" ? renderQualityJson(report) : renderQualityText(report, resolved);

    let exitCode = 0;
    if (failOn !== null) {
      const threshold = severityRank(failOn);
      if (report.all_diagnostics.some((d) => severityRank(d.severity) >= threshold)) {
        exitCode = 1;
      }
    }

    return { exitCode, stdout, stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, stdout: "", stderr: `${message}\n` };
  }
}

function runReport(argv: readonly string[]): RunResult {
  if (argv.length === 0) {
    return usageError("report requires a file path");
  }

  const file = argv[0]!;
  let format: "text" | "json" = "text";
  let outPath: string | null = null;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--format") {
      const value = argv[++i];
      if (!value) return usageError("--format requires a value");
      if (value !== "text" && value !== "json") return usageError(`unsupported format: ${value}`);
      format = value;
      continue;
    }
    if (arg === "--out") {
      const value = argv[++i];
      if (!value) return usageError("--out requires a path");
      outPath = value;
      continue;
    }
    return usageError(`unknown report option: ${arg}`);
  }

  try {
    const resolved = resolve(file);
    const bytes = readFileSync(resolved);
    const text = decodeBytes(bytes);
    const { file: agsFile } = parseStr(text);
    const report = buildGiReport(agsFile);
    const output = format === "json" ? renderGiReportJson(report) : renderGiReportText(report, resolved);

    if (outPath !== null) {
      const resolvedOut = resolve(outPath);
      writeFileSync(resolvedOut, output);
      return { exitCode: 0, stdout: `report written to ${resolvedOut}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: output, stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, stdout: "", stderr: `${message}\n` };
  }
}

function runExport(argv: readonly string[]): RunResult {
  if (argv.length === 0) {
    return usageError("export requires a file path");
  }

  const file = argv[0]!;
  let groupName: string | null = null;
  let format: "csv" | "tsv" | "geojson" = "csv";
  let outPath: string | null = null;
  let crs: string | null = null;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--group") {
      const value = argv[++i];
      if (!value) return usageError("--group requires a group name");
      groupName = value.toUpperCase();
      continue;
    }
    if (arg === "--format") {
      const value = argv[++i];
      if (!value) return usageError("--format requires a value");
      if (value !== "csv" && value !== "tsv" && value !== "geojson") {
        return usageError(`unsupported export format: ${value}`);
      }
      format = value;
      continue;
    }
    if (arg === "--out") {
      const value = argv[++i];
      if (!value) return usageError("--out requires a path");
      outPath = value;
      continue;
    }
    if (arg === "--crs") {
      const value = argv[++i];
      if (!value) return usageError("--crs requires a value (e.g. EPSG:27700)");
      crs = value;
      continue;
    }
    return usageError(`unknown export option: ${arg}`);
  }

  if (format !== "geojson" && groupName === null) {
    return usageError("export requires --group <name> (unless --format geojson)");
  }

  try {
    const resolved = resolve(file);
    const bytes = readFileSync(resolved);
    const text = decodeBytes(bytes);
    const { file: agsFile } = parseStr(text);

    if (format === "geojson") {
      const collection = locationsToGeoJson(
        agsFile,
        crs !== null ? { crs } : {},
      );
      const output = JSON.stringify(collection, null, 2) + "\n";
      if (outPath !== null) {
        const resolvedOut = resolve(outPath);
        writeFileSync(resolvedOut, output);
        return {
          exitCode: 0,
          stdout: `exported ${collection.features.length} location(s) to ${resolvedOut}\n`,
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: output, stderr: "" };
    }

    const group = agsFile.groups[groupName!];

    if (!group) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `group ${JSON.stringify(groupName)} not found in ${resolved}\n`,
      };
    }

    const sep = format === "tsv" ? "\t" : ",";
    const escape = format === "csv"
      ? (v: string) => {
          if (v.includes(",") || v.includes('"') || v.includes("\n")) {
            return `"${v.replace(/"/g, '""')}"`;
          }
          return v;
        }
      : (v: string) => v;

    const headingNames = group.headings.map((h) => h.name);
    const csvLines: string[] = [];
    csvLines.push(headingNames.map(escape).join(sep));
    for (const row of group.rows) {
      const cells = headingNames.map((name) => {
        const v = row[name];
        return escape(v == null ? "" : String(v));
      });
      csvLines.push(cells.join(sep));
    }
    const output = csvLines.join("\n") + "\n";

    if (outPath !== null) {
      const resolvedOut = resolve(outPath);
      writeFileSync(resolvedOut, output);
      return { exitCode: 0, stdout: `exported ${groupName} to ${resolvedOut}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: output, stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, stdout: "", stderr: `${message}\n` };
  }
}

function runStats(argv: readonly string[]): RunResult {
  if (argv.length === 0) {
    return usageError("stats requires a file path");
  }

  const file = argv[0]!;
  let format: "text" | "json" = "text";

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--format") {
      const value = argv[++i];
      if (!value) return usageError("--format requires a value");
      if (value !== "text" && value !== "json") return usageError(`unsupported format: ${value}`);
      format = value;
      continue;
    }
    return usageError(`unknown stats option: ${arg}`);
  }

  try {
    const resolved = resolve(file);
    const bytes = readFileSync(resolved);
    const text = decodeBytes(bytes);
    const { file: agsFile } = parseStr(text);
    const summary = buildProjectSummary(agsFile);

    if (format === "json") {
      const payload = {
        source: resolved,
        groups: summary.totals.groups,
        boreholes: summary.totals.boreholes,
        total_metres: round(summary.depth.totalMetres, 2),
        mean_depth_m: round(summary.depth.meanDepthM, 2),
        max_depth_m: round(summary.depth.maxDepthM, 2),
        strata: summary.totals.strata,
        samples: summary.totals.samples,
        spt_tests: summary.totals.sptTests,
        water_strikes: summary.totals.waterStrikes,
        hole_types: summary.holeTypes,
        units: summary.units.map((u) => ({
          code: u.code,
          occurrences: u.occurrences,
          total_thickness_m: round(u.totalThicknessM, 2),
          mean_thickness_m: round(u.meanThicknessM, 2),
          in_holes: u.inHoles,
        })),
      };
      return { exitCode: 0, stdout: JSON.stringify(payload, null, 2) + "\n", stderr: "" };
    }

    const lines: string[] = [];
    lines.push(`file:                 ${resolved}`);
    if (summary.project.projName) lines.push(`project:              ${summary.project.projName}`);
    if (summary.project.projId)   lines.push(`project id:           ${summary.project.projId}`);
    lines.push(`groups:               ${summary.totals.groups}`);
    lines.push(`boreholes:            ${summary.totals.boreholes}`);
    lines.push(`total metres drilled: ${round(summary.depth.totalMetres, 2)}`);
    lines.push(`mean / max depth:     ${round(summary.depth.meanDepthM, 2)} m  /  ${round(summary.depth.maxDepthM, 2)} m`);
    lines.push(`strata logged:        ${summary.totals.strata}`);
    lines.push(`samples:              ${summary.totals.samples}`);
    lines.push(`SPT tests:            ${summary.totals.sptTests}`);
    lines.push(`water strikes:        ${summary.totals.waterStrikes}`);
    const holeTypeEntries = Object.entries(summary.holeTypes);
    if (holeTypeEntries.length > 0) {
      lines.push("hole types:");
      for (const [t, n] of holeTypeEntries) lines.push(`  ${t.padEnd(8)} ${n}`);
    }
    if (summary.units.length > 0) {
      lines.push("top units (by total thickness):");
      for (const u of summary.units.slice(0, 8)) {
        lines.push(`  ${u.code.padEnd(8)} ${u.occurrences.toString().padStart(3)} layers · ${round(u.totalThicknessM, 1).toString().padStart(6)} m · in ${u.inHoles} hole(s)`);
      }
    }
    lines.push("");
    return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, stdout: "", stderr: `${message}\n` };
  }
}

function round(n: number, dp: number): number {
  const m = Math.pow(10, dp);
  return Math.round(n * m) / m;
}

// ── merge ───────────────────────────────────────────────────────────────────

function runMerge(argv: readonly string[]): RunResult {
  const positional: string[] = [];
  let outPath: string | null = null;
  let onConflict: "ours" | "theirs" | "abort" = "theirs";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--out") {
      const value = argv[++i];
      if (!value) return usageError("--out requires a path");
      outPath = value;
      continue;
    }
    if (arg === "--on-conflict") {
      const value = argv[++i];
      if (!value) return usageError("--on-conflict requires a value");
      if (value !== "ours" && value !== "theirs" && value !== "abort") {
        return usageError(`unsupported --on-conflict value: ${value}`);
      }
      onConflict = value;
      continue;
    }
    if (arg.startsWith("--")) {
      return usageError(`unknown merge option: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length < 2) {
    return usageError("merge requires at least two input file paths");
  }

  try {
    const files = positional.map((p) => {
      const r = resolve(p);
      const bytes = readFileSync(r);
      return { path: r, file: parseStr(decodeBytes(bytes)).file };
    });

    const { merged, conflicts } = mergeAgsFilesN(files.map((f) => f.file));

    if (conflicts.length > 0 && onConflict === "abort") {
      let stderr = `${conflicts.length} merge conflict(s); aborted (use --on-conflict ours|theirs to override).\n`;
      for (const c of conflicts.slice(0, 10)) {
        stderr += `  ${c.group} ${JSON.stringify(c.primaryKey)}\n`;
      }
      if (conflicts.length > 10) stderr += `  …and ${conflicts.length - 10} more\n`;
      return { exitCode: 1, stdout: "", stderr };
    }

    // If user picked "ours", re-apply oursRow over the auto-resolved theirs.
    const resolved = onConflict === "ours"
      ? applyOursResolutionsToMerged(merged, conflicts)
      : merged;

    const output = serialize(resolved);
    let stdout = "";
    if (outPath !== null) {
      const r = resolve(outPath);
      writeFileSync(r, output);
      stdout += `merged ${files.length} file(s) into ${r}\n`;
    } else {
      stdout = output;
    }
    if (conflicts.length > 0) {
      const note = `  ${conflicts.length} conflict(s) auto-resolved with "${onConflict}".\n`;
      if (outPath !== null) stdout += note;
      else process.stderr.write(note);
    }
    return { exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, stdout: "", stderr: `${message}\n` };
  }
}

function applyOursResolutionsToMerged(
  merged: ReturnType<typeof mergeAgsFilesN>["merged"],
  conflicts: ReturnType<typeof mergeAgsFilesN>["conflicts"],
): ReturnType<typeof mergeAgsFilesN>["merged"] {
  if (conflicts.length === 0) return merged;
  const withOurs = conflicts.map((c) => ({ ...c, resolvedRow: c.oursRow }));
  return applyConflictResolutions(merged, withOurs);
}

// ── validate-dir ────────────────────────────────────────────────────────────

function runValidateDir(argv: readonly string[]): RunResult {
  if (argv.length === 0) {
    return usageError("validate-dir requires a directory path");
  }

  let dir: string | null = null;
  let format: "text" | "json" = "text";
  let failOn = Severity.Error;
  let recursive = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--format") {
      const value = argv[++i];
      if (!value) return usageError("--format requires a value");
      if (value !== "text" && value !== "json") return usageError(`unsupported format: ${value}`);
      format = value;
      continue;
    }
    if (arg === "--fail-on") {
      const value = argv[++i];
      if (!value) return usageError("--fail-on requires a value");
      const parsed = parseSeverity(value);
      if (parsed === null) return usageError(`unsupported fail-on severity: ${value}`);
      failOn = parsed;
      continue;
    }
    if (arg === "--no-recursive") {
      recursive = false;
      continue;
    }
    if (arg.startsWith("--")) {
      return usageError(`unknown validate-dir option: ${arg}`);
    }
    if (dir !== null) {
      return usageError("validate-dir takes a single directory path");
    }
    dir = arg;
  }
  if (dir === null) return usageError("validate-dir requires a directory path");

  try {
    const resolved = resolve(dir);
    const files = listAgsFiles(resolved, recursive);
    if (files.length === 0) {
      return {
        exitCode: 0,
        stdout: format === "json" ? "[]\n" : `no .ags files found under ${resolved}\n`,
        stderr: "",
      };
    }

    interface FileResult {
      file: string;
      errors: number;
      warnings: number;
      infos: number;
      exitCode: number;
    }
    const results: FileResult[] = [];
    const threshold = severityRank(failOn);

    for (const f of files) {
      try {
        const bytes = readFileSync(f);
        const r = validateFileBytes(bytes, f, { format: Format.Json, failOn });
        let errors = 0, warnings = 0, infos = 0;
        for (const d of r.diagnostics) {
          if (d.severity === Severity.Error) errors++;
          else if (d.severity === Severity.Warning) warnings++;
          else infos++;
        }
        results.push({
          file: f,
          errors,
          warnings,
          infos,
          exitCode: r.diagnostics.some((d) => severityRank(d.severity) >= threshold) ? 1 : 0,
        });
      } catch {
        results.push({
          file: f,
          errors: 1,
          warnings: 0,
          infos: 0,
          exitCode: 2,
        });
      }
    }

    const overallExit = results.some((r) => r.exitCode !== 0) ? 1 : 0;

    if (format === "json") {
      const payload = {
        directory: resolved,
        files_checked: results.length,
        overall_exit_code: overallExit,
        results,
      };
      return { exitCode: overallExit, stdout: JSON.stringify(payload, null, 2) + "\n", stderr: "" };
    }

    const lines: string[] = [];
    lines.push(`Validating ${results.length} file(s) under ${resolved}:`);
    lines.push("");
    let pass = 0, fail = 0;
    for (const r of results) {
      const tag = r.exitCode === 0 ? "✓" : r.exitCode === 1 ? "✗" : "!";
      const counts = `${r.errors}E ${r.warnings}W ${r.infos}I`;
      lines.push(`  ${tag} ${counts.padEnd(12)} ${r.file}`);
      if (r.exitCode === 0) pass++; else fail++;
    }
    lines.push("");
    lines.push(`summary: ${pass} pass, ${fail} fail`);
    lines.push("");
    return { exitCode: overallExit, stdout: lines.join("\n"), stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, stdout: "", stderr: `${message}\n` };
  }
}

function listAgsFiles(root: string, recursive: boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (recursive) walk(p);
      } else if (s.isFile() && name.toLowerCase().endsWith(".ags")) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out.sort();
}

// ── agsi ────────────────────────────────────────────────────────────────────

function runAgsi(argv: readonly string[]): RunResult {
  if (argv.length === 0) {
    return usageError("agsi requires a file path");
  }

  const file = argv[0]!;
  let outPath: string | null = null;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--out") {
      const value = argv[++i];
      if (!value) return usageError("--out requires a path");
      outPath = value;
      continue;
    }
    return usageError(`unknown agsi option: ${arg}`);
  }

  try {
    const resolved = resolve(file);
    const bytes = readFileSync(resolved);
    const { file: agsFile } = parseStr(decodeBytes(bytes));
    const doc = toAgsi(agsFile);
    const output = JSON.stringify(doc, null, 2) + "\n";

    if (outPath !== null) {
      const r = resolve(outPath);
      writeFileSync(r, output);
      return {
        exitCode: 0,
        stdout: `AGSi exported to ${r} (${doc.modelInstances.length} model instances, ${doc.geologicalUnits.length} units)\n`,
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: output, stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, stdout: "", stderr: `${message}\n` };
  }
}

function runEnhance(argv: readonly string[]): RunResult {
  if (argv.length === 0) {
    return usageError("enhance requires a file path or --text \"<description>\"");
  }

  let format: "text" | "json" = "text";
  let outPath: string | null = null;
  let inlineText: string | null = null;
  let filePath: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--format") {
      const value = argv[++i];
      if (!value) return usageError("--format requires a value");
      if (value !== "text" && value !== "json") return usageError(`unsupported format: ${value}`);
      format = value;
      continue;
    }
    if (arg === "--out") {
      const value = argv[++i];
      if (!value) return usageError("--out requires a path");
      outPath = value;
      continue;
    }
    if (arg === "--text") {
      const value = argv[++i];
      if (value === undefined) return usageError("--text requires a description string");
      inlineText = value;
      continue;
    }
    if (arg.startsWith("--")) {
      return usageError(`unknown enhance option: ${arg}`);
    }
    filePath = arg;
  }

  try {
    if (inlineText !== null) {
      const parsed = parseDescription(inlineText);
      const output = format === "json"
        ? JSON.stringify(parsed, null, 2) + "\n"
        : renderDescriptionText(parsed);
      if (outPath !== null) {
        writeFileSync(resolve(outPath), output);
        return { exitCode: 0, stdout: `enhance result written to ${resolve(outPath)}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: output, stderr: "" };
    }

    if (filePath === null) {
      return usageError("enhance requires a file path or --text \"<description>\"");
    }

    const resolved = resolve(filePath);
    const bytes = readFileSync(resolved);
    const text = decodeBytes(bytes);
    const { file: agsFile } = parseStr(text);
    const rows = enhanceGeol(agsFile);

    const output = format === "json"
      ? JSON.stringify(rows, null, 2) + "\n"
      : renderEnhanceText(rows, resolved);

    if (outPath !== null) {
      writeFileSync(resolve(outPath), output);
      return { exitCode: 0, stdout: `enhance results written to ${resolve(outPath)}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: output, stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, stdout: "", stderr: `${message}\n` };
  }
}

function renderDescriptionText(desc: ReturnType<typeof parseDescription>): string {
  const lines: string[] = [];
  lines.push(`raw:          ${desc.raw}`);
  lines.push(`material:     ${desc.material_type}`);
  if (desc.primary_soil_type) lines.push(`primary soil: ${desc.primary_soil_type}`);
  if (desc.secondary_soil_type) lines.push(`secondary:    ${desc.secondary_soil_type}`);
  if (desc.rock_type) lines.push(`rock type:    ${desc.rock_type}`);
  if (desc.consistency) lines.push(`consistency:  ${desc.consistency}`);
  if (desc.density) lines.push(`density:      ${desc.density}`);
  if (desc.moisture) lines.push(`moisture:     ${desc.moisture}`);
  if (desc.particle_size) lines.push(`particle:     ${desc.particle_size}`);
  if (desc.plasticity) lines.push(`plasticity:   ${desc.plasticity}`);
  if (desc.weathering) lines.push(`weathering:   ${desc.weathering}`);
  if (desc.rock_strength) lines.push(`rock strength:${desc.rock_strength}`);
  if (desc.bedding_spacing) lines.push(`bedding:      ${desc.bedding_spacing}`);
  if (desc.colours.length > 0) lines.push(`colours:      ${desc.colours.join(", ")}`);
  if (desc.structures.length > 0) lines.push(`structure:    ${desc.structures.join(", ")}`);
  if (desc.inclusions.length > 0) lines.push(`inclusions:   ${desc.inclusions.join(", ")}`);
  if (desc.secondary_constituents.length > 0) {
    const parts = desc.secondary_constituents.map((c) => `${c.proportion} ${c.soil_type}`);
    lines.push(`constituents: ${parts.join(", ")}`);
  }
  if (desc.uscs) lines.push(`USCS:         ${desc.uscs}`);
  if (desc.strength_params) {
    const sp = desc.strength_params;
    const params: string[] = [];
    if (sp.cu_min_kpa !== undefined) params.push(`cu=${sp.cu_min_kpa}–${sp.cu_max_kpa ?? "∞"} kPa`);
    if (sp.spt_n_min !== undefined) params.push(`N=${sp.spt_n_min}–${sp.spt_n_max} blows/300mm`);
    if (sp.phi_min_deg !== undefined) params.push(`ϕ'=${sp.phi_min_deg}–${sp.phi_max_deg}°`);
    if (sp.ucs_min_mpa !== undefined) params.push(`UCS=${sp.ucs_min_mpa}–${sp.ucs_max_mpa ?? "∞"} MPa`);
    if (sp.unit_weight_min !== undefined) params.push(`γ=${sp.unit_weight_min}–${sp.unit_weight_max} kN/m³`);
    if (params.length > 0) lines.push(`derived:      ${params.join(", ")}`);
  }
  lines.push(`confidence:   ${desc.confidence.toFixed(2)}`);
  if (desc.warnings.length > 0) {
    lines.push(`warnings:     ${desc.warnings.join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderEnhanceText(
  rows: ReturnType<typeof enhanceGeol>,
  resolved: string
): string {
  if (rows.length === 0) {
    return `no GEOL_DESC rows in ${resolved}\n`;
  }
  const out: string[] = [];
  out.push(`enhanced ${rows.length} GEOL row(s) from ${resolved}`);
  out.push("");
  for (const row of rows) {
    const top = row.geol_top !== undefined ? row.geol_top.toFixed(2) : "?";
    const base = row.geol_base !== undefined ? row.geol_base.toFixed(2) : "?";
    out.push(`${row.loca_id} ${top}–${base} m`);
    out.push(`  ${row.geol_desc}`);
    const d = row.parsed;
    const summary: string[] = [];
    if (d.is_made_ground) summary.push("MADE GROUND");
    if (d.consistency) summary.push(d.consistency);
    if (d.density) summary.push(d.density);
    if (d.rock_strength) summary.push(d.rock_strength);
    if (d.weathering) summary.push(d.weathering);
    if (d.colours.length > 0) summary.push(d.colours.join("/"));
    if (d.primary_soil_type) summary.push(d.primary_soil_type.toUpperCase());
    if (d.rock_type) summary.push(d.rock_type.toUpperCase());
    if (d.inclusions.length > 0) summary.push(`+ ${d.inclusions.join(", ")}`);
    if (d.uscs) summary.push(`[${d.uscs}]`);
    out.push(`  → ${summary.join(" · ")}  (conf=${d.confidence.toFixed(2)})`);
    out.push("");
  }
  return out.join("\n");
}

function runDb(argv: readonly string[]): RunResult {
  const subcommand = argv[0];
  if (!subcommand || subcommand === "help") {
    return usageError("db requires a subcommand: ingest | query | list");
  }
  if (subcommand === "ingest") {
    return runDbIngest(argv.slice(1));
  }
  if (subcommand === "query") {
    return runDbQuery(argv.slice(1));
  }
  if (subcommand === "list") {
    return runDbList(argv.slice(1));
  }
  return usageError(`unknown db subcommand: ${subcommand}`);
}

function runDbIngest(argv: readonly string[]): RunResult {
  if (argv.length < 2) {
    return usageError("db ingest requires: <ags-file> <db-file>");
  }
  const [agsFile, dbFile] = [argv[0]!, argv[1]!];
  try {
    const { openDb } = getDbModule();
    const { decodeBytes: dec, parseStr: pStr } = { decodeBytes, parseStr };
    const bytes = readFileSync(resolve(agsFile));
    const { file } = pStr(dec(bytes));
    const db = openDb(resolve(dbFile));
    try {
      const report = db.ingest(file, resolve(agsFile));
      let stdout = `ingested ${report.groupsImported.length} group(s) from ${resolve(agsFile)} into ${resolve(dbFile)}\n`;
      stdout += `  LOCA rows: ${report.locaCount}\n`;
      stdout += `  Groups: ${report.groupsImported.join(", ")}\n`;
      return { exitCode: 0, stdout, stderr: "" };
    } finally {
      db.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, stdout: "", stderr: `${message}\n` };
  }
}

function runDbQuery(argv: readonly string[]): RunResult {
  let dbFile: string | null = null;
  let groupName: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--db") {
      dbFile = argv[++i] ?? null;
      if (!dbFile) return usageError("--db requires a path");
    } else if (arg === "--group") {
      groupName = argv[++i] ?? null;
      if (!groupName) return usageError("--group requires a name");
    } else {
      return usageError(`unknown db query option: ${arg}`);
    }
  }

  if (!dbFile) return usageError("db query requires --db <path>");
  if (!groupName) return usageError("db query requires --group <name>");

  try {
    const { openDb } = getDbModule();
    const db = openDb(resolve(dbFile));
    try {
      const result = db.queryGroup(groupName);
      if (result.columns.length === 0) {
        return { exitCode: 0, stdout: `(no rows in ${groupName})\n`, stderr: "" };
      }
      let stdout = result.columns.join("\t") + "\n";
      for (const row of result.rows) {
        stdout += row.map((v) => v ?? "").join("\t") + "\n";
      }
      return { exitCode: 0, stdout, stderr: "" };
    } finally {
      db.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, stdout: "", stderr: `${message}\n` };
  }
}

function runDbList(argv: readonly string[]): RunResult {
  const dbFile = argv[0];
  if (!dbFile) return usageError("db list requires <db-file>");
  try {
    const { openDb } = getDbModule();
    const db = openDb(resolve(dbFile));
    try {
      const imports = db.listImports();
      if (imports.length === 0) {
        return { exitCode: 0, stdout: "(no imports)\n", stderr: "" };
      }
      let stdout = "";
      for (const imp of imports) {
        stdout += `#${imp.id} ${imp.sourceFile} — ${imp.locaCount} LOCA — ${imp.importedAt}\n`;
      }
      return { exitCode: 0, stdout, stderr: "" };
    } finally {
      db.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, stdout: "", stderr: `${message}\n` };
  }
}

function getDbModule(): { openDb: (path: string) => GeoflowDb } {
  return dbModule;
}

function parseSeverity(value: string): Severity | null {
  switch (value) {
    case Severity.Info:
      return Severity.Info;
    case Severity.Warning:
      return Severity.Warning;
    case Severity.Error:
      return Severity.Error;
    default:
      return null;
  }
}

function usageError(message: string): RunResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `${message}\n${usageText()}`,
  };
}

function usageText(): string {
  return [
    "Usage:",
    "  geoflow info <file>",
    "  geoflow fix <file> [--write] [--diff-file <path>]",
    "  geoflow validate <file> [--format text|json|junit] [--fail-on error|warning|info] [--rules <pack.yml>] [--dict <dict.yml>]",
    "  geoflow validate-dir <dir> [--format text|json] [--fail-on error|warning|info] [--no-recursive]",
    "  geoflow merge <file1> <file2> [<file3>...] [--out <path>] [--on-conflict ours|theirs|abort]",
    "  geoflow agsi <file> [--out <path>]",
    "  geoflow convert <in> <out> [--to ags|diggs]",
    "  geoflow diff <file-a> <file-b> [--format text|json]",
    "  geoflow quality <file> [--format text|json] [--fail-on error|warning|info]",
    "  geoflow stats <file> [--format text|json]",
    "  geoflow report <file> [--format text|json] [--out <path>]",
    "  geoflow export <file> --group <name> [--format csv|tsv] [--out <path>]",
    "  geoflow export <file> --format geojson [--crs EPSG:27700] [--out <path>]",
    "  geoflow explore <file> [--out <path>]",
    "  geoflow enhance <file> [--format text|json] [--out <path>]",
    "  geoflow enhance --text \"<description>\" [--format text|json]",
    "  geoflow rules list",
    "  geoflow rules show <id>",
    "  geoflow db ingest <ags-file> <db-file>",
    "  geoflow db query --db <db-file> --group <name>",
    "  geoflow db list <db-file>",
    "",
    "  geoflow --version    Print version",
    "  geoflow --help       Print this help",
    "",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run());
}
