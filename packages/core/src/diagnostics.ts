import { Option, Schema } from "effect";

/**
 * Severity of a diagnostic.
 */
export enum Severity {
  Info = "info",
  Warning = "warning",
  Error = "error",
}

export const SeveritySchema = Schema.Enums(Severity);

/**
 * Source location for a diagnostic.
 */
export interface Location {
  file: Option.Option<string>;
  line: Option.Option<number>;
  column: Option.Option<number>;
  group: Option.Option<string>;
  row_index: Option.Option<number>;
}

export const Location = Schema.Struct({
  file: Schema.Option(Schema.String),
  line: Schema.Option(Schema.Number),
  column: Schema.Option(Schema.Number),
  group: Schema.Option(Schema.String),
  row_index: Schema.Option(Schema.Number),
});

/**
 * A diagnostic produced by parsing or validation.
 */
export interface Diagnostic {
  rule_id: string;
  severity: Severity;
  message: string;
  location: Location;
  fix_id: Option.Option<string>;
}

export const Diagnostic = Schema.Struct({
  rule_id: Schema.String,
  severity: SeveritySchema,
  message: Schema.String,
  location: Location,
  fix_id: Schema.Option(Schema.String),
});

export class DiagnosticBuilder {
  private diag: Diagnostic;

  constructor(ruleId: string, severity: Severity, message: string) {
    this.diag = {
      rule_id: ruleId,
      severity,
      message,
      location: {
        file: Option.none(),
        line: Option.none(),
        column: Option.none(),
        group: Option.none(),
        row_index: Option.none(),
      },
      fix_id: Option.none(),
    };
  }

  atLine(line: number): this {
    this.diag.location.line = Option.some(line);
    return this;
  }

  atGroup(group: string): this {
    this.diag.location.group = Option.some(group);
    return this;
  }

  atFile(file: string): this {
    this.diag.location.file = Option.some(file);
    return this;
  }

  withFix(fixId: string): this {
    this.diag.fix_id = Option.some(fixId);
    return this;
  }

  build(): Diagnostic {
    return this.diag;
  }
}
