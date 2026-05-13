import { Option } from "effect";
import { decodeBytes, parseStr } from "./ags/parser.js";
import { Diagnostic, Severity } from "./diagnostics.js";
import { Format, render } from "./render.js";
import { Registry, validate } from "./validate.js";

export interface ValidateOptions {
  format?: Format;
  failOn?: Severity;
}

export interface ValidateResult {
  diagnostics: Diagnostic[];
  output: string;
  exitCode: 0 | 1;
}

export function validateText(text: string, options: ValidateOptions = {}): ValidateResult {
  return validateTextWithSource(text, undefined, options);
}

export function validateTextWithSource(
  text: string,
  sourcePath: string | undefined,
  options: ValidateOptions = {}
): ValidateResult {
  const parsed = parseStr(text);
  const diagnostics = [
    ...parsed.diagnostics,
    ...sortValidationDiagnostics(validate(parsed.file, Registry.standard())),
  ];
  if (sourcePath) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.location.file._tag === "None") {
        diagnostic.location.file = Option.some(sourcePath);
      }
    }
  }
  const format = options.format ?? Format.Text;
  const failOn = options.failOn ?? Severity.Error;

  return {
    diagnostics,
    output: render(diagnostics, format),
    exitCode: shouldFail(diagnostics, failOn) ? 1 : 0,
  };
}

export function validateBytes(bytes: Uint8Array, options: ValidateOptions = {}): ValidateResult {
  return validateTextWithSource(decodeBytes(bytes), undefined, options);
}

export function validateFileBytes(
  bytes: Uint8Array,
  sourcePath: string,
  options: ValidateOptions = {}
): ValidateResult {
  return validateTextWithSource(decodeBytes(bytes), sourcePath, options);
}

function shouldFail(diagnostics: readonly Diagnostic[], failOn: Severity): boolean {
  const threshold = severityRank(failOn);
  return diagnostics.some((diagnostic) => severityRank(diagnostic.severity) >= threshold);
}

function severityRank(severity: Severity): number {
  switch (severity) {
    case Severity.Info:
      return 1;
    case Severity.Warning:
      return 2;
    case Severity.Error:
      return 3;
  }
}

function sortValidationDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const ruleOrder = new Map<string, number>([
    ["AGS-DICT-004", 10],
    ["AGS-DICT-005", 20],
    ["AGS-HEAD-007", 30],
    ["AGS-HEAD-002", 40],
    ["AGS-TYPE-002", 50],
    ["AGS-VAL-002", 60],
  ]);

  return diagnostics
    .map((diagnostic, index) => ({ diagnostic, index }))
    .sort((left, right) => {
      const leftOrder = ruleOrder.get(left.diagnostic.rule_id) ?? 0;
      const rightOrder = ruleOrder.get(right.diagnostic.rule_id) ?? 0;
      if (leftOrder !== rightOrder) {
        if (leftOrder === 0 || rightOrder === 0) {
          return left.index - right.index;
        }
        return leftOrder - rightOrder;
      }

      return left.index - right.index;
    })
    .map(({ diagnostic }) => diagnostic);
}
