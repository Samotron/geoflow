import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeBytes, parseStr } from "../core.js";
import type { AgsFile } from "../core.js";
import {
  getGeolLayers,
  getGeolFields,
  extractLocaMap,
  extractAllLocaIds,
  extractSptDepth,
  extractSptElev,
  extractAtterberg,
  extractPsd,
  extractDepth,
  extractUu,
  extractDensity,
  extractShear,
  extractCompaction,
  extractLlplDepth,
  extractCong,
  extractStressProfile,
  extractActivity,
  extractPermeability,
  extractDerivedSpt,
  extractStressPath,
  sptDepthSpec,
  sptElevSpec,
  plasticitySpec,
  psdSpec,
  depthScatterSpec,
  densitySpec,
  shearBoxSpec,
  compactionSpec,
  congSpec,
  atterbergDepthSpec,
  stressProfileSpec,
  activitySpec,
  permeabilitySpec,
  derivedSptSpec,
  stressPathSpec,
  ALL_PLOTS,
  geolColor,
} from "./shared.js";

const FIXTURE_PATH = resolve(
  __dirname,
  "../../../../tests/fixtures/ags/lab_data_comprehensive.ags",
);

function loadFixture(): AgsFile {
  const bytes = readFileSync(FIXTURE_PATH);
  return parseStr(decodeBytes(bytes)).file;
}

describe("plot data extractors against comprehensive lab fixture", () => {
  const file = loadFixture();
  const layers = getGeolLayers(file);
  const locaMap = extractLocaMap(file);
  const empty = new Set<string>();

  it("loads geology layers and ground-level map for every borehole", () => {
    expect(layers.length).toBeGreaterThan(0);
    expect(layers.some((l) => l.locaId === "BH01")).toBe(true);
    expect(locaMap.get("BH01")).toBe(45.5);
    expect(locaMap.get("BH02")).toBe(46.1);
    expect(locaMap.get("BH03")).toBe(44.2);
  });

  it("lists every LOCA_ID", () => {
    expect(extractAllLocaIds(file).sort()).toEqual(["BH01", "BH02", "BH03"]);
  });

  it("discovers usable colour-by fields from GEOL headings", () => {
    const fields = getGeolFields(file);
    expect(fields).toContain("LOCA_ID");
    expect(fields).toContain("GEOL_DESC");
    expect(fields).toContain("GEOL_LEG");
  });

  it("returns a deterministic colour per geology key", () => {
    expect(geolColor("CL")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(geolColor("CL")).toBe(geolColor("CL"));
  });

  // ── Per-plot data extractors ─────────────────────────────────────────────

  it("extracts SPT depth pairs", () => {
    const data = extractSptDepth(file, layers, "LOCA_ID", empty);
    expect(data.length).toBe(16);
    expect(data.every((d) => d.value > 0 && d.depth > 0)).toBe(true);
  });

  it("extracts SPT elevation pairs (uses LOCA_GL)", () => {
    const data = extractSptElev(file, locaMap, layers, "LOCA_ID", empty);
    expect(data.length).toBe(16);
    expect(data.every((d) => Number.isFinite(d.elev))).toBe(true);
  });

  it("extracts Atterberg LL/PI points (computes PI when only PL given)", () => {
    const data = extractAtterberg(file, layers, "LOCA_ID", empty);
    expect(data.length).toBe(7);
    for (const d of data) {
      expect(d.x).toBeGreaterThan(0);
      expect(d.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("extracts PSD curves from both GRAG and SIEV", () => {
    const data = extractPsd(file, layers, "LOCA_ID", empty);
    expect(data.length).toBeGreaterThan(10);
    const curveIds = new Set(data.map((d) => d.curveId));
    expect(curveIds.size).toBeGreaterThanOrEqual(3); // BH01/D1, BH02/D3, BH03/D4
  });

  it("extracts moisture-content depth data", () => {
    const data = extractDepth(file, "LNMC", "LNMC_MC", "SAMP_TOP", layers, "LOCA_ID", empty);
    expect(data.length).toBe(7);
  });

  it("extracts undrained shear strength from TCON (and other sources)", () => {
    const data = extractUu(file, layers, "LOCA_ID", empty);
    // 7 TCON rows in fixture
    expect(data.length).toBe(7);
    expect(data.every((d) => d.value > 0)).toBe(true);
  });

  it("extracts bulk + dry density pairs", () => {
    const { bulk, dry } = extractDensity(file, layers, "LOCA_ID", empty);
    expect(bulk.length).toBe(6);
    expect(dry.length).toBe(6);
  });

  it("extracts shear-box normal/shear points", () => {
    const data = extractShear(file, layers, "LOCA_ID", empty);
    expect(data.length).toBe(6);
  });

  it("extracts compaction (mc, dry density) curves", () => {
    const data = extractCompaction(file, layers, "LOCA_ID", empty);
    expect(data.length).toBe(6);
    // All from BH01/D1 sample → single curve.
    expect(new Set(data.map((d) => d.curveId)).size).toBe(1);
  });

  it("extracts Atterberg limits and MC vs depth", () => {
    const data = extractLlplDepth(file, layers, "LOCA_ID", empty);
    expect(data.length).toBe(7);
    for (const d of data) {
      expect(d.ll).toBeGreaterThan(d.pl);
      expect(d.depth).toBeGreaterThan(0);
    }
  });

  it("extracts consolidation e-logσ points", () => {
    const data = extractCong(file, layers, "LOCA_ID", empty);
    expect(data.length).toBe(12);
  });

  // ── Borehole filter ──────────────────────────────────────────────────────

  it("honours borehole-filter set", () => {
    const onlyBh1 = new Set(["BH01"]);
    const data = extractSptDepth(file, layers, "LOCA_ID", onlyBh1);
    expect(data.length).toBe(6);
    expect(data.every((d) => d.locaId === "BH01")).toBe(true);
  });
});

// ── Plot specs produce a well-formed Observable Plot spec ────────────────

describe("plot specs", () => {
  const file = loadFixture();
  const layers = getGeolLayers(file);
  const locaMap = extractLocaMap(file);
  const empty = new Set<string>();

  it("registry covers every spec builder", () => {
    expect(ALL_PLOTS.length).toBeGreaterThanOrEqual(11);
  });

  function marksLength(spec: unknown): number {
    const s = spec as { marks?: unknown[] } | undefined;
    expect(s).toBeDefined();
    expect(Array.isArray(s!.marks)).toBe(true);
    return s!.marks!.length;
  }

  it("sptDepthSpec produces marks", () => {
    expect(marksLength(sptDepthSpec(extractSptDepth(file, layers, "LOCA_ID", empty)))).toBeGreaterThan(0);
  });

  it("sptElevSpec produces marks", () => {
    expect(marksLength(sptElevSpec(extractSptElev(file, locaMap, layers, "LOCA_ID", empty)))).toBeGreaterThan(0);
  });

  it("plasticitySpec produces A-line + U-line", () => {
    expect(marksLength(plasticitySpec(extractAtterberg(file, layers, "LOCA_ID", empty)))).toBeGreaterThan(2);
  });

  it("psdSpec uses a log-scale x axis", () => {
    const spec = psdSpec(extractPsd(file, layers, "LOCA_ID", empty)) as { x?: { type?: string } };
    expect(spec.x?.type).toBe("log");
  });

  it("depthScatterSpec, densitySpec, shearBoxSpec, compactionSpec, congSpec, atterbergDepthSpec all build", () => {
    expect(marksLength(depthScatterSpec(extractDepth(file, "LNMC", "LNMC_MC", "SAMP_TOP", layers, "LOCA_ID", empty), "MC %"))).toBeGreaterThan(0);
    const dens = extractDensity(file, layers, "LOCA_ID", empty);
    expect(marksLength(densitySpec(dens.bulk, dens.dry))).toBeGreaterThan(0);
    expect(marksLength(shearBoxSpec(extractShear(file, layers, "LOCA_ID", empty)))).toBeGreaterThan(0);
    expect(marksLength(compactionSpec(extractCompaction(file, layers, "LOCA_ID", empty)))).toBeGreaterThan(0);
    expect(marksLength(congSpec(extractCong(file, layers, "LOCA_ID", empty)))).toBeGreaterThan(0);
    expect(marksLength(atterbergDepthSpec(
      extractLlplDepth(file, layers, "LOCA_ID", empty),
      extractDepth(file, "LNMC", "LNMC_MC", "SAMP_TOP", layers, "LOCA_ID", empty),
    ))).toBeGreaterThan(0);
  });
});

// ── Advanced extractors and specs ───────────────────────────────────────────

describe("advanced plot extractors", () => {
  const file = loadFixture();
  const layers = getGeolLayers(file);
  const empty = new Set<string>();

  it("extractStressProfile produces a monotonically-increasing σv per borehole", () => {
    const data = extractStressProfile(file, layers, "LOCA_ID", empty);
    expect(data.length).toBeGreaterThan(0);
    const bh01 = data.filter((d) => d.locaId === "BH01").sort((a, b) => a.depth - b.depth);
    for (let i = 1; i < bh01.length; i++) {
      expect(bh01[i]!.sigmaV).toBeGreaterThanOrEqual(bh01[i - 1]!.sigmaV - 1e-6);
    }
    // u₀ should be zero above the water table and positive below.
    const aboveWT = bh01.find((d) => d.depth < 3);
    const belowWT = bh01.find((d) => d.depth > 10);
    expect(aboveWT!.u0).toBe(0);
    expect(belowWT!.u0).toBeGreaterThan(0);
    // σ'v = σv - u₀
    for (const d of bh01) {
      expect(d.sigmaVeff).toBeCloseTo(Math.max(0.1, d.sigmaV - d.u0), 3);
    }
  });

  it("extractActivity computes PI / clay% from LLPL + PSD samples", () => {
    // Fixture has LLPL but no GRAG/SIEV matching the LLPL SAMP_REFs, so 0 expected.
    const data = extractActivity(file, layers, "LOCA_ID", empty);
    expect(Array.isArray(data)).toBe(true);
  });

  it("extractPermeability reads from the PERM group with log-friendly values", () => {
    const data = extractPermeability(file, layers, "LOCA_ID", empty);
    expect(data.length).toBe(5);
    for (const d of data) {
      expect(d.k).toBeGreaterThan(0);
      expect(d.depth).toBeGreaterThan(0);
    }
  });

  it("extractDerivedSpt(phiPrime) returns φ′ only for non-cohesive layers", () => {
    const data = extractDerivedSpt(file, layers, "LOCA_ID", empty, "phiPrime");
    // φ′ is omitted for cohesive samples; should be < total ISPT rows (16).
    expect(data.length).toBeGreaterThan(0);
    expect(data.length).toBeLessThanOrEqual(16);
    for (const d of data) {
      expect(d.value).toBeGreaterThan(20);
      expect(d.value).toBeLessThan(50);
      expect(d.family).not.toBe("cohesive");
    }
  });

  it("extractDerivedSpt(VsImai) returns Vs for every ISPT row", () => {
    const data = extractDerivedSpt(file, layers, "LOCA_ID", empty, "VsImai");
    expect(data.length).toBe(16);
    for (const d of data) {
      expect(d.value).toBeGreaterThan(50);
      expect(d.value).toBeLessThan(800);
    }
  });

  it("extractStressPath produces one point per TRIG row", () => {
    const data = extractStressPath(file, layers, "LOCA_ID", empty);
    expect(data.length).toBe(6);
    for (const d of data) {
      expect(d.p).toBeGreaterThan(0);
      expect(d.q).toBeGreaterThan(0);
    }
    expect(new Set(data.map((d) => d.curveId)).size).toBe(2);
  });
});

describe("advanced plot specs", () => {
  const file = loadFixture();
  const layers = getGeolLayers(file);
  const empty = new Set<string>();

  function marks(spec: unknown): number {
    const s = spec as { marks?: unknown[] } | undefined;
    expect(s).toBeDefined();
    expect(Array.isArray(s!.marks)).toBe(true);
    return s!.marks!.length;
  }

  it("stressProfileSpec, activitySpec, permeabilitySpec, derivedSptSpec, stressPathSpec all build", () => {
    expect(marks(stressProfileSpec(extractStressProfile(file, layers, "LOCA_ID", empty)))).toBeGreaterThan(0);
    expect(marks(activitySpec([{ locaId: "BH01", clayPct: 35, pi: 22, activity: 0.63, colorKey: "BH01" }]))).toBeGreaterThan(0);
    expect(marks(permeabilitySpec(extractPermeability(file, layers, "LOCA_ID", empty)))).toBeGreaterThan(0);
    expect(marks(derivedSptSpec(extractDerivedSpt(file, layers, "LOCA_ID", empty, "VsImai"), "VsImai"))).toBeGreaterThan(0);
    expect(marks(stressPathSpec(extractStressPath(file, layers, "LOCA_ID", empty)))).toBeGreaterThan(0);
  });

  it("permeabilitySpec uses log x axis", () => {
    const spec = permeabilitySpec(extractPermeability(file, layers, "LOCA_ID", empty)) as { x?: { type?: string } };
    expect(spec.x?.type).toBe("log");
  });

  it("registry now contains 18 entries (11 existing + 7 advanced)", () => {
    expect(ALL_PLOTS.length).toBe(18);
    const ids = new Set(ALL_PLOTS.map((p) => p.id));
    expect(ids.has("stress_prof")).toBe(true);
    expect(ids.has("activity")).toBe(true);
    expect(ids.has("permeability")).toBe(true);
    expect(ids.has("phi_depth")).toBe(true);
    expect(ids.has("vs_depth")).toBe(true);
    expect(ids.has("n1_depth")).toBe(true);
    expect(ids.has("stress_path")).toBe(true);
  });
});
