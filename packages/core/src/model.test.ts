import { Schema } from "effect";
import { describe, it, expect } from "vitest";
import { AgsFile, AgsTypeFunctions, AgsValueFunctions } from "./model.js";

describe("AgsType", () => {
  it("parses known types", () => {
    expect(AgsTypeFunctions.parse("X")).toBe("X");
    expect(AgsTypeFunctions.parse("XN")).toBe("XN");
    expect(AgsTypeFunctions.parse("2DP")).toEqual({ _tag: "DP", n: 2 });
    expect(AgsTypeFunctions.parse("3SF")).toEqual({ _tag: "SF", n: 3 });
    expect(AgsTypeFunctions.parse("4SCI")).toEqual({ _tag: "SCI", n: 4 });
    expect(AgsTypeFunctions.parse("RECORD_LINK")).toBe("RECORD_LINK");
    expect(AgsTypeFunctions.parse("WAT")).toEqual({ _tag: "Other", value: "WAT" });
  });

  it("numeric classification", () => {
    expect(AgsTypeFunctions.isNumeric("XN")).toBe(true);
    expect(AgsTypeFunctions.isNumeric({ _tag: "DP", n: 2 })).toBe(true);
    expect(AgsTypeFunctions.isNumeric("X")).toBe(false);
    expect(AgsTypeFunctions.isNumeric("ID")).toBe(false);
  });
});

describe("AgsValue", () => {
  it("helpers", () => {
    expect(AgsValueFunctions.asText("hi")).toBe("hi");
    expect(AgsValueFunctions.asNumber(2.5)).toBe(2.5);
    expect(AgsValueFunctions.isNull(null)).toBe(true);
  });
});

describe("AgsFile schema", () => {
  it("round-trips a parsed JSON-compatible AGS file", () => {
    const input = {
      groups: {
        PROJ: {
          name: "PROJ",
          headings: [
            {
              name: "PROJ_ID",
              unit: "",
              data_type: "ID",
            },
          ],
          rows: [
            {
              PROJ_ID: "P1",
            },
          ],
          source_line: { _tag: "Some", value: 1 },
        },
      },
      source_path: { _tag: "None" },
      ags_version: { _tag: "Some", value: "4.1.1" },
    };

    const decoded = Schema.decodeUnknownSync(AgsFile)(input);
    const encoded = Schema.encodeSync(AgsFile)(decoded);

    expect(encoded).toEqual(input);
  });
});
