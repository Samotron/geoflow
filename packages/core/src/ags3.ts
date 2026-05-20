import { Option } from "effect";
import type { AgsFile, AgsGroup, AgsHeading, AgsRow, AgsType, AgsValue} from "./model.js";
import { AgsTypeFunctions } from "./model.js";

/**
 * Result of AGS 3 migration.
 */
export interface MigrateOutcome {
  file: AgsFile;
  /**
   * Human-readable notes about decisions made during migration.
   */
  notes: string[];
}

/**
 * Parse an AGS 3 text file and return an AgsFile in AGS 4 model form.
 *
 * Returns `null` if the text does not look like an AGS 3 file (no `**` group
 * lines found).
 */
export function migrateStr(text: string): MigrateOutcome | null {
  const lines = text.split(/\r?\n/);
  if (!lines.some((l) => l.startsWith("**"))) {
    return null;
  }

  const outcome: MigrateOutcome = {
    file: {
      groups: {},
      source_path: Option.none(),
      ags_version: Option.none(),
    },
    notes: [],
  };

  let currentBuilder: GroupBuilder | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    if (trimmed.startsWith("**")) {
      // Flush previous group.
      if (currentBuilder) {
        const g = currentBuilder.build(outcome.notes);
        if (g) {
          outcome.file.groups[g.name] = g;
        }
      }
      const name = trimmed.slice(2).trim().toUpperCase();
      currentBuilder = new GroupBuilder(name);
    } else if (currentBuilder) {
      if (trimmed.startsWith("*")) {
        currentBuilder.setHeadings(splitCsv(trimmed.slice(1)));
      } else {
        currentBuilder.pushDataLine(splitCsv(trimmed));
      }
    }
  }

  // Flush final group.
  if (currentBuilder) {
    const g = currentBuilder.build(outcome.notes);
    if (g) {
      outcome.file.groups[g.name] = g;
    }
  }

  if (Object.keys(outcome.file.groups).length === 0) {
    outcome.notes.push("no groups found in AGS 3 input");
  }

  return outcome;
}

class GroupBuilder {
  headings: string[] = [];
  dataLines: string[][] = [];

  constructor(public name: string) {}

  setHeadings(names: string[]) {
    this.headings = names.map((s) => s.trim().toUpperCase());
  }

  pushDataLine(fields: string[]) {
    this.dataLines.push(fields);
  }

  build(notes: string[]): AgsGroup | null {
    if (this.headings.length === 0) {
      notes.push(`group ${this.name} skipped: no heading line`);
      return null;
    }

    // AGS 3 convention: first data line = units, second = types.
    const units = this.dataLines[0] || [];
    const types = this.dataLines[1] || [];

    const headings: AgsHeading[] = this.headings.map((name, i) => {
      const unit = (units[i] || "").trim();
      const rawType = (types[i] || "X").trim();
      const data_type = AgsTypeFunctions.parse(rawType);
      return {
        name,
        unit,
        data_type,
      };
    });

    const rows: AgsRow[] = [];
    for (let i = 2; i < this.dataLines.length; i++) {
      const rawRow = this.dataLines[i]!;
      const row: AgsRow = {};
      for (let j = 0; j < headings.length; j++) {
        const heading = headings[j]!;
        const raw = (rawRow[j] || "").trim();
        const val = raw === "" ? null : coerce(raw, heading.data_type);
        row[heading.name] = val;
      }
      rows.push(row);
    }

    return {
      name: this.name,
      headings,
      rows,
      source_line: Option.none(),
    };
  }
}

/**
 * Coerce a raw string value to an AgsValue given its type.
 */
function coerce(raw: string, ty: AgsType): AgsValue {
  if (AgsTypeFunctions.isNumeric(ty)) {
    const f = parseFloat(raw);
    if (!isNaN(f) && isFinite(f)) {
      return f;
    } else {
      return raw;
    }
  }
  if (ty === "YN") {
    switch (raw.toUpperCase()) {
      case "Y":
      case "YES":
      case "TRUE":
      case "1":
        return true;
      default:
        return false;
    }
  }
  return raw;
}

/**
 * Split a CSV line into fields, respecting double-quoted strings.
 */
function splitCsv(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];
    switch (ch) {
      case '"':
        if (inQuotes) {
          // Peek for escaped double-quote `""`.
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          inQuotes = true;
        }
        break;
      case ",":
        if (!inQuotes) {
          fields.push(current.trim());
          current = "";
        } else {
          current += ch;
        }
        break;
      default:
        current += ch;
    }
    i++;
  }
  fields.push(current.trim());
  return fields;
}
