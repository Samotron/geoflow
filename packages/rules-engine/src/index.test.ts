import { describe, expect, it } from "vitest";
import { Option } from "effect";
import { PACKAGE_NAME, evaluatePackYaml, loadPack } from "./index.js";
import type { AgsFile } from "@geoflow/core";

describe("@geoflow/rules-engine", () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@geoflow/rules-engine");
  });

  it("loads a valid YAML pack", () => {
    const yaml = `
version: 1
name: test-pack
rules:
  - id: TEST-001
    severity: error
    expr: "row.X != null"
    message: "X is null"
`;
    const pack = loadPack(yaml);
    expect(pack.rules).toHaveLength(1);
    expect(pack.rules[0]?.id).toBe("TEST-001");
  });

  it("throws on invalid pack YAML", () => {
    expect(() => loadPack("not a pack")).toThrow();
  });

  const makeFile = (groups: AgsFile["groups"]): AgsFile => ({
    groups,
    source_path: Option.none(),
    ags_version: Option.none(),
  });

  it("evaluates row-scope rules", () => {
    const file = makeFile({
      LOCA: {
        name: "LOCA",
        headings: [{ name: "LOCA_ID", unit: "", data_type: "ID" }, { name: "LOCA_NATE", unit: "m", data_type: { _tag: "DP", n: 2 } }],
        rows: [{ LOCA_ID: "BH01", LOCA_NATE: null }, { LOCA_ID: "BH02", LOCA_NATE: 100 }],
        source_line: Option.none(),
      },
    });

    const yaml = `
version: 1
rules:
  - id: LOCA-001
    severity: error
    when: "group == 'LOCA'"
    expr: "row.LOCA_NATE != null"
    message: "LOCA {row.LOCA_ID} missing easting"
`;
    const diags = evaluatePackYaml(yaml, file);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.rule_id).toBe("LOCA-001");
    expect(diags[0]?.message).toBe("LOCA BH01 missing easting");
    expect(diags[0]?.location.group).toBe("LOCA");
    expect(diags[0]?.location.row_index).toBe(0);
  });

  it("evaluates file-scope rules", () => {
    const file = makeFile({
      LOCA: {
        name: "LOCA",
        headings: [{ name: "LOCA_ID", unit: "", data_type: "ID" }],
        rows: [{ LOCA_ID: "BH01" }],
        source_line: Option.none(),
      },
    });

    const yaml = `
version: 1
rules:
  - id: STRUCT-001
    severity: error
    scope: file
    expr: "has_group('PROJ')"
    message: "PROJ group missing"
`;
    const diags = evaluatePackYaml(yaml, file);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.rule_id).toBe("STRUCT-001");
    expect(diags[0]?.location.group).toBeNull();
  });

  it("evaluates group-scope rules for monotonicity", () => {
    const file = makeFile({
      GEOL: {
        name: "GEOL",
        headings: [
          { name: "LOCA_ID", unit: "", data_type: "ID" },
          { name: "GEOL_TOP", unit: "m", data_type: { _tag: "DP", n: 2 } },
        ],
        rows: [
          { LOCA_ID: "BH01", GEOL_TOP: 0 },
          { LOCA_ID: "BH01", GEOL_TOP: 1.5 },
          { LOCA_ID: "BH02", GEOL_TOP: 0 },
          { LOCA_ID: "BH02", GEOL_TOP: 0.5 },  // would be non-monotonic if out of order
        ],
        source_line: Option.none(),
      },
    });

    const yaml = `
version: 1
rules:
  - id: GEOL-001
    severity: error
    scope: "group:LOCA_ID"
    when: "group == 'GEOL'"
    expr: "is_monotonic(pluck(rows, 'GEOL_TOP'))"
    message: "non-monotonic GEOL for {key.LOCA_ID}"
`;
    const diags = evaluatePackYaml(yaml, file);
    expect(diags).toHaveLength(0);
  });

  it("detects non-monotonic GEOL", () => {
    const file = makeFile({
      GEOL: {
        name: "GEOL",
        headings: [
          { name: "LOCA_ID", unit: "", data_type: "ID" },
          { name: "GEOL_TOP", unit: "m", data_type: { _tag: "DP", n: 2 } },
        ],
        rows: [
          { LOCA_ID: "BH01", GEOL_TOP: 1.5 },
          { LOCA_ID: "BH01", GEOL_TOP: 0 },  // reversed!
        ],
        source_line: Option.none(),
      },
    });

    const yaml = `
version: 1
rules:
  - id: GEOL-001
    severity: error
    scope: "group:LOCA_ID"
    when: "group == 'GEOL'"
    expr: "is_monotonic(pluck(rows, 'GEOL_TOP'))"
    message: "non-monotonic under {key.LOCA_ID}"
`;
    const diags = evaluatePackYaml(yaml, file);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.message).toBe("non-monotonic under BH01");
  });

  it("evaluates codelist membership with 'in' operator", () => {
    const file = makeFile({
      SAMP: {
        name: "SAMP",
        headings: [
          { name: "SAMP_ID", unit: "", data_type: "ID" },
          { name: "SAMP_TYPE", unit: "", data_type: "PA" },
        ],
        rows: [
          { SAMP_ID: "S1", SAMP_TYPE: "B" },
          { SAMP_ID: "S2", SAMP_TYPE: "INVALID" },
        ],
        source_line: Option.none(),
      },
    });

    const yaml = `
version: 1
codelists:
  sample_types:
    inline: ["B", "U", "D"]
rules:
  - id: SAMP-002
    severity: warning
    when: "group == 'SAMP'"
    expr: "row.SAMP_TYPE in codelist('sample_types')"
    message: "bad type {row.SAMP_TYPE}"
`;
    const diags = evaluatePackYaml(yaml, file);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.message).toBe("bad type INVALID");
  });

  it("evaluates exists_in cross-reference", () => {
    const file = makeFile({
      LOCA: {
        name: "LOCA",
        headings: [{ name: "LOCA_ID", unit: "", data_type: "ID" }],
        rows: [{ LOCA_ID: "BH01" }],
        source_line: Option.none(),
      },
      SAMP: {
        name: "SAMP",
        headings: [
          { name: "SAMP_ID", unit: "", data_type: "ID" },
          { name: "LOCA_ID", unit: "", data_type: "ID" },
        ],
        rows: [
          { SAMP_ID: "S1", LOCA_ID: "BH01" },
          { SAMP_ID: "S2", LOCA_ID: "GHOST" },
        ],
        source_line: Option.none(),
      },
    });

    const yaml = `
version: 1
rules:
  - id: SAMP-001
    severity: error
    when: "group == 'SAMP'"
    expr: "exists_in('LOCA', 'LOCA_ID', row.LOCA_ID)"
    message: "Sample {row.SAMP_ID} references unknown {row.LOCA_ID}"
`;
    const diags = evaluatePackYaml(yaml, file);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.message).toBe("Sample S2 references unknown GHOST");
  });
});
