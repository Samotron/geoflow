import iconv from "iconv-lite";
import { Option } from "effect";
import { AgsFile, AgsGroup, AgsType, AgsValue, AgsTypeFunctions } from "../model.js";
import { Diagnostic, DiagnosticBuilder, Severity } from "../diagnostics.js";
import { tokenizeLine, AgsRowKind, LexError } from "./lexer.js";

/**
 * Parser output: the parsed file plus any diagnostics generated while parsing.
 */
export interface ParseOutcome {
  file: AgsFile;
  diagnostics: Diagnostic[];
}

/**
 * Decode AGS file bytes to text, stripping a UTF-8 BOM and falling back
 * to Windows-1252 when UTF-8 decoding fails.
 */
export function decodeBytes(bytes: Uint8Array): string {
  let data = bytes;
  // Strip UTF-8 BOM (0xEF, 0xBB, 0xBF)
  if (data.length >= 3 && data[0] === 0xEF && data[1] === 0xBB && data[2] === 0xBF) {
    data = data.slice(3);
  }

  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return decoder.decode(data);
  } catch {
    // Fallback to Windows-1252
    return iconv.decode(Buffer.from(data), "windows-1252");
  }
}

/**
 * Parse AGS text.
 */
export function parseStr(text: string): ParseOutcome {
  if (looksLikeAgs3(text)) {
    return {
      file: createEmptyAgsFile(),
      diagnostics: [
        new DiagnosticBuilder(
          "AGS-V3-UNSUPPORTED",
          Severity.Error,
          "file appears to be AGS 3 format; this parser only supports AGS 4.x"
        ).build(),
      ],
    };
  }

  const state = new ParserState();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    state.consumeLine(lines[i]!, i + 1);
  }
  return state.finish();
}

/**
 * Returns true if the first non-empty line starts with `**`, indicating AGS 3 format.
 */
function looksLikeAgs3(text: string): boolean {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed.startsWith("**");
    }
  }
  return false;
}

function createEmptyAgsFile(): AgsFile {
  return {
    groups: {},
    source_path: Option.none(),
    ags_version: Option.none(),
  };
}

class ParserState {
  file: AgsFile = createEmptyAgsFile();
  diagnostics: Diagnostic[] = [];
  currentGroup: string | null = null;

  consumeLine(line: string, lineNo: number) {
    let toks: string[];
    try {
      const result = tokenizeLine(line);
      if (result === null) return;
      toks = result;
    } catch (e) {
      if (e instanceof LexError) {
        this.diagnostics.push(
          new DiagnosticBuilder("AGS-LEX", Severity.Error, `lex error: ${e.message}`)
            .atLine(lineNo)
            .build()
        );
      }
      return;
    }

    if (toks.length === 0) return;
    const tag = toks[0]!;
    const kind = AgsRowKind.parse(tag);
    const payload = toks.slice(1);

    switch (kind) {
      case AgsRowKind.Group:
        this.handleGroup(payload, lineNo);
        break;
      case AgsRowKind.Heading:
        this.handleHeading(payload, lineNo);
        break;
      case AgsRowKind.Unit:
        this.handleUnit(payload, lineNo);
        break;
      case AgsRowKind.Type:
        this.handleType(payload, lineNo);
        break;
      case AgsRowKind.Data:
        this.handleData(payload, lineNo);
        break;
      case AgsRowKind.Unknown:
        this.diagnostics.push(
          new DiagnosticBuilder("AGS-ROW-KIND", Severity.Warning, `unknown row tag ${JSON.stringify(tag)}`)
            .atLine(lineNo)
            .build()
        );
        break;
    }
  }

  handleGroup(payload: string[], lineNo: number) {
    const name = payload[0] || "";
    if (name.length === 0) {
      this.diagnostics.push(
        new DiagnosticBuilder("AGS-GROUP-EMPTY", Severity.Error, "GROUP row missing name")
          .atLine(lineNo)
          .build()
      );
      return;
    }
    if (!isValidGroupName(name)) {
      this.diagnostics.push(
        new DiagnosticBuilder(
          "AGS-GROUP-FMT",
          Severity.Warning,
          `GROUP name ${JSON.stringify(name)} does not follow AGS convention (1–4 uppercase letters)`
        )
          .atLine(lineNo)
          .build()
      );
    }
    const grp: AgsGroup = {
      name,
      headings: [],
      rows: [],
      source_line: Option.some(lineNo),
    };
    this.file.groups[name] = grp;
    this.currentGroup = name;
  }

  handleHeading(payload: string[], lineNo: number) {
    if (this.currentGroup === null) {
      this.diagnostics.push(
        new DiagnosticBuilder("AGS-HEADING-ORPHAN", Severity.Error, "HEADING row before any GROUP")
          .atLine(lineNo)
          .build()
      );
      return;
    }
    const group = this.file.groups[this.currentGroup]!;
    if (group.headings.length > 0) {
      this.diagnostics.push(
        new DiagnosticBuilder("AGS-HEADING-DUP", Severity.Error, `duplicate HEADING row in group ${this.currentGroup}`)
          .atGroup(this.currentGroup)
          .atLine(lineNo)
          .build()
      );
    }
    group.headings = payload.map((name) => ({
      name,
      unit: "",
      data_type: { _tag: "Other", value: "" },
    }));
  }

  handleUnit(payload: string[], lineNo: number) {
    if (this.currentGroup === null) return;
    const group = this.file.groups[this.currentGroup]!;
    if (group.headings.length === 0) {
      this.diagnostics.push(
        new DiagnosticBuilder("AGS-UNIT-NOHEAD", Severity.Error, "UNIT row before HEADING")
          .atGroup(this.currentGroup)
          .atLine(lineNo)
          .build()
      );
      return;
    }
    for (let i = 0; i < payload.length; i++) {
      if (group.headings[i]) {
        group.headings[i]!.unit = payload[i]!;
      }
    }
  }

  handleType(payload: string[], lineNo: number) {
    if (this.currentGroup === null) return;
    const group = this.file.groups[this.currentGroup]!;
    if (group.headings.length === 0) {
      this.diagnostics.push(
        new DiagnosticBuilder("AGS-TYPE-NOHEAD", Severity.Error, "TYPE row before HEADING")
          .atGroup(this.currentGroup)
          .atLine(lineNo)
          .build()
      );
      return;
    }
    for (let i = 0; i < payload.length; i++) {
      if (group.headings[i]) {
        group.headings[i]!.data_type = AgsTypeFunctions.parse(payload[i]!);
      }
    }
  }

  handleData(payload: string[], lineNo: number) {
    if (this.currentGroup === null) {
      this.diagnostics.push(
        new DiagnosticBuilder("AGS-DATA-ORPHAN", Severity.Error, "DATA row before any GROUP")
          .atLine(lineNo)
          .build()
      );
      return;
    }
    const group = this.file.groups[this.currentGroup]!;
    if (group.headings.length === 0) {
      this.diagnostics.push(
        new DiagnosticBuilder("AGS-DATA-NOHEAD", Severity.Error, "DATA row before HEADING")
          .atGroup(this.currentGroup)
          .atLine(lineNo)
          .build()
      );
      return;
    }

    const payloadLen = payload.length;
    const headingLen = group.headings.length;

    const row: any = {};
    for (let i = 0; i < payload.length; i++) {
      const raw = payload[i]!;
      const h = group.headings[i];
      if (!h) {
        this.diagnostics.push(
          new DiagnosticBuilder("AGS-DATA-EXTRA", Severity.Warning, `extra value at column ${i + 1} in ${this.currentGroup}`)
            .atGroup(this.currentGroup)
            .atLine(lineNo)
            .build()
        );
        continue;
      }
      row[h.name] = coerce(raw, h.data_type);
    }

    if (payloadLen < headingLen) {
      this.diagnostics.push(
        new DiagnosticBuilder(
          "AGS-DATA-SHORT",
          Severity.Warning,
          `${this.currentGroup}: DATA row has ${payloadLen} values but HEADING declares ${headingLen}`
        )
          .atGroup(this.currentGroup)
          .atLine(lineNo)
          .build()
      );
    }

    // Pad short rows
    for (let i = Object.keys(row).length; i < headingLen; i++) {
      row[group.headings[i]!.name] = null;
    }

    group.rows.push(row);

    // Capture version
    if (this.currentGroup === "TRAN") {
      const lastRow = group.rows[group.rows.length - 1]!;
      const versionVal = lastRow["TRAN_AGS"];
      if (typeof versionVal === "string") {
        this.file.ags_version = Option.some(versionVal);
      }
    }
  }

  finish(): ParseOutcome {
    if (Object.keys(this.file.groups).length === 0 && this.diagnostics.length === 0) {
      this.diagnostics.push(
        new DiagnosticBuilder("AGS-EMPTY", Severity.Warning, "no AGS groups found").build()
      );
    }
    return {
      file: this.file,
      diagnostics: this.diagnostics,
    };
  }
}

function isValidGroupName(name: string): boolean {
  return name.length > 0 && name.length <= 4 && /^[A-Z]+$/.test(name);
}

function coerce(raw: string, type: AgsType): AgsValue {
  if (raw === "") return null;
  if (AgsTypeFunctions.isNumeric(type)) {
    const n = parseFloat(raw.trim());
    if (!isNaN(n) && isFinite(n)) return n;
    return raw;
  }
  if (type === "YN") {
    const upper = raw.trim().toUpperCase();
    if (upper === "Y") return true;
    if (upper === "N") return false;
    return raw;
  }
  return raw;
}
