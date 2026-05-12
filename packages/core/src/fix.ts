import { serialize } from "./ags/serializer.js";
import { decodeBytes, parseStr } from "./ags/parser.js";

export interface FixInspection {
  findings: string[];
}

export type FixChangeKind = "cell_value";

export interface FixChange {
  fix: string;
  group: string;
  row_index?: number;
  heading?: string;
  before: string;
  after: string;
  kind: FixChangeKind;
}

export interface FixLog {
  changes: FixChange[];
}

export interface FixResult {
  applied: string[];
  output: string;
  log: FixLog;
}

export function inspectBytes(bytes: Uint8Array): FixInspection {
  const text = decodeBytes(bytes);
  const findings: string[] = [];
  if (text.includes("\n") && !text.includes("\r\n")) {
    findings.push("normalize-line-endings");
  }
  return { findings };
}

export function fixBytes(bytes: Uint8Array): FixResult {
  const originalText = decodeBytes(bytes);
  const inspection = inspectBytes(bytes);
  const parsed = parseStr(originalText);
  const output = stripNumericPadding(serialize(parsed.file));

  return {
    applied: [...inspection.findings],
    output,
    log: {
      changes: inspection.findings.map((fix) => ({
        fix,
        group: "",
        before: "",
        after: "(text-level normalisation)",
        kind: "cell_value",
      })),
    },
  };
}

function stripNumericPadding(text: string): string {
  return text.replace(/"(-?\d+\.\d+)"/g, (_match, value: string) => {
    const trimmed = value
      .replace(/(\.\d*?[1-9])0+$/u, "$1")
      .replace(/\.0+$/u, "");
    return `"${trimmed}"`;
  });
}
