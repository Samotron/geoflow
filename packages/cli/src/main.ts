import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Format, Severity, fixBytes, renderInfo, summarizeInfoBytes, validateFileBytes } from "../../core/src/index.js";

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
    "",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run());
}
