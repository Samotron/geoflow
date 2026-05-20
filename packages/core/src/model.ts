import type { Option} from "effect";
import { Schema } from "effect";

export type AgsType =
  | "X"
  | "XN"
  | "MC"
  | "ID"
  | "PA"
  | "PT"
  | "PU"
  | "T"
  | "DT"
  | "YN"
  | "RL"
  | "U"
  | "RECORD_LINK"
  | "DMS"
  | { _tag: "DP"; n: number }
  | { _tag: "SF"; n: number }
  | { _tag: "SCI"; n: number }
  | { _tag: "Other"; value: string };

/**
 * AGS 4.x data type codes (subset of those defined in the standard).
 */
export const AgsType = Schema.Union(
  Schema.Literal("X", "XN", "MC", "ID", "PA", "PT", "PU", "T", "DT", "YN", "RL", "U", "RECORD_LINK", "DMS"),
  Schema.Struct({ _tag: Schema.Literal("DP"), n: Schema.Number }),
  Schema.Struct({ _tag: Schema.Literal("SF"), n: Schema.Number }),
  Schema.Struct({ _tag: Schema.Literal("SCI"), n: Schema.Number }),
  Schema.Struct({ _tag: Schema.Literal("Other"), value: Schema.String })
);

export const AgsTypeFunctions = {
  parse(raw: string): AgsType {
    const s = raw.trim();
    const upper = s.toUpperCase();
    switch (upper) {
      case "X": return "X";
      case "XN": return "XN";
      case "MC": return "MC";
      case "ID": return "ID";
      case "PA": return "PA";
      case "PT": return "PT";
      case "PU": return "PU";
      case "T": return "T";
      case "DT": return "DT";
      case "YN": return "YN";
      case "RL": return "RL";
      case "U": return "U";
      case "RECORD_LINK": return "RECORD_LINK";
      case "DMS": return "DMS";
      default: {
        if (upper.endsWith("DP")) {
          const n = parseInt(upper.slice(0, -2), 10);
          if (!isNaN(n)) return { _tag: "DP", n };
        }
        if (upper.endsWith("SF")) {
          const n = parseInt(upper.slice(0, -2), 10);
          if (!isNaN(n)) return { _tag: "SF", n };
        }
        if (upper.endsWith("SCI")) {
          const n = parseInt(upper.slice(0, -3), 10);
          if (!isNaN(n)) return { _tag: "SCI", n };
        }
        return { _tag: "Other", value: upper };
      }
    }
  },

  isNumeric(type: AgsType): boolean {
    if (typeof type === "string") {
      return type === "XN" || type === "RL";
    }
    return type._tag === "DP" || type._tag === "SF" || type._tag === "SCI";
  },

  toString(type: AgsType): string {
    if (typeof type === "string") return type;
    if (type._tag === "Other") return type.value;
    return `${type.n}${type._tag}`;
  }
};

/**
 * A typed AGS value as stored in our in-memory model.
 */
export const AgsValue = Schema.Union(
  Schema.Null,
  Schema.Number,
  Schema.Boolean,
  Schema.String
);

export type AgsValue = null | number | boolean | string;

export const AgsValueFunctions = {
  asText(value: AgsValue): string | null {
    return typeof value === "string" ? value : null;
  },

  asNumber(value: AgsValue): number | null {
    return typeof value === "number" ? value : null;
  },

  isNull(value: AgsValue): boolean {
    return value === null;
  }
};

/**
 * A column definition in an AGS group.
 */
export interface AgsHeading {
  name: string;
  unit: string;
  data_type: AgsType;
}

export const AgsHeading = Schema.Struct({
  name: Schema.String,
  unit: Schema.String,
  data_type: AgsType,
});

/**
 * A row of typed values, indexed by heading name (preserving order).
 */
export interface AgsRow {
  [key: string]: AgsValue;
}

export const AgsRow = Schema.Record({ key: Schema.String, value: AgsValue });

/**
 * A single AGS group.
 */
export interface AgsGroup {
  name: string;
  headings: AgsHeading[];
  rows: AgsRow[];
  source_line: Option.Option<number>;
}

export const AgsGroup = Schema.Struct({
  name: Schema.String,
  headings: Schema.Array(AgsHeading),
  rows: Schema.Array(AgsRow),
  source_line: Schema.Option(Schema.Number),
});

/**
 * A parsed AGS file: an ordered map of groups by name.
 */
export interface AgsFile {
  groups: Record<string, AgsGroup>;
  source_path: Option.Option<string>;
  ags_version: Option.Option<string>;
}

export const AgsFile = Schema.Struct({
  groups: Schema.Record({ key: Schema.String, value: AgsGroup }),
  source_path: Schema.Option(Schema.String),
  ags_version: Schema.Option(Schema.String),
});
