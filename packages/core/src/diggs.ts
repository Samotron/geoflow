/**
 * DIGGS (Data Interchange for Geotechnical and Geoenvironmental Specialists) support.
 *
 * Handles parsing DIGGS 2.6 XML and converting to/from the internal AGS model.
 * This is a TypeScript port of crates/geoflow-core/src/diggs.rs.
 */

import { Option } from "effect";
import type { AgsFile, AgsGroup, AgsHeading, AgsRow, AgsType, AgsValue } from "./model.js";
import { AgsTypeFunctions } from "./model.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** AGS 4 reference/lookup groups round-tripped via `<MetadataGroup>` XML wrapper. */
export const METADATA_GROUPS = ["ABBR", "UNIT", "TYPE", "DICT", "HOLE"] as const;

/** AGS groups with native DIGGS element mappings (waves A–D). */
const NATIVE_GROUPS: ReadonlySet<string> = new Set([
  // wave A
  "PROJ", "LOCA", "GEOL", "SAMP", "ISPT", "WSTK",
  // wave B lab tests
  "LLPL", "LDEN", "LPDN", "LPEN", "LCON", "LCBR",
  // wave C in-situ tests
  "IDEN", "IVAN", "IPRM", "IPRT", "IRDX", "ICBR", "CDIA", "CMET",
  // wave D monitoring & instrumentation
  "MOND", "PREM", "PRTM", "STCN", "RELD",
]);

const METADATA_SET: ReadonlySet<string> = new Set(METADATA_GROUPS);

// ── Public interface ──────────────────────────────────────────────────────────

/**
 * Report produced after AGS→DIGGS conversion.
 *
 * - `generic_groups`: groups that had no native DIGGS element and were
 *   round-tripped losslessly via a `<DataGroup>` wrapper.
 * - `unmapped_fields`: fields within natively-mapped groups that were
 *   not carried into DIGGS (informational).
 */
export interface ConversionReport {
  /** Groups wrapped via the generic `<DataGroup>` element. */
  generic_groups: string[];
  /** Fields within natively-mapped groups not carried to DIGGS. */
  unmapped_fields: Record<string, string[]>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  if (n % 1 === 0 && Math.abs(n) < 1e16) {
    return String(Math.trunc(n));
  }
  return String(n);
}

function valueAsString(v: AgsValue): string | null {
  if (v === null) return null;
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "boolean") return v ? "Y" : "N";
  // string
  return v === "" ? null : v;
}

function xmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Heading definitions ───────────────────────────────────────────────────────

function h(name: string, data_type: AgsType, unit = ""): AgsHeading {
  return { name, unit, data_type };
}

function projHeadings(): AgsHeading[] {
  return [h("PROJ_ID", "ID"), h("PROJ_NAME", "X")];
}

function locaHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("LOCA_NATE", { _tag: "DP", n: 2 }, "m"),
    h("LOCA_NATN", { _tag: "DP", n: 2 }, "m"),
  ];
}

function geolHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("GEOL_TOP", { _tag: "DP", n: 2 }, "m"),
    h("GEOL_BASE", { _tag: "DP", n: 2 }, "m"),
    h("GEOL_DESC", "X"),
    h("GEOL_LEG", "PA"),
  ];
}

function sampHeadings(): AgsHeading[] {
  return [h("LOCA_ID", "ID"), h("SAMP_ID", "ID"), h("SAMP_TYPE", "PA")];
}

function isptHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("ISPT_TOP", { _tag: "DP", n: 2 }, "m"),
    h("ISPT_NVAL", "XN"),
  ];
}

function wstkHeadings(): AgsHeading[] {
  return [h("LOCA_ID", "ID"), h("WSTK_DPTH", { _tag: "DP", n: 2 }, "m")];
}

function llplHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("SAMP_ID", "ID"),
    h("SAMP_REF", "X"),
    h("LLPL_LL", { _tag: "DP", n: 0 }, "%"),
    h("LLPL_PL", { _tag: "DP", n: 0 }, "%"),
    h("LLPL_PI", { _tag: "DP", n: 0 }, "%"),
    h("LLPL_425", { _tag: "DP", n: 0 }, "%"),
  ];
}

function ldenHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("SAMP_ID", "ID"),
    h("SAMP_REF", "X"),
    h("LDEN_BULK", { _tag: "DP", n: 3 }, "t/m3"),
    h("LDEN_BDEN", { _tag: "DP", n: 3 }, "t/m3"),
    h("LDEN_MC", { _tag: "DP", n: 1 }, "%"),
  ];
}

function lpdnHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("SAMP_ID", "ID"),
    h("SAMP_REF", "X"),
    h("LPDN_PD", { _tag: "DP", n: 3 }, "Mg/m3"),
    h("LPDN_MCMC", { _tag: "DP", n: 1 }, "%"),
  ];
}

function lpenHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("SAMP_ID", "ID"),
    h("SAMP_REF", "X"),
    h("LPEN_DEPTH", { _tag: "DP", n: 2 }, "m"),
    h("LPEN_STRE", { _tag: "DP", n: 1 }, "kPa"),
  ];
}

function lconHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("SAMP_ID", "ID"),
    h("SAMP_REF", "X"),
    h("LCON_VERT", { _tag: "DP", n: 1 }, "kPa"),
    h("LCON_VOID", { _tag: "DP", n: 3 }),
    h("LCON_RHVC", { _tag: "DP", n: 3 }, "m2/MN"),
  ];
}

function lcbrHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("SAMP_ID", "ID"),
    h("SAMP_REF", "X"),
    h("LCBR_COND", "PA"),
    h("LCBR_CBR", { _tag: "DP", n: 1 }, "%"),
  ];
}

function idenHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("IDEN_DPTH", { _tag: "DP", n: 2 }, "m"),
    h("IDEN_DIAM", { _tag: "DP", n: 1 }, "mm"),
    h("IDEN_MC", { _tag: "DP", n: 1 }, "%"),
    h("IDEN_DBUL", { _tag: "DP", n: 3 }, "Mg/m3"),
  ];
}

function ivanHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("IVAN_DPTH", { _tag: "DP", n: 2 }, "m"),
    h("IVAN_TESN", "X"),
    h("IVAN_STEN", { _tag: "DP", n: 1 }, "kPa"),
    h("IVAN_RTEN", { _tag: "DP", n: 1 }, "kPa"),
  ];
}

function iprmHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("IPRM_TOP", { _tag: "DP", n: 2 }, "m"),
    h("IPRM_BOT", { _tag: "DP", n: 2 }, "m"),
    h("IPRM_TYPE", "PA"),
    h("IPRM_PERM", { _tag: "SCI", n: 2 }, "m/s"),
  ];
}

function iprtHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("IPRT_DPTH", { _tag: "DP", n: 2 }, "m"),
    h("IPRT_TYPE", "PA"),
    h("IPRT_PL", { _tag: "DP", n: 1 }, "kPa"),
    h("IPRT_LLD", { _tag: "DP", n: 1 }, "kPa"),
  ];
}

function irdxHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("IRDX_DPTH", { _tag: "DP", n: 2 }, "m"),
    h("IRDX_RES", { _tag: "DP", n: 1 }, "mV"),
  ];
}

function icbrHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("ICBR_DPTH", { _tag: "DP", n: 2 }, "m"),
    h("ICBR_CBR1", { _tag: "DP", n: 1 }, "%"),
    h("ICBR_CBR2", { _tag: "DP", n: 1 }, "%"),
  ];
}

function cdiaHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("CDIA_DPTH", { _tag: "DP", n: 2 }, "m"),
    h("CDIA_DIAM", { _tag: "DP", n: 0 }, "mm"),
    h("CDIA_TYPE", "PA"),
  ];
}

function cmetHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("CMET_TOP", { _tag: "DP", n: 2 }, "m"),
    h("CMET_BASE", { _tag: "DP", n: 2 }, "m"),
    h("CMET_METH", "PA"),
  ];
}

function mondHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("MOND_DPTH", { _tag: "DP", n: 2 }, "m"),
    h("MOND_TYPE", "PA"),
    h("MOND_MEAS", "XN"),
    h("MOND_TREF", "DT"),
  ];
}

function premHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("PREM_DATE", "DT"),
    h("PREM_HEAD", { _tag: "DP", n: 3 }, "m"),
    h("PREM_DPTH", { _tag: "DP", n: 2 }, "m"),
  ];
}

function prtmHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("PRTM_DATE", "DT"),
    h("PRTM_PRES", { _tag: "DP", n: 1 }, "kPa"),
    h("PRTM_TEMP", { _tag: "DP", n: 1 }, "degC"),
  ];
}

function stcnHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("STCN_DPTH", { _tag: "DP", n: 2 }, "m"),
    h("STCN_RES", { _tag: "DP", n: 3 }, "MPa"),
    h("STCN_FRES", { _tag: "DP", n: 1 }, "kPa"),
    h("STCN_QT", { _tag: "DP", n: 3 }, "MPa"),
  ];
}

function reldHeadings(): AgsHeading[] {
  return [
    h("LOCA_ID", "ID"),
    h("SAMP_TOP", { _tag: "DP", n: 2 }, "m"),
    h("RELD_DMAX", { _tag: "DP", n: 3 }, "Mg/m3"),
    h("RELD_DMIN", { _tag: "DP", n: 3 }, "Mg/m3"),
    h("RELD_DRY", { _tag: "DP", n: 3 }, "Mg/m3"),
  ];
}

// ── Writer ────────────────────────────────────────────────────────────────────

function emitOpt(parts: string[], row: AgsRow, field: string, tag: string): void {
  const val = valueAsString(row[field] ?? null);
  if (val !== null) {
    parts.push(`    <${tag}>${xmlText(val)}</${tag}>\n`);
  }
}

function emitLabCommon(parts: string[], row: AgsRow): void {
  emitOpt(parts, row, "LOCA_ID", "locationId");
  emitOpt(parts, row, "SAMP_ID", "sampleId");
  emitOpt(parts, row, "SAMP_REF", "sampleRef");
}

function writeGenericGroup(
  parts: string[],
  element: string,
  gname: string,
  group: AgsGroup,
): void {
  parts.push(`  <${element} name="${xmlAttr(gname)}">\n`);
  for (const hd of group.headings) {
    parts.push(
      `    <heading name="${xmlAttr(hd.name)}" unit="${xmlAttr(hd.unit)}" type="${xmlAttr(AgsTypeFunctions.toString(hd.data_type))}"/>\n`,
    );
  }
  for (const row of group.rows) {
    parts.push("    <row>\n");
    for (const hd of group.headings) {
      const val = valueAsString(row[hd.name] ?? null);
      if (val !== null) {
        parts.push(
          `      <field name="${xmlAttr(hd.name)}">${xmlText(val)}</field>\n`,
        );
      }
    }
    parts.push("    </row>\n");
  }
  parts.push(`  </${element}>\n`);
}

/** Convert an AgsFile to DIGGS 2.6 XML. */
export function writeDiggs(file: AgsFile): { xml: string; report: ConversionReport } {
  const report: ConversionReport = { generic_groups: [], unmapped_fields: {} };
  const parts: string[] = [];

  parts.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  parts.push(
    '<Diggs xmlns="http://diggsml.org/schemas/2.6"' +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
      ' xmlns:gml="http://www.opengis.net/gml">\n',
  );

  // ── Wave A ──────────────────────────────────────────────────────────────────

  const proj = file.groups["PROJ"];
  const projRow = proj?.rows[0];
  if (projRow !== undefined) {
    parts.push("  <Project>\n");
    const projId = valueAsString((projRow["PROJ_ID"] ?? null) as AgsValue);
    if (projId !== null) parts.push(`    <gml:name>${xmlText(projId)}</gml:name>\n`);
    const projName = valueAsString((projRow["PROJ_NAME"] ?? null) as AgsValue);
    if (projName !== null) parts.push(`    <gml:description>${xmlText(projName)}</gml:description>\n`);
    parts.push("  </Project>\n");
  }

  const loca = file.groups["LOCA"];
  if (loca) {
    for (const row of loca.rows) {
      parts.push("  <SamplingLocation>\n");
      const locaId = valueAsString(row["LOCA_ID"] ?? null);
      if (locaId !== null) parts.push(`    <gml:name>${xmlText(locaId)}</gml:name>\n`);
      const easting = valueAsString(row["LOCA_NATE"] ?? null);
      if (easting !== null) parts.push(`    <easting>${xmlText(easting)}</easting>\n`);
      const northing = valueAsString(row["LOCA_NATN"] ?? null);
      if (northing !== null) parts.push(`    <northing>${xmlText(northing)}</northing>\n`);
      parts.push("  </SamplingLocation>\n");
    }
  }

  const geol = file.groups["GEOL"];
  if (geol) {
    for (const row of geol.rows) {
      parts.push("  <Lithology>\n");
      emitOpt(parts, row, "LOCA_ID", "locationId");
      emitOpt(parts, row, "GEOL_TOP", "topDepth");
      emitOpt(parts, row, "GEOL_BASE", "baseDepth");
      emitOpt(parts, row, "GEOL_DESC", "description");
      emitOpt(parts, row, "GEOL_LEG", "legendCode");
      parts.push("  </Lithology>\n");
    }
  }

  const samp = file.groups["SAMP"];
  if (samp) {
    for (const row of samp.rows) {
      parts.push("  <Sample>\n");
      emitOpt(parts, row, "LOCA_ID", "locationId");
      emitOpt(parts, row, "SAMP_ID", "sampleId");
      emitOpt(parts, row, "SAMP_TYPE", "sampleType");
      parts.push("  </Sample>\n");
    }
  }

  const ispt = file.groups["ISPT"];
  if (ispt) {
    for (const row of ispt.rows) {
      parts.push("  <SPTTest>\n");
      emitOpt(parts, row, "LOCA_ID", "locationId");
      emitOpt(parts, row, "ISPT_TOP", "testDepth");
      emitOpt(parts, row, "ISPT_NVAL", "blowCount");
      parts.push("  </SPTTest>\n");
    }
  }

  const wstk = file.groups["WSTK"];
  if (wstk) {
    for (const row of wstk.rows) {
      parts.push("  <WaterStrike>\n");
      emitOpt(parts, row, "LOCA_ID", "locationId");
      emitOpt(parts, row, "WSTK_DPTH", "strikeDepth");
      parts.push("  </WaterStrike>\n");
    }
  }

  // ── Wave B lab tests ─────────────────────────────────────────────────────────

  const llpl = file.groups["LLPL"];
  if (llpl) {
    for (const row of llpl.rows) {
      parts.push("  <AttenbergLimits>\n");
      emitLabCommon(parts, row);
      emitOpt(parts, row, "LLPL_LL", "liquidLimit");
      emitOpt(parts, row, "LLPL_PL", "plasticLimit");
      emitOpt(parts, row, "LLPL_PI", "plasticityIndex");
      emitOpt(parts, row, "LLPL_425", "percentPassing425");
      parts.push("  </AttenbergLimits>\n");
    }
  }

  const lden = file.groups["LDEN"];
  if (lden) {
    for (const row of lden.rows) {
      parts.push("  <BulkDensityTest>\n");
      emitLabCommon(parts, row);
      emitOpt(parts, row, "LDEN_BULK", "bulkDensity");
      emitOpt(parts, row, "LDEN_BDEN", "dryDensity");
      emitOpt(parts, row, "LDEN_MC", "moistureContent");
      parts.push("  </BulkDensityTest>\n");
    }
  }

  const lpdn = file.groups["LPDN"];
  if (lpdn) {
    for (const row of lpdn.rows) {
      parts.push("  <ParticleDensityTest>\n");
      emitLabCommon(parts, row);
      emitOpt(parts, row, "LPDN_PD", "particleDensity");
      emitOpt(parts, row, "LPDN_MCMC", "moistureContent");
      parts.push("  </ParticleDensityTest>\n");
    }
  }

  const lpen = file.groups["LPEN"];
  if (lpen) {
    for (const row of lpen.rows) {
      parts.push("  <PenetratorTest>\n");
      emitLabCommon(parts, row);
      emitOpt(parts, row, "LPEN_DEPTH", "testDepth");
      emitOpt(parts, row, "LPEN_STRE", "undrainedStrength");
      parts.push("  </PenetratorTest>\n");
    }
  }

  const lcon = file.groups["LCON"];
  if (lcon) {
    for (const row of lcon.rows) {
      parts.push("  <OedometerTest>\n");
      emitLabCommon(parts, row);
      emitOpt(parts, row, "LCON_VERT", "verticalStress");
      emitOpt(parts, row, "LCON_VOID", "voidRatio");
      emitOpt(parts, row, "LCON_RHVC", "compressionCoefficient");
      parts.push("  </OedometerTest>\n");
    }
  }

  const lcbr = file.groups["LCBR"];
  if (lcbr) {
    for (const row of lcbr.rows) {
      parts.push("  <CBRTest>\n");
      emitLabCommon(parts, row);
      emitOpt(parts, row, "LCBR_COND", "condition");
      emitOpt(parts, row, "LCBR_CBR", "cbrValue");
      parts.push("  </CBRTest>\n");
    }
  }

  // ── Wave C in-situ tests ──────────────────────────────────────────────────────

  const iden = file.groups["IDEN"];
  if (iden) {
    for (const row of iden.rows) {
      parts.push("  <InSituDensityTest>\n");
      emitOpt(parts, row, "LOCA_ID", "locationId");
      emitOpt(parts, row, "IDEN_DPTH", "testDepth");
      emitOpt(parts, row, "IDEN_DIAM", "diameter");
      emitOpt(parts, row, "IDEN_MC", "moistureContent");
      emitOpt(parts, row, "IDEN_DBUL", "dryDensity");
      parts.push("  </InSituDensityTest>\n");
    }
  }

  const ivan = file.groups["IVAN"];
  if (ivan) {
    for (const row of ivan.rows) {
      parts.push("  <VaneTest>\n");
      emitOpt(parts, row, "LOCA_ID", "locationId");
      emitOpt(parts, row, "IVAN_DPTH", "testDepth");
      emitOpt(parts, row, "IVAN_TESN", "testNumber");
      emitOpt(parts, row, "IVAN_STEN", "undrainedStrength");
      emitOpt(parts, row, "IVAN_RTEN", "remoulded Strength");
      parts.push("  </VaneTest>\n");
    }
  }

  const iprm = file.groups["IPRM"];
  if (iprm) {
    for (const row of iprm.rows) {
      parts.push("  <PermeabilityTest>\n");
      emitOpt(parts, row, "LOCA_ID", "locationId");
      emitOpt(parts, row, "IPRM_TOP", "topDepth");
      emitOpt(parts, row, "IPRM_BOT", "bottomDepth");
      emitOpt(parts, row, "IPRM_TYPE", "testType");
      emitOpt(parts, row, "IPRM_PERM", "permeability");
      parts.push("  </PermeabilityTest>\n");
    }
  }

  const iprt = file.groups["IPRT"];
  if (iprt) {
    for (const row of iprt.rows) {
      parts.push("  <PressuremeterTest>\n");
      emitOpt(parts, row, "LOCA_ID", "locationId");
      emitOpt(parts, row, "IPRT_DPTH", "testDepth");
      emitOpt(parts, row, "IPRT_TYPE", "testType");
      emitOpt(parts, row, "IPRT_PL", "limitPressure");
      emitOpt(parts, row, "IPRT_LLD", "liftoffPressure");
      parts.push("  </PressuremeterTest>\n");
    }
  }

  const irdx = file.groups["IRDX"];
  if (irdx) {
    for (const row of irdx.rows) {
      parts.push("  <RedoxTest>\n");
      emitOpt(parts, row, "LOCA_ID", "locationId");
      emitOpt(parts, row, "IRDX_DPTH", "testDepth");
      emitOpt(parts, row, "IRDX_RES", "redoxPotential");
      parts.push("  </RedoxTest>\n");
    }
  }

  const icbr = file.groups["ICBR"];
  if (icbr) {
    for (const row of icbr.rows) {
      parts.push("  <InSituCBRTest>\n");
      emitOpt(parts, row, "LOCA_ID", "locationId");
      emitOpt(parts, row, "ICBR_DPTH", "testDepth");
      emitOpt(parts, row, "ICBR_CBR1", "cbrValue1");
      emitOpt(parts, row, "ICBR_CBR2", "cbrValue2");
      parts.push("  </InSituCBRTest>\n");
    }
  }

  const cdia = file.groups["CDIA"];
  if (cdia) {
    for (const row of cdia.rows) {
      parts.push("  <CasingRecord>\n");
      emitOpt(parts, row, "LOCA_ID", "locationId");
      emitOpt(parts, row, "CDIA_DPTH", "depth");
      emitOpt(parts, row, "CDIA_DIAM", "diameter");
      emitOpt(parts, row, "CDIA_TYPE", "casingType");
      parts.push("  </CasingRecord>\n");
    }
  }

  const cmet = file.groups["CMET"];
  if (cmet) {
    for (const row of cmet.rows) {
      parts.push("  <DrillingMethod>\n");
      emitOpt(parts, row, "LOCA_ID", "locationId");
      emitOpt(parts, row, "CMET_TOP", "topDepth");
      emitOpt(parts, row, "CMET_BASE", "baseDepth");
      emitOpt(parts, row, "CMET_METH", "method");
      parts.push("  </DrillingMethod>\n");
    }
  }

  // ── Wave D monitoring ─────────────────────────────────────────────────────────

  const mond = file.groups["MOND"];
  if (mond) {
    for (const row of mond.rows) {
      parts.push("  <MonitoringReading>\n");
      emitOpt(parts, row, "LOCA_ID", "locationId");
      emitOpt(parts, row, "MOND_DPTH", "depth");
      emitOpt(parts, row, "MOND_TYPE", "instrumentType");
      emitOpt(parts, row, "MOND_MEAS", "measurement");
      emitOpt(parts, row, "MOND_TREF", "readingDate");
      parts.push("  </MonitoringReading>\n");
    }
  }

  const prem = file.groups["PREM"];
  if (prem) {
    for (const row of prem.rows) {
      parts.push("  <PiezometerReading>\n");
      emitOpt(parts, row, "LOCA_ID", "locationId");
      emitOpt(parts, row, "PREM_DATE", "readingDate");
      emitOpt(parts, row, "PREM_HEAD", "hydraulicHead");
      emitOpt(parts, row, "PREM_DPTH", "installDepth");
      parts.push("  </PiezometerReading>\n");
    }
  }

  const prtm = file.groups["PRTM"];
  if (prtm) {
    for (const row of prtm.rows) {
      parts.push("  <PressureTempReading>\n");
      emitOpt(parts, row, "LOCA_ID", "locationId");
      emitOpt(parts, row, "PRTM_DATE", "readingDate");
      emitOpt(parts, row, "PRTM_PRES", "pressure");
      emitOpt(parts, row, "PRTM_TEMP", "temperature");
      parts.push("  </PressureTempReading>\n");
    }
  }

  const stcn = file.groups["STCN"];
  if (stcn) {
    for (const row of stcn.rows) {
      parts.push("  <StaticConeTest>\n");
      emitOpt(parts, row, "LOCA_ID", "locationId");
      emitOpt(parts, row, "STCN_DPTH", "testDepth");
      emitOpt(parts, row, "STCN_RES", "conePenetrationResistance");
      emitOpt(parts, row, "STCN_FRES", "frictionResistance");
      emitOpt(parts, row, "STCN_QT", "correctedConeResistance");
      parts.push("  </StaticConeTest>\n");
    }
  }

  const reld = file.groups["RELD"];
  if (reld) {
    for (const row of reld.rows) {
      parts.push("  <RelativeDensityTest>\n");
      emitOpt(parts, row, "LOCA_ID", "locationId");
      emitOpt(parts, row, "SAMP_TOP", "sampleDepth");
      emitOpt(parts, row, "RELD_DMAX", "maximumDryDensity");
      emitOpt(parts, row, "RELD_DMIN", "minimumDryDensity");
      emitOpt(parts, row, "RELD_DRY", "dryDensity");
      parts.push("  </RelativeDensityTest>\n");
    }
  }

  // ── Metadata groups ───────────────────────────────────────────────────────────

  for (const [gname, group] of Object.entries(file.groups)) {
    if (!METADATA_SET.has(gname)) continue;
    writeGenericGroup(parts, "MetadataGroup", gname, group);
  }

  // ── All other groups → DataGroup ─────────────────────────────────────────────

  const genericNames: string[] = [];
  for (const [gname, group] of Object.entries(file.groups)) {
    if (NATIVE_GROUPS.has(gname) || METADATA_SET.has(gname)) continue;
    writeGenericGroup(parts, "DataGroup", gname, group);
    genericNames.push(gname);
  }
  report.generic_groups = genericNames.slice().sort();

  // ── Unmapped field tracking ────────────────────────────────────────────────────

  const MAPPED_FIELDS: Record<string, string[]> = {
    PROJ: ["PROJ_ID", "PROJ_NAME"],
    LOCA: ["LOCA_ID", "LOCA_NATE", "LOCA_NATN"],
    GEOL: ["LOCA_ID", "GEOL_TOP", "GEOL_BASE", "GEOL_DESC", "GEOL_LEG"],
    SAMP: ["LOCA_ID", "SAMP_ID", "SAMP_TYPE"],
    ISPT: ["LOCA_ID", "ISPT_TOP", "ISPT_NVAL"],
    WSTK: ["LOCA_ID", "WSTK_DPTH"],
    LLPL: ["LOCA_ID", "SAMP_ID", "SAMP_REF", "LLPL_LL", "LLPL_PL", "LLPL_PI", "LLPL_425"],
    LDEN: ["LOCA_ID", "SAMP_ID", "SAMP_REF", "LDEN_BULK", "LDEN_BDEN", "LDEN_MC"],
    LPDN: ["LOCA_ID", "SAMP_ID", "SAMP_REF", "LPDN_PD", "LPDN_MCMC"],
    LPEN: ["LOCA_ID", "SAMP_ID", "SAMP_REF", "LPEN_DEPTH", "LPEN_STRE"],
    LCON: ["LOCA_ID", "SAMP_ID", "SAMP_REF", "LCON_VERT", "LCON_VOID", "LCON_RHVC"],
    LCBR: ["LOCA_ID", "SAMP_ID", "SAMP_REF", "LCBR_COND", "LCBR_CBR"],
    IDEN: ["LOCA_ID", "IDEN_DPTH", "IDEN_DIAM", "IDEN_MC", "IDEN_DBUL"],
    IVAN: ["LOCA_ID", "IVAN_DPTH", "IVAN_TESN", "IVAN_STEN", "IVAN_RTEN"],
    IPRM: ["LOCA_ID", "IPRM_TOP", "IPRM_BOT", "IPRM_TYPE", "IPRM_PERM"],
    IPRT: ["LOCA_ID", "IPRT_DPTH", "IPRT_TYPE", "IPRT_PL", "IPRT_LLD"],
    IRDX: ["LOCA_ID", "IRDX_DPTH", "IRDX_RES"],
    ICBR: ["LOCA_ID", "ICBR_DPTH", "ICBR_CBR1", "ICBR_CBR2"],
    CDIA: ["LOCA_ID", "CDIA_DPTH", "CDIA_DIAM", "CDIA_TYPE"],
    CMET: ["LOCA_ID", "CMET_TOP", "CMET_BASE", "CMET_METH"],
    MOND: ["LOCA_ID", "MOND_DPTH", "MOND_TYPE", "MOND_MEAS", "MOND_TREF"],
    PREM: ["LOCA_ID", "PREM_DATE", "PREM_HEAD", "PREM_DPTH"],
    PRTM: ["LOCA_ID", "PRTM_DATE", "PRTM_PRES", "PRTM_TEMP"],
    STCN: ["LOCA_ID", "STCN_DPTH", "STCN_RES", "STCN_FRES", "STCN_QT"],
    RELD: ["LOCA_ID", "SAMP_TOP", "RELD_DMAX", "RELD_DMIN", "RELD_DRY"],
  };

  for (const [gname, group] of Object.entries(file.groups)) {
    const mapped = MAPPED_FIELDS[gname];
    if (!mapped) continue;
    const mappedSet = new Set(mapped);
    const unmapped = group.headings.map((hd) => hd.name).filter((n) => !mappedSet.has(n));
    if (unmapped.length > 0) {
      report.unmapped_fields[gname] = unmapped;
    }
  }

  parts.push("</Diggs>");
  return { xml: parts.join(""), report };
}

// ── Reader ────────────────────────────────────────────────────────────────────

/**
 * Strip an XML namespace prefix from a local name.
 * e.g. "gml:name" → "name", "name" → "name"
 */
function localName(tag: string): string {
  const colon = tag.lastIndexOf(":");
  return colon >= 0 ? tag.slice(colon + 1) : tag;
}

/** Unescape XML character references and entities in text content. */
function xmlUnescape(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

/** Parse a numeric string; return a number AgsValue if parseable, else a string. */
function parseValue(s: string): AgsValue {
  const n = parseFloat(s);
  return isNaN(n) ? s : String(n);
}

// ── Minimal pull-style XML tokeniser ─────────────────────────────────────────

type XmlToken =
  | { kind: "open"; tag: string; attrs: Map<string, string>; selfClose: boolean }
  | { kind: "close"; tag: string }
  | { kind: "text"; value: string };

/** Tokenise XML into a flat sequence of open/close/text tokens. */
function* tokenise(xml: string): Generator<XmlToken> {
  let i = 0;
  const len = xml.length;

  while (i < len) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      // trailing text
      const text = xmlUnescape(xml.slice(i));
      if (text.trim()) yield { kind: "text", value: text };
      break;
    }
    if (lt > i) {
      const text = xmlUnescape(xml.slice(i, lt));
      if (text.trim()) yield { kind: "text", value: text };
    }
    i = lt + 1;

    if (xml[i] === "!") {
      // Comment or CDATA
      if (xml.startsWith("!--", i)) {
        const end = xml.indexOf("-->", i + 3);
        i = end < 0 ? len : end + 3;
      } else if (xml.startsWith("![CDATA[", i)) {
        const end = xml.indexOf("]]>", i + 8);
        if (end >= 0) {
          const cdata = xml.slice(i + 8, end);
          if (cdata.trim()) yield { kind: "text", value: cdata };
          i = end + 3;
        } else {
          i = len;
        }
      } else {
        i = (xml.indexOf(">", i) ?? len - 1) + 1;
      }
      continue;
    }

    if (xml[i] === "?") {
      // Processing instruction
      const end = xml.indexOf("?>", i + 1);
      i = end < 0 ? len : end + 2;
      continue;
    }

    // Find end of tag
    const gt = xml.indexOf(">", i);
    if (gt < 0) break;
    const raw = xml.slice(i, gt);
    i = gt + 1;

    const selfClose = raw.endsWith("/");
    const inner = selfClose ? raw.slice(0, -1).trimEnd() : raw;

    if (inner.startsWith("/")) {
      // Closing tag
      yield { kind: "close", tag: inner.slice(1).trim() };
      continue;
    }

    // Opening tag — split tag name from attributes
    const spaceIdx = inner.search(/[\s]/);
    let tagName: string;
    let attrStr: string;
    if (spaceIdx < 0) {
      tagName = inner;
      attrStr = "";
    } else {
      tagName = inner.slice(0, spaceIdx);
      attrStr = inner.slice(spaceIdx);
    }

    const attrs = parseAttrs(attrStr);
    yield { kind: "open", tag: tagName, attrs, selfClose };
    if (selfClose) {
      yield { kind: "close", tag: tagName };
    }
  }
}

/** Parse XML attribute string into a Map of name→value (unescaped). */
function parseAttrs(s: string): Map<string, string> {
  const result = new Map<string, string>();
  // Match: name="value" or name='value'
  const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const name = m[1];
    const raw = m[2] ?? m[3] ?? "";
    const value = xmlUnescape(raw);
    if (name !== undefined) result.set(name, value);
  }
  return result;
}

// ── push_full_row equivalent ──────────────────────────────────────────────────

function pushFullRow(
  groups: Record<string, AgsGroup>,
  groupName: string,
  headings: AgsHeading[],
  row: Record<string, AgsValue>,
): void {
  let group = groups[groupName];
  if (!group) {
    group = {
      name: groupName,
      headings: headings.slice(),
      rows: [],
      source_line: Option.none(),
    };
    groups[groupName] = group;
  } else if (group.headings.length === 0) {
    group.headings = headings.slice();
  } else {
    // Merge in any new headings
    for (const hd of headings) {
      if (!group.headings.some((existing) => existing.name === hd.name)) {
        group.headings.push(hd);
      }
    }
  }
  // Ensure all headings are present in the row (fill with null)
  for (const hd of headings) {
    if (!(hd.name in row)) {
      row[hd.name] = null;
    }
  }
  group.rows.push(row);
}

// ── State machine types for the reader ────────────────────────────────────────

type ActiveRow =
  | { kind: "proj"; row: Record<string, AgsValue> }
  | { kind: "loca"; row: Record<string, AgsValue> }
  | { kind: "geol"; row: Record<string, AgsValue> }
  | { kind: "samp"; row: Record<string, AgsValue> }
  | { kind: "ispt"; row: Record<string, AgsValue> }
  | { kind: "wstk"; row: Record<string, AgsValue> }
  | { kind: "llpl"; row: Record<string, AgsValue> }
  | { kind: "lden"; row: Record<string, AgsValue> }
  | { kind: "lpdn"; row: Record<string, AgsValue> }
  | { kind: "lpen"; row: Record<string, AgsValue> }
  | { kind: "lcon"; row: Record<string, AgsValue> }
  | { kind: "lcbr"; row: Record<string, AgsValue> }
  | { kind: "iden"; row: Record<string, AgsValue> }
  | { kind: "ivan"; row: Record<string, AgsValue> }
  | { kind: "iprm"; row: Record<string, AgsValue> }
  | { kind: "iprt"; row: Record<string, AgsValue> }
  | { kind: "irdx"; row: Record<string, AgsValue> }
  | { kind: "icbr"; row: Record<string, AgsValue> }
  | { kind: "cdia"; row: Record<string, AgsValue> }
  | { kind: "cmet"; row: Record<string, AgsValue> }
  | { kind: "mond"; row: Record<string, AgsValue> }
  | { kind: "prem"; row: Record<string, AgsValue> }
  | { kind: "prtm"; row: Record<string, AgsValue> }
  | { kind: "stcn"; row: Record<string, AgsValue> }
  | { kind: "reld"; row: Record<string, AgsValue> };

interface MetaGroupState {
  name: string;
  headings: AgsHeading[];
  rows: AgsRow[];
  currentRow: Record<string, AgsValue> | null;
  currentFieldName: string | null;
}

/**
 * Parse a DIGGS 2.6 XML string into an AgsFile.
 */
export function readDiggs(input: string): AgsFile {
  const groups: Record<string, AgsGroup> = {};
  const path: string[] = [];

  let activeRow: ActiveRow | null = null;
  let metaGroup: MetaGroupState | null = null;

  for (const token of tokenise(input)) {
    switch (token.kind) {
      case "open": {
        const tag = localName(token.tag);
        switch (tag) {
          case "Project":
            activeRow = { kind: "proj", row: {} };
            break;
          case "SamplingLocation":
            activeRow = { kind: "loca", row: {} };
            break;
          case "Lithology":
            activeRow = { kind: "geol", row: {} };
            break;
          case "Sample":
            activeRow = { kind: "samp", row: {} };
            break;
          case "SPTTest":
            activeRow = { kind: "ispt", row: {} };
            break;
          case "WaterStrike":
            activeRow = { kind: "wstk", row: {} };
            break;
          // wave B
          case "AttenbergLimits":
            activeRow = { kind: "llpl", row: {} };
            break;
          case "BulkDensityTest":
            activeRow = { kind: "lden", row: {} };
            break;
          case "ParticleDensityTest":
            activeRow = { kind: "lpdn", row: {} };
            break;
          case "PenetratorTest":
            activeRow = { kind: "lpen", row: {} };
            break;
          case "OedometerTest":
            activeRow = { kind: "lcon", row: {} };
            break;
          case "CBRTest":
            activeRow = { kind: "lcbr", row: {} };
            break;
          // wave C
          case "InSituDensityTest":
            activeRow = { kind: "iden", row: {} };
            break;
          case "VaneTest":
            activeRow = { kind: "ivan", row: {} };
            break;
          case "PermeabilityTest":
            activeRow = { kind: "iprm", row: {} };
            break;
          case "PressuremeterTest":
            activeRow = { kind: "iprt", row: {} };
            break;
          case "RedoxTest":
            activeRow = { kind: "irdx", row: {} };
            break;
          case "InSituCBRTest":
            activeRow = { kind: "icbr", row: {} };
            break;
          case "CasingRecord":
            activeRow = { kind: "cdia", row: {} };
            break;
          case "DrillingMethod":
            activeRow = { kind: "cmet", row: {} };
            break;
          // wave D
          case "MonitoringReading":
            activeRow = { kind: "mond", row: {} };
            break;
          case "PiezometerReading":
            activeRow = { kind: "prem", row: {} };
            break;
          case "PressureTempReading":
            activeRow = { kind: "prtm", row: {} };
            break;
          case "StaticConeTest":
            activeRow = { kind: "stcn", row: {} };
            break;
          case "RelativeDensityTest":
            activeRow = { kind: "reld", row: {} };
            break;
          // generic groups
          case "MetadataGroup":
          case "DataGroup": {
            const name = token.attrs.get("name") ?? "";
            metaGroup = {
              name,
              headings: [],
              rows: [],
              currentRow: null,
              currentFieldName: null,
            };
            break;
          }
          case "heading": {
            if (metaGroup) {
              const hName = token.attrs.get("name") ?? "";
              const hUnit = token.attrs.get("unit") ?? "";
              const hTypeStr = token.attrs.get("type") ?? "X";
              if (hName) {
                metaGroup.headings.push({
                  name: hName,
                  unit: hUnit,
                  data_type: AgsTypeFunctions.parse(hTypeStr),
                });
              }
            }
            break;
          }
          case "row": {
            if (metaGroup) {
              metaGroup.currentRow = {};
            }
            break;
          }
          case "field": {
            if (metaGroup) {
              metaGroup.currentFieldName = token.attrs.get("name") ?? null;
            }
            break;
          }
          default:
            break;
        }
        path.push(tag);
        break;
      }

      case "close": {
        const tag = localName(token.tag);
        switch (tag) {
          case "Project":
            if (activeRow?.kind === "proj") {
              pushFullRow(groups, "PROJ", projHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "SamplingLocation":
            if (activeRow?.kind === "loca") {
              pushFullRow(groups, "LOCA", locaHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "Lithology":
            if (activeRow?.kind === "geol") {
              pushFullRow(groups, "GEOL", geolHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "Sample":
            if (activeRow?.kind === "samp") {
              pushFullRow(groups, "SAMP", sampHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "SPTTest":
            if (activeRow?.kind === "ispt") {
              pushFullRow(groups, "ISPT", isptHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "WaterStrike":
            if (activeRow?.kind === "wstk") {
              pushFullRow(groups, "WSTK", wstkHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "AttenbergLimits":
            if (activeRow?.kind === "llpl") {
              pushFullRow(groups, "LLPL", llplHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "BulkDensityTest":
            if (activeRow?.kind === "lden") {
              pushFullRow(groups, "LDEN", ldenHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "ParticleDensityTest":
            if (activeRow?.kind === "lpdn") {
              pushFullRow(groups, "LPDN", lpdnHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "PenetratorTest":
            if (activeRow?.kind === "lpen") {
              pushFullRow(groups, "LPEN", lpenHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "OedometerTest":
            if (activeRow?.kind === "lcon") {
              pushFullRow(groups, "LCON", lconHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "CBRTest":
            if (activeRow?.kind === "lcbr") {
              pushFullRow(groups, "LCBR", lcbrHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "InSituDensityTest":
            if (activeRow?.kind === "iden") {
              pushFullRow(groups, "IDEN", idenHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "VaneTest":
            if (activeRow?.kind === "ivan") {
              pushFullRow(groups, "IVAN", ivanHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "PermeabilityTest":
            if (activeRow?.kind === "iprm") {
              pushFullRow(groups, "IPRM", iprmHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "PressuremeterTest":
            if (activeRow?.kind === "iprt") {
              pushFullRow(groups, "IPRT", iprtHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "RedoxTest":
            if (activeRow?.kind === "irdx") {
              pushFullRow(groups, "IRDX", irdxHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "InSituCBRTest":
            if (activeRow?.kind === "icbr") {
              pushFullRow(groups, "ICBR", icbrHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "CasingRecord":
            if (activeRow?.kind === "cdia") {
              pushFullRow(groups, "CDIA", cdiaHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "DrillingMethod":
            if (activeRow?.kind === "cmet") {
              pushFullRow(groups, "CMET", cmetHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "MonitoringReading":
            if (activeRow?.kind === "mond") {
              pushFullRow(groups, "MOND", mondHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "PiezometerReading":
            if (activeRow?.kind === "prem") {
              pushFullRow(groups, "PREM", premHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "PressureTempReading":
            if (activeRow?.kind === "prtm") {
              pushFullRow(groups, "PRTM", prtmHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "StaticConeTest":
            if (activeRow?.kind === "stcn") {
              pushFullRow(groups, "STCN", stcnHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "RelativeDensityTest":
            if (activeRow?.kind === "reld") {
              pushFullRow(groups, "RELD", reldHeadings(), activeRow.row);
              activeRow = null;
            }
            break;
          case "MetadataGroup":
          case "DataGroup": {
            if (metaGroup && metaGroup.name) {
              const grp: AgsGroup = {
                name: metaGroup.name,
                headings: metaGroup.headings,
                rows: metaGroup.rows,
                source_line: Option.none(),
              };
              groups[metaGroup.name] = grp;
            }
            metaGroup = null;
            break;
          }
          case "row": {
            if (metaGroup && metaGroup.currentRow !== null) {
              const row = metaGroup.currentRow;
              // Ensure all headings are present
              for (const hd of metaGroup.headings) {
                if (!(hd.name in row)) {
                  row[hd.name] = null;
                }
              }
              metaGroup.rows.push(row);
              metaGroup.currentRow = null;
            }
            break;
          }
          case "field": {
            if (metaGroup) {
              metaGroup.currentFieldName = null;
            }
            break;
          }
          default:
            break;
        }
        path.pop();
        break;
      }

      case "text": {
        const text = token.value;

        // If we're inside a MetadataGroup/DataGroup field, handle it there.
        if (metaGroup && metaGroup.currentFieldName !== null && metaGroup.currentRow !== null) {
          const fieldName = metaGroup.currentFieldName;
          const hd = metaGroup.headings.find((x) => x.name === fieldName);
          const isNumeric = hd ? AgsTypeFunctions.isNumeric(hd.data_type) : false;
          let value: AgsValue;
          if (isNumeric) {
            const n = parseFloat(text);
            value = isNaN(n) ? text : n;
          } else {
            value = text;
          }
          metaGroup.currentRow[fieldName] = value;
          break;
        }

        // Otherwise feed into whichever native-group row is active.
        if (!activeRow) break;

        // The tag at the top of the path is the current element we're in.
        const currentTag = path.length > 0 ? path[path.length - 1] : "";

        switch (activeRow.kind) {
          case "proj":
            switch (currentTag) {
              case "name":
                activeRow.row["PROJ_ID"] = text;
                break;
              case "description":
                activeRow.row["PROJ_NAME"] = text;
                break;
            }
            break;
          case "loca":
            switch (currentTag) {
              case "name":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "easting":
                activeRow.row["LOCA_NATE"] = parseValue(text);
                break;
              case "northing":
                activeRow.row["LOCA_NATN"] = parseValue(text);
                break;
            }
            break;
          case "geol":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "topDepth":
                activeRow.row["GEOL_TOP"] = parseValue(text);
                break;
              case "baseDepth":
                activeRow.row["GEOL_BASE"] = parseValue(text);
                break;
              case "description":
                activeRow.row["GEOL_DESC"] = text;
                break;
              case "legendCode":
                activeRow.row["GEOL_LEG"] = text;
                break;
            }
            break;
          case "samp":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "sampleId":
                activeRow.row["SAMP_ID"] = text;
                break;
              case "sampleType":
                activeRow.row["SAMP_TYPE"] = text;
                break;
            }
            break;
          case "ispt":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "testDepth":
                activeRow.row["ISPT_TOP"] = parseValue(text);
                break;
              case "blowCount":
                activeRow.row["ISPT_NVAL"] = parseValue(text);
                break;
            }
            break;
          case "wstk":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "strikeDepth":
                activeRow.row["WSTK_DPTH"] = parseValue(text);
                break;
            }
            break;
          case "llpl":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "sampleId":
                activeRow.row["SAMP_ID"] = text;
                break;
              case "sampleRef":
                activeRow.row["SAMP_REF"] = text;
                break;
              case "liquidLimit":
                activeRow.row["LLPL_LL"] = parseValue(text);
                break;
              case "plasticLimit":
                activeRow.row["LLPL_PL"] = parseValue(text);
                break;
              case "plasticityIndex":
                activeRow.row["LLPL_PI"] = parseValue(text);
                break;
              case "percentPassing425":
                activeRow.row["LLPL_425"] = parseValue(text);
                break;
            }
            break;
          case "lden":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "sampleId":
                activeRow.row["SAMP_ID"] = text;
                break;
              case "sampleRef":
                activeRow.row["SAMP_REF"] = text;
                break;
              case "bulkDensity":
                activeRow.row["LDEN_BULK"] = parseValue(text);
                break;
              case "dryDensity":
                activeRow.row["LDEN_BDEN"] = parseValue(text);
                break;
              case "moistureContent":
                activeRow.row["LDEN_MC"] = parseValue(text);
                break;
            }
            break;
          case "lpdn":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "sampleId":
                activeRow.row["SAMP_ID"] = text;
                break;
              case "sampleRef":
                activeRow.row["SAMP_REF"] = text;
                break;
              case "particleDensity":
                activeRow.row["LPDN_PD"] = parseValue(text);
                break;
              case "moistureContent":
                activeRow.row["LPDN_MCMC"] = parseValue(text);
                break;
            }
            break;
          case "lpen":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "sampleId":
                activeRow.row["SAMP_ID"] = text;
                break;
              case "sampleRef":
                activeRow.row["SAMP_REF"] = text;
                break;
              case "testDepth":
                activeRow.row["LPEN_DEPTH"] = parseValue(text);
                break;
              case "undrainedStrength":
                activeRow.row["LPEN_STRE"] = parseValue(text);
                break;
            }
            break;
          case "lcon":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "sampleId":
                activeRow.row["SAMP_ID"] = text;
                break;
              case "sampleRef":
                activeRow.row["SAMP_REF"] = text;
                break;
              case "verticalStress":
                activeRow.row["LCON_VERT"] = parseValue(text);
                break;
              case "voidRatio":
                activeRow.row["LCON_VOID"] = parseValue(text);
                break;
              case "compressionCoefficient":
                activeRow.row["LCON_RHVC"] = parseValue(text);
                break;
            }
            break;
          case "lcbr":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "sampleId":
                activeRow.row["SAMP_ID"] = text;
                break;
              case "sampleRef":
                activeRow.row["SAMP_REF"] = text;
                break;
              case "condition":
                activeRow.row["LCBR_COND"] = text;
                break;
              case "cbrValue":
                activeRow.row["LCBR_CBR"] = parseValue(text);
                break;
            }
            break;
          case "iden":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "testDepth":
                activeRow.row["IDEN_DPTH"] = parseValue(text);
                break;
              case "diameter":
                activeRow.row["IDEN_DIAM"] = parseValue(text);
                break;
              case "moistureContent":
                activeRow.row["IDEN_MC"] = parseValue(text);
                break;
              case "dryDensity":
                activeRow.row["IDEN_DBUL"] = parseValue(text);
                break;
            }
            break;
          case "ivan":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "testDepth":
                activeRow.row["IVAN_DPTH"] = parseValue(text);
                break;
              case "testNumber":
                activeRow.row["IVAN_TESN"] = text;
                break;
              case "undrainedStrength":
                activeRow.row["IVAN_STEN"] = parseValue(text);
                break;
              case "remoulded Strength":
                activeRow.row["IVAN_RTEN"] = parseValue(text);
                break;
            }
            break;
          case "iprm":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "topDepth":
                activeRow.row["IPRM_TOP"] = parseValue(text);
                break;
              case "bottomDepth":
                activeRow.row["IPRM_BOT"] = parseValue(text);
                break;
              case "testType":
                activeRow.row["IPRM_TYPE"] = text;
                break;
              case "permeability":
                activeRow.row["IPRM_PERM"] = parseValue(text);
                break;
            }
            break;
          case "iprt":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "testDepth":
                activeRow.row["IPRT_DPTH"] = parseValue(text);
                break;
              case "testType":
                activeRow.row["IPRT_TYPE"] = text;
                break;
              case "limitPressure":
                activeRow.row["IPRT_PL"] = parseValue(text);
                break;
              case "liftoffPressure":
                activeRow.row["IPRT_LLD"] = parseValue(text);
                break;
            }
            break;
          case "irdx":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "testDepth":
                activeRow.row["IRDX_DPTH"] = parseValue(text);
                break;
              case "redoxPotential":
                activeRow.row["IRDX_RES"] = parseValue(text);
                break;
            }
            break;
          case "icbr":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "testDepth":
                activeRow.row["ICBR_DPTH"] = parseValue(text);
                break;
              case "cbrValue1":
                activeRow.row["ICBR_CBR1"] = parseValue(text);
                break;
              case "cbrValue2":
                activeRow.row["ICBR_CBR2"] = parseValue(text);
                break;
            }
            break;
          case "cdia":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "depth":
                activeRow.row["CDIA_DPTH"] = parseValue(text);
                break;
              case "diameter":
                activeRow.row["CDIA_DIAM"] = parseValue(text);
                break;
              case "casingType":
                activeRow.row["CDIA_TYPE"] = text;
                break;
            }
            break;
          case "cmet":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "topDepth":
                activeRow.row["CMET_TOP"] = parseValue(text);
                break;
              case "baseDepth":
                activeRow.row["CMET_BASE"] = parseValue(text);
                break;
              case "method":
                activeRow.row["CMET_METH"] = text;
                break;
            }
            break;
          case "mond":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "depth":
                activeRow.row["MOND_DPTH"] = parseValue(text);
                break;
              case "instrumentType":
                activeRow.row["MOND_TYPE"] = text;
                break;
              case "measurement":
                activeRow.row["MOND_MEAS"] = parseValue(text);
                break;
              case "readingDate":
                activeRow.row["MOND_TREF"] = text;
                break;
            }
            break;
          case "prem":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "readingDate":
                activeRow.row["PREM_DATE"] = text;
                break;
              case "hydraulicHead":
                activeRow.row["PREM_HEAD"] = parseValue(text);
                break;
              case "installDepth":
                activeRow.row["PREM_DPTH"] = parseValue(text);
                break;
            }
            break;
          case "prtm":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "readingDate":
                activeRow.row["PRTM_DATE"] = text;
                break;
              case "pressure":
                activeRow.row["PRTM_PRES"] = parseValue(text);
                break;
              case "temperature":
                activeRow.row["PRTM_TEMP"] = parseValue(text);
                break;
            }
            break;
          case "stcn":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "testDepth":
                activeRow.row["STCN_DPTH"] = parseValue(text);
                break;
              case "conePenetrationResistance":
                activeRow.row["STCN_RES"] = parseValue(text);
                break;
              case "frictionResistance":
                activeRow.row["STCN_FRES"] = parseValue(text);
                break;
              case "correctedConeResistance":
                activeRow.row["STCN_QT"] = parseValue(text);
                break;
            }
            break;
          case "reld":
            switch (currentTag) {
              case "locationId":
                activeRow.row["LOCA_ID"] = text;
                break;
              case "sampleDepth":
                activeRow.row["SAMP_TOP"] = parseValue(text);
                break;
              case "maximumDryDensity":
                activeRow.row["RELD_DMAX"] = parseValue(text);
                break;
              case "minimumDryDensity":
                activeRow.row["RELD_DMIN"] = parseValue(text);
                break;
              case "dryDensity":
                activeRow.row["RELD_DRY"] = parseValue(text);
                break;
            }
            break;
        }
        break;
      }
    }
  }

  return {
    groups,
    source_path: Option.none(),
    ags_version: Option.none(),
  };
}
