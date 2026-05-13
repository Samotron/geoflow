import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Option } from "effect";
import {
  Format,
  Registry,
  Severity,
  decodeBytes,
  diffFiles,
  diffToSummary,
  fixBytes,
  isIdentical,
  parseStr,
  readDiggs,
  renderDiffText,
  renderExplorerFromBytes,
  renderInfo,
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
    case "db":
      return runDb(argv.slice(1));
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

    return usageError(`unknown validate option: ${arg}`);
  }

  try {
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

const INSTALLED_PACKS = ["ags:standard@4.x", "ice:mini@0.1"] as const;

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
    const { openDb } = await_import_db();
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
    const { openDb } = await_import_db();
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
    const { openDb } = await_import_db();
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

function await_import_db(): { openDb: (path: string) => GeoflowDb } {
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
    "  geoflow validate <file> [--format text|json|junit] [--fail-on error|warning|info] [--rules <pack.yml>]",
    "  geoflow convert <in> <out> [--to ags|diggs]",
    "  geoflow diff <file-a> <file-b> [--format text|json]",
    "  geoflow explore <file> [--out <path>]",
    "  geoflow rules list",
    "  geoflow rules show <id>",
    "  geoflow db ingest <ags-file> <db-file>",
    "  geoflow db query --db <db-file> --group <name>",
    "  geoflow db list <db-file>",
    "",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run());
}
