export enum AgsRowKind {
  Group = "GROUP",
  Heading = "HEADING",
  Unit = "UNIT",
  Type = "TYPE",
  Data = "DATA",
  Unknown = "?",
}

export namespace AgsRowKind {
  export function parse(tag: string): AgsRowKind {
    switch (tag) {
      case "GROUP": return AgsRowKind.Group;
      case "HEADING": return AgsRowKind.Heading;
      case "UNIT": return AgsRowKind.Unit;
      case "TYPE": return AgsRowKind.Type;
      case "DATA": return AgsRowKind.Data;
      default: return AgsRowKind.Unknown;
    }
  }

  export function toString(kind: AgsRowKind): string {
    return kind;
  }
}

export enum LexErrorCode {
  UnterminatedQuote = "UnterminatedQuote",
  UnexpectedAfterField = "UnexpectedAfterField",
  UnquotedField = "UnquotedField",
}

export class LexError extends Error {
  constructor(public code: LexErrorCode, public char?: string) {
    super(LexError.message(code, char));
    this.name = "LexError";
  }

  static message(code: LexErrorCode, char?: string): string {
    switch (code) {
      case LexErrorCode.UnterminatedQuote: return "unterminated quoted field";
      case LexErrorCode.UnexpectedAfterField: return `unexpected character ${JSON.stringify(char)} after closing quote`;
      case LexErrorCode.UnquotedField: return `unquoted field starting with ${JSON.stringify(char)}`;
    }
  }
}

/**
 * Lex a single AGS line into its quoted fields.
 *
 * Returns `null` for empty / whitespace-only lines.
 * Throws `LexError` on malformed quoting.
 */
export function tokenizeLine(line: string): string[] | null {
  const trimmedLine = line.replace(/[\r\n]+$/, "");
  if (trimmedLine.trim().length === 0) {
    return null;
  }

  const fields: string[] = [];
  let i = 0;

  while (i < trimmedLine.length) {
    const char = trimmedLine[i]!;

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    if (char === '"') {
      i++;
      let buf = "";
      while (true) {
        if (i >= trimmedLine.length) {
          throw new LexError(LexErrorCode.UnterminatedQuote);
        }
        if (trimmedLine[i] === '"') {
          if (i + 1 < trimmedLine.length && trimmedLine[i + 1] === '"') {
            buf += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          buf += trimmedLine[i];
          i++;
        }
      }
      fields.push(buf);

      // Expect comma or EOL after a closing quote.
      while (i < trimmedLine.length) {
        const c = trimmedLine[i]!;
        if (c === ',') {
          i++;
          break;
        } else if (/\s/.test(c)) {
          i++;
        } else {
          throw new LexError(LexErrorCode.UnexpectedAfterField, c);
        }
      }
    } else if (char === ',') {
      fields.push("");
      i++;
    } else {
      throw new LexError(LexErrorCode.UnquotedField, char);
    }
  }

  return fields;
}
