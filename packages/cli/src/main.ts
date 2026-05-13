import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
  renderInfo,
  serialize,
  summarizeInfoBytes,
  validateFileBytes,
  writeDiggs,
} from "../../core/src/index.js";

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

    return usageError(`unknown validate option: ${arg}`);
  }

  try {
    const resolved = resolve(file);
    const bytes = readFileSync(resolved);
    const result = validateFileBytes(bytes, resolved, { format, failOn });
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
    "  geoflow validate <file> [--format text|json|junit] [--fail-on error|warning|info]",
    "  geoflow convert <in> <out> [--to ags|diggs]",
    "  geoflow diff <file-a> <file-b> [--format text|json]",
    "  geoflow rules list",
    "  geoflow rules show <id>",
    "",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run());
}
