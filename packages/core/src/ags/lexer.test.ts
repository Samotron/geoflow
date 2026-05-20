import { describe, it, expect } from "vitest";
import { tokenizeLine, AgsRowKind, AgsRowKindFunctions } from "./lexer.js";

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
    expect(AgsRowKindFunctions.parse("GROUP")).toBe(AgsRowKind.Group);
    expect(AgsRowKindFunctions.parse("HEADING")).toBe(AgsRowKind.Heading);
    expect(AgsRowKindFunctions.parse("UNIT")).toBe(AgsRowKind.Unit);
    expect(AgsRowKindFunctions.parse("TYPE")).toBe(AgsRowKind.Type);
    expect(AgsRowKindFunctions.parse("DATA")).toBe(AgsRowKind.Data);
    expect(AgsRowKindFunctions.parse("WAT")).toBe(AgsRowKind.Unknown);
  });
});
