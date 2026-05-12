import { describe, it, expect } from "vitest";
import { parseStr } from "./parser.js";
import { serialize } from "./serializer.js";

const SAMPLE = `"GROUP","PROJ"
"HEADING","PROJ_ID","PROJ_NAME"
"UNIT","",""
"TYPE","ID","X"
"DATA","P1","Test"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_NATE"
"UNIT","","m"
"TYPE","ID","2DP"
"DATA","BH01","123456.78"
`;

describe("serialize", () => {
  it("round-trip preserves structure", () => {
    const parsed = parseStr(SAMPLE);
    expect(parsed.diagnostics).toEqual([]);
    const serialized = serialize(parsed.file);
    const reparsed = parseStr(serialized);
    
    // We compare the file structure. 
    // Effect Schema objects might have different internal representations if they are classes,
    // but here they are plain objects.
    expect(reparsed.file).toEqual(parsed.file);
  });

  it("quotes embedded quotes", () => {
    const parsed = parseStr('"GROUP","X"\n"HEADING","X_A"\n"UNIT",""\n"TYPE","X"\n"DATA","he said ""hi"""\n');
    const serialized = serialize(parsed.file);
    expect(serialized).toContain('"he said ""hi"""');
  });
});
