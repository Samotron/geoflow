import { describe, expect, it } from "vitest";
import { parseStr } from "./ags/parser.js";
import { mergeAgsFiles, mergeAgsFilesN, applyConflictResolutions } from "./merge.js";

const FILE_A = `"GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME"
"UNIT","",""
"TYPE","ID","X"
"DATA","P1","Project A"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE","LOCA_FDEP"
"UNIT","","","m"
"TYPE","ID","PA","2DP"
"DATA","BH01","CP","10.0"
"DATA","BH02","CP","12.0"
`;

const FILE_B_NEW_HOLE = `"GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME"
"UNIT","",""
"TYPE","ID","X"
"DATA","P1","Project A"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE","LOCA_FDEP"
"UNIT","","","m"
"TYPE","ID","PA","2DP"
"DATA","BH03","CP","8.0"
`;

const FILE_B_CONFLICT = `"GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME"
"UNIT","",""
"TYPE","ID","X"
"DATA","P1","Project A"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE","LOCA_FDEP"
"UNIT","","","m"
"TYPE","ID","PA","2DP"
"DATA","BH01","CP","15.0"
`;

describe("mergeAgsFiles", () => {
  it("takes rows unique to one side", () => {
    const a = parseStr(FILE_A).file;
    const b = parseStr(FILE_B_NEW_HOLE).file;
    const { merged, conflicts } = mergeAgsFiles(a, b);
    expect(merged.groups["LOCA"]?.rows).toHaveLength(3);
    expect(conflicts).toHaveLength(0);
  });

  it("deduplicates identical rows", () => {
    const a = parseStr(FILE_A).file;
    const { merged, conflicts } = mergeAgsFiles(a, a);
    expect(merged.groups["LOCA"]?.rows).toHaveLength(2);
    expect(conflicts).toHaveLength(0);
  });

  it("reports conflicts when same PK has different values", () => {
    const a = parseStr(FILE_A).file;
    const b = parseStr(FILE_B_CONFLICT).file;
    const { merged, conflicts } = mergeAgsFiles(a, b);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.group).toBe("LOCA");
    expect(conflicts[0]!.primaryKey).toBe("BH01");
    // auto-resolved to theirs
    const bh01 = merged.groups["LOCA"]!.rows.find((r) => r["LOCA_ID"] === "BH01");
    expect(bh01?.["LOCA_FDEP"]).toBe(15);
  });

  it("applyConflictResolutions swaps to ours when user overrides", () => {
    const a = parseStr(FILE_A).file;
    const b = parseStr(FILE_B_CONFLICT).file;
    const { merged, conflicts } = mergeAgsFiles(a, b);
    conflicts[0]!.resolvedRow = conflicts[0]!.oursRow;
    const resolved = applyConflictResolutions(merged, conflicts);
    const bh01 = resolved.groups["LOCA"]!.rows.find((r) => r["LOCA_ID"] === "BH01");
    expect(bh01?.["LOCA_FDEP"]).toBe(10);
  });
});

describe("mergeAgsFilesN", () => {
  it("folds left-to-right over N files", () => {
    const a = parseStr(FILE_A).file;
    const b = parseStr(FILE_B_NEW_HOLE).file;
    const { merged } = mergeAgsFilesN([a, b]);
    expect(merged.groups["LOCA"]?.rows).toHaveLength(3);
  });

  it("returns empty AgsFile when given no files", () => {
    const { merged, conflicts } = mergeAgsFilesN([]);
    expect(Object.keys(merged.groups)).toHaveLength(0);
    expect(conflicts).toHaveLength(0);
  });

  it("accumulates conflicts across passes", () => {
    const a = parseStr(FILE_A).file;
    const b = parseStr(FILE_B_CONFLICT).file;
    const { conflicts } = mergeAgsFilesN([a, b, b]);
    // 1 conflict from a vs b. Then b' has same values so no new conflict.
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
  });
});
