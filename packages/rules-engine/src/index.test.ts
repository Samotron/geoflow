import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  // ── Declarative check kinds ────────────────────────────────────────────────

  describe("declarative checks", () => {
    it("required: flags empty fields per row", () => {
      const file = makeFile({
        LOCA: {
          name: "LOCA",
          headings: [
            { name: "LOCA_ID", unit: "", data_type: "ID" },
            { name: "LOCA_TYPE", unit: "", data_type: "PA" },
          ],
          rows: [
            { LOCA_ID: "BH01", LOCA_TYPE: "CP" },
            { LOCA_ID: "BH02", LOCA_TYPE: null },
            { LOCA_ID: "", LOCA_TYPE: "" },
          ],
          source_line: Option.none(),
        },
      });
      const yaml = `
version: 1
rules:
  - id: REQ
    severity: error
    in: LOCA
    check: { required: [LOCA_ID, LOCA_TYPE] }
`;
      const diags = evaluatePackYaml(yaml, file);
      expect(diags.map((d) => d.message)).toEqual([
        "LOCA: required field LOCA_TYPE is missing or empty",
        "LOCA: required field LOCA_ID is missing or empty",
        "LOCA: required field LOCA_TYPE is missing or empty",
      ]);
    });

    it("unique: flags duplicate composite keys", () => {
      const file = makeFile({
        SAMP: {
          name: "SAMP",
          headings: [
            { name: "LOCA_ID", unit: "", data_type: "ID" },
            { name: "SAMP_REF", unit: "", data_type: "ID" },
          ],
          rows: [
            { LOCA_ID: "BH01", SAMP_REF: "S1" },
            { LOCA_ID: "BH01", SAMP_REF: "S2" },
            { LOCA_ID: "BH01", SAMP_REF: "S1" },
          ],
          source_line: Option.none(),
        },
      });
      const yaml = `
version: 1
rules:
  - id: UQ
    severity: error
    in: SAMP
    check: { unique: [LOCA_ID, SAMP_REF] }
`;
      const diags = evaluatePackYaml(yaml, file);
      expect(diags).toHaveLength(1);
      expect(diags[0]?.location.row_index).toBe(2);
      expect(diags[0]?.message).toContain("BH01, S1");
    });

    it("foreign_key: flags rows whose key is absent in the referenced group", () => {
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
  - id: FK
    severity: error
    in: SAMP
    check:
      foreign_key:
        fields: [LOCA_ID]
        references: LOCA
`;
      const diags = evaluatePackYaml(yaml, file);
      expect(diags).toHaveLength(1);
      expect(diags[0]?.message).toContain("GHOST");
      expect(diags[0]?.location.row_index).toBe(1);
    });

    it("compare: cross-field comparison", () => {
      const file = makeFile({
        GEOL: {
          name: "GEOL",
          headings: [
            { name: "GEOL_TOP", unit: "m", data_type: { _tag: "DP", n: 2 } },
            { name: "GEOL_BASE", unit: "m", data_type: { _tag: "DP", n: 2 } },
          ],
          rows: [
            { GEOL_TOP: 0, GEOL_BASE: 1.5 },
            { GEOL_TOP: 2, GEOL_BASE: 1 }, // violation
          ],
          source_line: Option.none(),
        },
      });
      const yaml = `
version: 1
rules:
  - id: CMP
    severity: error
    in: GEOL
    check: { compare: { left: GEOL_BASE, op: ">", right: GEOL_TOP } }
`;
      const diags = evaluatePackYaml(yaml, file);
      expect(diags).toHaveLength(1);
      expect(diags[0]?.location.row_index).toBe(1);
    });

    it("one_of: codelist membership", () => {
      const file = makeFile({
        SAMP: {
          name: "SAMP",
          headings: [{ name: "SAMP_TYPE", unit: "", data_type: "PA" }],
          rows: [{ SAMP_TYPE: "B" }, { SAMP_TYPE: "XXX" }],
          source_line: Option.none(),
        },
      });
      const yaml = `
version: 1
codelists:
  sample_types: { inline: ["B", "U", "D"] }
rules:
  - id: OOF
    severity: warning
    in: SAMP
    check: { one_of: { field: SAMP_TYPE, codelist: sample_types } }
`;
      const diags = evaluatePackYaml(yaml, file);
      expect(diags).toHaveLength(1);
      expect(diags[0]?.message).toContain("XXX");
    });

    it("range: numeric bounds", () => {
      const file = makeFile({
        GEOL: {
          name: "GEOL",
          headings: [{ name: "GEOL_TOP", unit: "m", data_type: { _tag: "DP", n: 2 } }],
          rows: [{ GEOL_TOP: -1 }, { GEOL_TOP: 50 }, { GEOL_TOP: 1500 }],
          source_line: Option.none(),
        },
      });
      const yaml = `
version: 1
rules:
  - id: RNG
    severity: warning
    in: GEOL
    check: { range: { field: GEOL_TOP, min: 0, max: 1000 } }
`;
      const diags = evaluatePackYaml(yaml, file);
      expect(diags.map((d) => d.location.row_index)).toEqual([0, 2]);
    });

    it("monotonic with partition_by", () => {
      const file = makeFile({
        GEOL: {
          name: "GEOL",
          headings: [
            { name: "LOCA_ID", unit: "", data_type: "ID" },
            { name: "GEOL_TOP", unit: "m", data_type: { _tag: "DP", n: 2 } },
          ],
          rows: [
            { LOCA_ID: "BH01", GEOL_TOP: 0 },
            { LOCA_ID: "BH01", GEOL_TOP: 2 },
            { LOCA_ID: "BH02", GEOL_TOP: 5 },
            { LOCA_ID: "BH02", GEOL_TOP: 1 }, // out of order within BH02
          ],
          source_line: Option.none(),
        },
      });
      const yaml = `
version: 1
rules:
  - id: MON
    severity: error
    in: GEOL
    check: { monotonic: { field: GEOL_TOP, partition_by: LOCA_ID } }
`;
      const diags = evaluatePackYaml(yaml, file);
      expect(diags).toHaveLength(1);
      expect(diags[0]?.message).toContain("BH02");
    });

    it("pattern: regex match", () => {
      const file = makeFile({
        LOCA: {
          name: "LOCA",
          headings: [{ name: "LOCA_ID", unit: "", data_type: "ID" }],
          rows: [{ LOCA_ID: "BH01" }, { LOCA_ID: "garbage" }],
          source_line: Option.none(),
        },
      });
      const yaml = `
version: 1
rules:
  - id: PAT
    severity: warning
    in: LOCA
    check: { pattern: { field: LOCA_ID, regex: "^BH\\\\d+$" } }
`;
      const diags = evaluatePackYaml(yaml, file);
      expect(diags).toHaveLength(1);
      expect(diags[0]?.location.row_index).toBe(1);
    });

    it("group_exists and group_size", () => {
      const file = makeFile({
        LOCA: {
          name: "LOCA",
          headings: [{ name: "LOCA_ID", unit: "", data_type: "ID" }],
          rows: [{ LOCA_ID: "BH01" }, { LOCA_ID: "BH02" }],
          source_line: Option.none(),
        },
      });
      const yaml = `
version: 1
rules:
  - id: G1
    severity: error
    check: { group_exists: PROJ }
  - id: G2
    severity: error
    check: { group_size: { group: LOCA, equals: 3 } }
`;
      const diags = evaluatePackYaml(yaml, file);
      expect(diags.map((d) => d.rule_id)).toEqual(["G1", "G2"]);
      expect(diags[1]?.message).toContain("2");
      expect(diags[1]?.message).toContain("3");
    });

    it("depth_unit: depth headings must carry given unit", () => {
      const file = makeFile({
        GEOL: {
          name: "GEOL",
          headings: [
            { name: "GEOL_TOP", unit: "ft", data_type: { _tag: "DP", n: 2 } },
            { name: "GEOL_BASE", unit: "m", data_type: { _tag: "DP", n: 2 } },
          ],
          rows: [],
          source_line: Option.none(),
        },
      });
      const yaml = `
version: 1
rules:
  - id: DU
    severity: error
    check: { depth_unit: { headings: [GEOL_TOP, GEOL_BASE], unit: m } }
`;
      const diags = evaluatePackYaml(yaml, file);
      expect(diags).toHaveLength(1);
      expect(diags[0]?.message).toContain("ft");
    });

    it("heading_present: file-scope heading existence", () => {
      const file = makeFile({
        TRAN: {
          name: "TRAN",
          headings: [{ name: "TRAN_DATE", unit: "", data_type: "DT" }],
          rows: [],
          source_line: Option.none(),
        },
      });
      const yaml = `
version: 1
rules:
  - id: HP
    severity: error
    check: { heading_present: { group: TRAN, heading: TRAN_AGS } }
`;
      const diags = evaluatePackYaml(yaml, file);
      expect(diags).toHaveLength(1);
    });

    it("expr as a declarative check kind (escape hatch)", () => {
      const file = makeFile({
        LOCA: {
          name: "LOCA",
          headings: [{ name: "LOCA_ID", unit: "", data_type: "ID" }],
          rows: [{ LOCA_ID: "BH01" }, { LOCA_ID: "" }],
          source_line: Option.none(),
        },
      });
      const yaml = `
version: 1
rules:
  - id: EX
    severity: error
    in: LOCA
    check: { expr: "row.LOCA_ID != null && row.LOCA_ID != ''" }
    message: "empty id"
`;
      const diags = evaluatePackYaml(yaml, file);
      expect(diags).toHaveLength(1);
      expect(diags[0]?.location.row_index).toBe(1);
    });

    it("custom message templates interpolate row fields", () => {
      const file = makeFile({
        LOCA: {
          name: "LOCA",
          headings: [
            { name: "LOCA_ID", unit: "", data_type: "ID" },
            { name: "LOCA_TYPE", unit: "", data_type: "PA" },
          ],
          rows: [{ LOCA_ID: "BH02", LOCA_TYPE: null }],
          source_line: Option.none(),
        },
      });
      const yaml = `
version: 1
rules:
  - id: MSG
    severity: error
    in: LOCA
    check: { required: [LOCA_TYPE] }
    message: "Location {row.LOCA_ID} has no {field}"
`;
      const diags = evaluatePackYaml(yaml, file);
      expect(diags[0]?.message).toBe("Location BH02 has no LOCA_TYPE");
    });
  });

  it("loads and evaluates the bundled BGS standard pack", () => {
    const packPath = resolve(__dirname, "../../../rules/specs/bgs/standard/1.x/pack.yml");
    const yaml = readFileSync(packPath, "utf-8");
    const pack = loadPack(yaml);
    expect(pack.rules.length).toBeGreaterThan(5);
    for (const r of pack.rules) {
      expect(r.id).toMatch(/^BGS-/);
      expect(r.severity).toMatch(/^(error|warning|info)$/);
      expect(r.check ?? r.expr).toBeTruthy();
    }

    // File missing PROJ, ABBR, TYPE, UNIT, GEOL, HDPH and with a LOCA row
    // that has no usable coordinate set.
    const file = makeFile({
      LOCA: {
        name: "LOCA",
        headings: [
          { name: "LOCA_ID", unit: "", data_type: "ID" },
          { name: "LOCA_TYPE", unit: "", data_type: "PA" },
        ],
        rows: [{ LOCA_ID: "BH01", LOCA_TYPE: "CP" }],
        source_line: Option.none(),
      },
    });

    const diags = evaluatePackYaml(yaml, file);
    const ids = new Set(diags.map((d) => d.rule_id));
    expect(ids.has("BGS-1-PROJ")).toBe(true);
    expect(ids.has("BGS-1-ABBR")).toBe(true);
    expect(ids.has("BGS-1-TYPE")).toBe(true);
    expect(ids.has("BGS-1-UNIT")).toBe(true);
    expect(ids.has("BGS-2")).toBe(true);
    expect(ids.has("BGS-3")).toBe(true); // LOCA has no coords
  });

  it("loads and evaluates the bundled AGS standard pack", () => {
    // End-to-end sanity check: the on-disk YAML pack parses cleanly,
    // every rule has either a `check:` or `expr:`, and it produces sensible
    // diagnostics against a small fixture.
    const packPath = resolve(__dirname, "../../../rules/specs/ags/standard/4.x/pack.yml");
    const yaml = readFileSync(packPath, "utf-8");
    const pack = loadPack(yaml);
    expect(pack.rules.length).toBeGreaterThan(10);
    for (const r of pack.rules) {
      expect(r.id).toMatch(/^[A-Z]/);
      expect(r.severity).toMatch(/^(error|warning|info)$/);
      expect(r.check ?? r.expr).toBeTruthy();
    }

    const file = makeFile({
      LOCA: {
        name: "LOCA",
        headings: [
          { name: "LOCA_ID", unit: "", data_type: "ID" },
          { name: "LOCA_TYPE", unit: "", data_type: "PA" },
        ],
        rows: [
          { LOCA_ID: "BH01", LOCA_TYPE: "CP" },
          { LOCA_ID: "BH01", LOCA_TYPE: "CP" }, // duplicate ID → AGS-KEY-001
        ],
        source_line: Option.none(),
      },
      GEOL: {
        name: "GEOL",
        headings: [
          { name: "LOCA_ID", unit: "", data_type: "ID" },
          { name: "GEOL_TOP", unit: "m", data_type: { _tag: "DP", n: 2 } },
          { name: "GEOL_BASE", unit: "m", data_type: { _tag: "DP", n: 2 } },
        ],
        rows: [
          { LOCA_ID: "BH01", GEOL_TOP: 1, GEOL_BASE: 0.5 }, // base<top → AGS-VAL-001
          { LOCA_ID: "GHOST", GEOL_TOP: 0, GEOL_BASE: 1 }, // unknown LOCA → AGS-REF-002
        ],
        source_line: Option.none(),
      },
    });

    const diags = evaluatePackYaml(yaml, file);
    const ids = new Set(diags.map((d) => d.rule_id));
    expect(ids.has("AGS-KEY-001")).toBe(true);
    expect(ids.has("AGS-VAL-001")).toBe(true);
    expect(ids.has("AGS-REF-002")).toBe(true);
    expect(ids.has("AGS-STRUCT-001")).toBe(true); // no PROJ group
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
