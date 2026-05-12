import { describe, it, expect } from "vitest";
import { tokenizeLine, LexErrorCode, AgsRowKind } from "./lexer.js";

describe("tokenizeLine", () => {
  it("parses simple row", () => {
    expect(tokenizeLine('"DATA","BH01","1.0"')).toEqual(["DATA", "BH01", "1.0"]);
  });

  it("handles embedded commas", () => {
    expect(tokenizeLine('"DATA","one, two","three"')).toEqual(["DATA", "one, two", "three"]);
  });

  it("handles embedded quotes", () => {
    expect(tokenizeLine('"DATA","he said ""hi""","x"')).toEqual(["DATA", 'he said "hi"', "x"]);
  });

  it("empty line is null", () => {
    expect(tokenizeLine("")).toBeNull();
    expect(tokenizeLine("   ")).toBeNull();
    expect(tokenizeLine("\r\n")).toBeNull();
  });

  it("handles crlf endings", () => {
    expect(tokenizeLine('"GROUP","PROJ"\r\n')).toEqual(["GROUP", "PROJ"]);
  });

  it("empty field between commas", () => {
    expect(tokenizeLine('"DATA","","x"')).toEqual(["DATA", "", "x"]);
    expect(tokenizeLine('"DATA",,"x"')).toEqual(["DATA", "", "x"]);
  });

  it("unterminated quote errors", () => {
    expect(() => tokenizeLine('"DATA","unterm')).toThrow(/unterminated/);
  });

  it("unexpected after field errors", () => {
    expect(() => tokenizeLine('"DATA"X')).toThrow(/unexpected character "X" after closing quote/);
  });
});

describe("AgsRowKind", () => {
  it("parses kind tags", () => {
    expect(AgsRowKind.parse("GROUP")).toBe(AgsRowKind.Group);
    expect(AgsRowKind.parse("HEADING")).toBe(AgsRowKind.Heading);
    expect(AgsRowKind.parse("UNIT")).toBe(AgsRowKind.Unit);
    expect(AgsRowKind.parse("TYPE")).toBe(AgsRowKind.Type);
    expect(AgsRowKind.parse("DATA")).toBe(AgsRowKind.Data);
    expect(AgsRowKind.parse("WAT")).toBe(AgsRowKind.Unknown);
  });
});
