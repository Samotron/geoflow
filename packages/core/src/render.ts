import { Option } from "effect";
import { Diagnostic, Severity } from "./diagnostics.js";

export enum Format {
  Text = "text",
  Json = "json",
  Junit = "junit",
}

export namespace Format {
  export function parse(value: string): Format | null {
    switch (value) {
      case "text":
        return Format.Text;
      case "json":
        return Format.Json;
      case "junit":
        return Format.Junit;
      default:
        return null;
    }
  }
}

export function render(diagnostics: readonly Diagnostic[], format: Format): string {
  switch (format) {
    case Format.Text:
      return renderText(diagnostics);
    case Format.Json:
      return renderJson(diagnostics);
    case Format.Junit:
      return renderJunit(diagnostics);
  }
}

function renderText(diagnostics: readonly Diagnostic[]): string {
  let output = "";
  for (const diagnostic of diagnostics) {
    const location = formatLocation(diagnostic);
    const fix = Option.match(diagnostic.fix_id, {
      onNone: () => "",
      onSome: (value) => ` [auto-fixable: ${value}]`,
    });
    output += `${diagnostic.severity}: [${diagnostic.rule_id}] ${diagnostic.message}${location}${fix}\n`;
  }

  const counts = countSeverities(diagnostics);
  output += `\nsummary: ${counts.error} error, ${counts.warning} warning, ${counts.info} info\n`;
  return output;
}

function formatLocation(diagnostic: Diagnostic): string {
  const parts: string[] = [];
  Option.match(diagnostic.location.file, {
    onNone: () => undefined,
    onSome: (value) => parts.push(`file=${value}`),
  });
  Option.match(diagnostic.location.group, {
    onNone: () => undefined,
    onSome: (value) => parts.push(`group=${value}`),
  });
  Option.match(diagnostic.location.line, {
    onNone: () => undefined,
    onSome: (value) => parts.push(`line=${value}`),
  });

  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

function renderJson(diagnostics: readonly Diagnostic[]): string {
  const normalized = diagnostics.map((diagnostic) => {
    const base = {
      rule_id: diagnostic.rule_id,
      severity: diagnostic.severity,
      message: diagnostic.message,
      location: {
        file: optionToJsonValue(diagnostic.location.file),
        line: optionToJsonValue(diagnostic.location.line),
        column: optionToJsonValue(diagnostic.location.column),
        group: optionToJsonValue(diagnostic.location.group),
        row_index: optionToJsonValue(diagnostic.location.row_index),
      },
    } as Record<string, unknown>;

    if (diagnostic.fix_id._tag === "Some") {
      base.fix_id = diagnostic.fix_id.value;
    }

    return base;
  });

  return `${JSON.stringify(normalized, null, 2)}\n`;
}

function optionToJsonValue(value: { _tag: string; value?: unknown }): unknown {
  return value._tag === "Some" ? (value.value ?? null) : null;
}

function renderJunit(diagnostics: readonly Diagnostic[]): string {
  const counts = countSeverities(diagnostics);
  let output = '<?xml version="1.0" encoding="UTF-8"?>\n';
  output += `<testsuite name="geoflow" tests="${diagnostics.length}" failures="${counts.error}" errors="0" skipped="${counts.warning}">\n`;

  for (const diagnostic of diagnostics) {
    const name = xmlEscape(diagnostic.rule_id);
    const message = xmlEscape(diagnostic.message);
    const className = xmlEscape(
      Option.getOrElse(diagnostic.location.group, () => "file")
    );

    switch (diagnostic.severity) {
      case Severity.Error:
        output += `  <testcase classname="${className}" name="${name}">\n`;
        output += `    <failure message="${message}"/>\n`;
        output += "  </testcase>\n";
        break;
      case Severity.Warning:
        output += `  <testcase classname="${className}" name="${name}">\n`;
        output += `    <skipped message="${message}"/>\n`;
        output += "  </testcase>\n";
        break;
      case Severity.Info:
        output += `  <testcase classname="${className}" name="${name}">\n`;
        output += `    <system-out>${message}</system-out>\n`;
        output += "  </testcase>\n";
        break;
    }
  }

  output += "</testsuite>\n";
  return output;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function countSeverities(diagnostics: readonly Diagnostic[]) {
  let error = 0;
  let warning = 0;
  let info = 0;

  for (const diagnostic of diagnostics) {
    switch (diagnostic.severity) {
      case Severity.Error:
        error += 1;
        break;
      case Severity.Warning:
        warning += 1;
        break;
      case Severity.Info:
        info += 1;
        break;
    }
  }

  return { error, warning, info };
}
