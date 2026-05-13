import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { decodeBytes, parseStr } from "./ags/parser.js";
import { Registry, validate } from "./validate.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "../../../tests/fixtures/ags");

function validateFixture(name: string) {
  const text = decodeBytes(readFileSync(resolve(FIXTURE_DIR, name)));
  const parsed = parseStr(text);
  return validate(parsed.file, Registry.standard());
}

describe("built-in validation rules", () => {
  it("flags invalid ABBR codelist references", () => {
    const diagnostics = validateFixture("abbr_codelist_invalid.ags");
    expect(diagnostics.some((diag) => diag.rule_id === "AGS-ABBR-001")).toBe(true);
  });

  it("flags invalid UNIT codelist references", () => {
    const diagnostics = validateFixture("unit_codelist_invalid.ags");
    expect(diagnostics.some((diag) => diag.rule_id === "AGS-UNIT-001")).toBe(true);
  });

  it("flags unresolved LOCA cross-references", () => {
    const diagnostics = validateFixture("xref_multi_invalid.ags");
    expect(diagnostics.filter((diag) => diag.rule_id === "AGS-XREF-LOCA")).toHaveLength(3);
  });

  it("flags duplicate primary IDs", () => {
    const diagnostics = validateFixture("key_dup_loca.ags");
    expect(diagnostics.some((diag) => diag.rule_id === "AGS-ID-001")).toBe(true);
  });

  it("flags duplicate SAMP composite keys", () => {
    const diagnostics = validateFixture("samp_key_dup.ags");
    expect(diagnostics.some((diag) => diag.rule_id === "AGS-KEY-002")).toBe(true);
  });

  it("flags headings missing from the standard dictionary", () => {
    const diagnostics = validateFixture("key_dup_loca.ags");
    const messages = diagnostics
      .filter((diag) => diag.rule_id === "AGS-DICT-004")
      .map((diag) => diag.message);
    expect(messages).toContain('LOCA: heading "LOCA_NATE" is not in the standard AGS dictionary');
    expect(messages).toContain('LOCA: heading "LOCA_NATN" is not in the standard AGS dictionary');
    expect(diagnostics.some((diag) => diag.rule_id === "AGS-DICT-005")).toBe(true);
  });

  it("flags groups with no DATA rows", () => {
    const diagnostics = validateFixture("empty_group.ags");
    expect(diagnostics.some((diag) => diag.rule_id === "AGS-STRUCT-005")).toBe(true);
  });

  it("flags heading names that do not match AGS naming convention", () => {
    const parsed = parseStr(`"GROUP","TEST"\n"HEADING","badName"\n"UNIT",""\n"TYPE","X"\n"DATA","x"\n`);
    const diagnostics = validate(parsed.file, Registry.standard());
    expect(diagnostics.some((diag) => diag.rule_id === "AGS-HEAD-004")).toBe(true);
  });

  it("flags headings out of dictionary order", () => {
    const parsed = parseStr(
      `"GROUP","GEOL"\n"HEADING","LOCA_ID","GEOL_BASE","GEOL_TOP","GEOL_DESC"\n"UNIT","","m","m",""\n"TYPE","ID","2DP","2DP","X"\n"DATA","BH01","1.50","0.00","Clay"\n`
    );
    const diagnostics = validate(parsed.file, Registry.standard());
    expect(diagnostics.some((diag) => diag.rule_id === "AGS-HEAD-007")).toBe(true);
  });

  it("flags empty values in required headings", () => {
    const parsed = parseStr(
      `"GROUP","LOCA"\n"HEADING","LOCA_ID","LOCA_TYPE"\n"UNIT","",""\n"TYPE","ID","X"\n"DATA","","CP"\n`
    );
    const diagnostics = validate(parsed.file, Registry.standard());
    expect(diagnostics.some((diag) => diag.rule_id === "AGS-DICT-003")).toBe(true);
  });

  it("flags duplicate generic composite keys", () => {
    const parsed = parseStr(
      `"GROUP","LLPL"\n"HEADING","LOCA_ID","SAMP_TOP","SAMP_REF","SPEC_DPTH"\n"UNIT","","m","","m"\n"TYPE","ID","2DP","ID","2DP"\n"DATA","BH01","1.50","S1","1.60"\n"DATA","BH01","1.50","S1","1.60"\n`
    );
    const diagnostics = validate(parsed.file, Registry.standard());
    expect(diagnostics.some((diag) => diag.rule_id === "AGS-KEY-010")).toBe(true);
  });

  it("flags missing parent-group references", () => {
    const parsed = parseStr(
      `"GROUP","SAMP"\n"HEADING","LOCA_ID","SAMP_TOP","SAMP_REF","SAMP_TYPE"\n"UNIT","","m","",""\n"TYPE","ID","2DP","ID","PA"\n"DATA","BH01","1.50","S1","B"\n\n"GROUP","LLPL"\n"HEADING","LOCA_ID","SAMP_TOP","SAMP_REF","SPEC_DPTH"\n"UNIT","","m","","m"\n"TYPE","ID","2DP","ID","2DP"\n"DATA","BH01","9.99","MISSING","1.60"\n`
    );
    const diagnostics = validate(parsed.file, Registry.standard());
    expect(diagnostics.some((diag) => diag.rule_id === "AGS-XREF-PGRP")).toBe(true);
  });

  it("flags missing TRAN_DLIM when RL headings exist", () => {
    const parsed = parseStr(
      `"GROUP","TRAN"\n"HEADING","TRAN_AGS"\n"UNIT",""\n"TYPE","X"\n"DATA","4.1"\n\n"GROUP","LINK"\n"HEADING","LINK_REF"\n"UNIT",""\n"TYPE","RL"\n"DATA","LOCA:BH01"\n`
    );
    const diagnostics = validate(parsed.file, Registry.standard());
    expect(diagnostics.some((diag) => diag.rule_id === "AGS-TRAN-001")).toBe(true);
  });

  it("flags invalid RL references", () => {
    const parsed = parseStr(
      `"GROUP","TRAN"\n"HEADING","TRAN_AGS","TRAN_DLIM"\n"UNIT","",""\n"TYPE","X","X"\n"DATA","4.1",":"\n\n"GROUP","LOCA"\n"HEADING","LOCA_ID"\n"UNIT",""\n"TYPE","ID"\n"DATA","BH01"\n\n"GROUP","LINK"\n"HEADING","LINK_REF"\n"UNIT",""\n"TYPE","RL"\n"DATA","LOCA:MISSING"\n`
    );
    const diagnostics = validate(parsed.file, Registry.standard());
    expect(diagnostics.some((diag) => diag.rule_id === "AGS-RL-001")).toBe(true);
  });

  it("flags type codes missing from TYPE group", () => {
    const parsed = parseStr(
      `"GROUP","TYPE"\n"HEADING","TYPE_STAT"\n"UNIT",""\n"TYPE","X"\n"DATA","ID"\n\n"GROUP","LOCA"\n"HEADING","LOCA_ID","LOCA_NATE"\n"UNIT","","m"\n"TYPE","ID","2DP"\n"DATA","BH01","1.50"\n`
    );
    const diagnostics = validate(parsed.file, Registry.standard());
    expect(diagnostics.some((diag) => diag.rule_id === "AGS-TYPE-003")).toBe(true);
  });

  it("flags value/type mismatches", () => {
    const parsed = parseStr(
      `"GROUP","LOCA"\n"HEADING","LOCA_ID","LOCA_NATE"\n"UNIT","","m"\n"TYPE","ID","2DP"\n"DATA","BH01","not_a_number"\n`
    );
    const diagnostics = validate(parsed.file, Registry.standard());
    const mismatch = diagnostics.find((diag) => diag.rule_id === "AGS-TYPE-002");
    expect(mismatch).toBeDefined();
    expect(mismatch?.fix_id._tag).toBe("Some");
    expect(Option.getOrNull(mismatch!.fix_id)).toBe("coerce-numeric-fields");
  });

  it("flags invalid Y/N values and marks common synonyms as fixable", () => {
    const parsed = parseStr(
      `"GROUP","ISPT"\n"HEADING","LOCA_ID","ISPT_TOP","ISPT_NVAL","ISPT_REJ"\n"UNIT","","m","",""\n"TYPE","ID","2DP","0DP","YN"\n"DATA","BH01","1.00","10","maybe"\n"DATA","BH02","2.00","20","yes"\n`
    );
    const diagnostics = validate(parsed.file, Registry.standard()).filter((diag) => diag.rule_id === "AGS-TYPE-002");
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]?.fix_id._tag).toBe("None");
    expect(diagnostics[1]?.fix_id._tag).toBe("Some");
    expect(Option.getOrNull(diagnostics[1]!.fix_id)).toBe("normalize-yn-values");
  });

  it("flags invalid date, time, DMS, and U values", () => {
    const parsed = parseStr(
      `"GROUP","TEST"\n"HEADING","TEST_DATE","TEST_TIME","TEST_DMS","TEST_U"\n"UNIT","","","",""\n"TYPE","DT","T","DMS","U"\n"DATA","01/01/2024","noon","1,02,03","abc"\n`
    );
    const diagnostics = validate(parsed.file, Registry.standard()).filter((diag) => diag.rule_id === "AGS-TYPE-002");
    expect(diagnostics).toHaveLength(4);
    expect(diagnostics.some((diag) => diag.message.includes("date format YYYY-MM-DD"))).toBe(true);
    expect(diagnostics.some((diag) => diag.message.includes("time format HH:MM or HH:MM:SS"))).toBe(true);
    expect(diagnostics.some((diag) => diag.message.includes("DMS format D:MM:SS"))).toBe(true);
    expect(diagnostics.some((diag) => diag.message.includes("U type requires a number"))).toBe(true);
    const dateDiagnostic = diagnostics.find((diag) => diag.message.includes("date format YYYY-MM-DD"));
    expect(dateDiagnostic?.fix_id._tag).toBe("Some");
    expect(Option.getOrNull(dateDiagnostic!.fix_id)).toBe("normalize-date-fields");
  });

  it("flags numeric headings with missing units", () => {
    const diagnostics = validateFixture("xref_multi_invalid.ags");
    expect(diagnostics.some((diag) => diag.rule_id === "AGS-HEAD-002")).toBe(true);
  });

  it("flags non-monotonic GEOL ordering", () => {
    const diagnostics = validateFixture("geol_overlap.ags");
    expect(diagnostics.some((diag) => diag.rule_id === "AGS-VAL-002")).toBe(true);
  });

  it("flags unrecognised TRAN_AGS versions", () => {
    const diagnostics = validateFixture("tran_version_warn.ags");
    expect(diagnostics.some((diag) => diag.rule_id === "AGS-STRUCT-004")).toBe(true);
  });

  it("accepts known TRAN_AGS versions", () => {
    const diagnostics = validateFixture("tran_ags_4_1_1.ags");
    expect(diagnostics.some((diag) => diag.rule_id === "AGS-STRUCT-004")).toBe(false);
  });

  it("flags rows with trailing whitespace and marks them fixable", () => {
    const diagnostics = validateFixture("fixable.ags");
    const fmt = diagnostics.find((diag) => diag.rule_id === "AGS-FMT-001");
    expect(fmt).toBeDefined();
    expect(fmt?.fix_id._tag).toBe("Some");
  });
});
