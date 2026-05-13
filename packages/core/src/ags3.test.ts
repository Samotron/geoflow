import { describe, it, expect } from "vitest";
import { migrateStr } from "./ags3.js";

const AGS3_SIMPLE = `**PROJ
*PROJ_ID,PROJ_NAME
"",""
"ID","X"
P001,Test Project

**LOCA
*LOCA_ID,LOCA_NATE,LOCA_NATN,LOCA_TYPE
"","m","m",""
"ID","2DP","2DP","PA"
BH01,500000,200000,BH
BH02,500100,200050,TP
`;

describe("migrateStr", () => {
  it("returns null for non-ags3", () => {
    expect(migrateStr("no groups here")).toBeNull();
  });

  it("parses groups and headings", () => {
    const out = migrateStr(AGS3_SIMPLE);
    expect(out).not.toBeNull();
    if (out) {
      expect(Object.keys(out.file.groups)).toContain("PROJ");
      expect(Object.keys(out.file.groups)).toContain("LOCA");
    }
  });

  it("parses rows with numbers", () => {
    const out = migrateStr(AGS3_SIMPLE);
    expect(out).not.toBeNull();
    if (out) {
      const loca = out.file.groups["LOCA"]!;
      expect(loca.rows).toHaveLength(2);
      expect(loca.rows[0]!["LOCA_NATE"]).toBe(500000);
      expect(loca.rows[0]!["LOCA_TYPE"]).toBe("BH");
    }
  });
});
