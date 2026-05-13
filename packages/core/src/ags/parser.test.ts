import { Option } from "effect";
import { describe, it, expect } from "vitest";
import { parseStr } from "./parser.js";

const SAMPLE = `"GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME","PROJ_LOC"
"UNIT","","",""
"TYPE","ID","X","X"
"DATA","P1","Test project","Somewhere"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN"
"UNIT","","m","m"
"TYPE","ID","2DP","2DP"
"DATA","BH01","123456.78","234567.89"
"DATA","BH02","123460.00","234570.00"
`;

describe("parseStr", () => {
  it("parses groups and rows", () => {
    const out = parseStr(SAMPLE);
    expect(out.diagnostics).toEqual([]);
    expect(Object.keys(out.file.groups)).toHaveLength(2);

    const proj = out.file.groups["PROJ"]!;
    expect(proj.headings).toHaveLength(3);
    expect(proj.rows).toHaveLength(1);
    expect(proj.rows[0]!["PROJ_ID"]).toBe("P1");

    const loca = out.file.groups["LOCA"]!;
    expect(loca.rows).toHaveLength(2);
    expect(loca.rows[0]!["LOCA_NATE"]).toBe(123456.78);
  });

  it("flags data before heading", () => {
    const bad = '"GROUP","X"\n"DATA","a"\n';
    const out = parseStr(bad);
    expect(out.diagnostics.some(d => d.rule_id === "AGS-DATA-NOHEAD")).toBe(true);
  });

  it("captures ags version", () => {
    const text = `"GROUP","TRAN"
"HEADING","TRAN_AGS"
"UNIT",""
"TYPE","X"
"DATA","4.1"
`;
    const out = parseStr(text);
    expect(out.file.ags_version).toEqual(Option.some("4.1"));
  });

  it("empty input produces warning", () => {
    const out = parseStr("");
    expect(out.diagnostics.some(d => d.rule_id === "AGS-EMPTY")).toBe(true);
  });
});
