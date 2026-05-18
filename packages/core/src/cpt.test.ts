import { describe, expect, it } from "vitest";
import {
  parseCptCsv,
  parseCptGef,
  deriveCpt,
  summariseSbtBands,
  renderCptSvg,
  sbtName,
} from "./cpt.js";
import type { CptSounding } from "./cpt.js";

// ── Parsing: CSV ──────────────────────────────────────────────────────────────

describe("parseCptCsv", () => {
  it("parses a simple comma-delimited CPT in MPa and converts to kPa", () => {
    const text = `depth,qc,fs,u2
0.5,1.2,0.012,0.005
1.0,1.5,0.014,0.005
1.5,2.0,0.020,0.010
`;
    const { sounding, errors, warnings } = parseCptCsv(text, { id: "CPT-01" });
    expect(errors).toEqual([]);
    expect(sounding).not.toBeNull();
    expect(sounding!.readings.length).toBe(3);
    // 1.2 MPa → 1200 kPa
    expect(sounding!.readings[0]!.qc).toBeCloseTo(1200, 1);
    expect(sounding!.readings[0]!.fs).toBeCloseTo(12, 1);
    expect(sounding!.readings[0]!.u2).toBeCloseTo(5, 1);
    expect(warnings.some(w => /qc as MPa/i.test(w))).toBe(true);
  });

  it("parses tab-separated and accepts native kPa input", () => {
    const text = `depth\tqc\tfs
1.0\t1500\t15
2.0\t1800\t18
3.0\t2400\t24
`;
    const { sounding, warnings } = parseCptCsv(text);
    expect(sounding).not.toBeNull();
    expect(sounding!.readings[0]!.qc).toBe(1500);
    expect(warnings.find(w => /qc as MPa/i.test(w))).toBeUndefined();
  });

  it("returns an error when required columns are missing", () => {
    const text = `depth,sleeve\n1.0,15\n`;
    const { sounding, errors } = parseCptCsv(text);
    expect(sounding).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });

  it("sorts depths ascending and skips non-numeric rows", () => {
    const text = `depth,qc,fs
2.0,1800,18
junk,nope,bad
1.0,1500,15
`;
    const { sounding } = parseCptCsv(text);
    expect(sounding).not.toBeNull();
    expect(sounding!.readings.map(r => r.depth)).toEqual([1.0, 2.0]);
  });
});

// ── Parsing: GEF ──────────────────────────────────────────────────────────────

describe("parseCptGef", () => {
  it("parses a minimal GEF file with COLUMNINFO header", () => {
    const text = `#GEFID= 1, 1, 0
#COLUMNINFO= 1, m, length, 11
#COLUMNINFO= 2, MPa, qc, 1
#COLUMNINFO= 3, MPa, fs, 2
#MEASUREMENTTEXT= 4, CPT-42
#ZID= 31000, 12.5, 0
#EOH=
0.50  1.20  0.012
1.00  1.50  0.014
1.50  2.00  0.020
`;
    const { sounding, errors } = parseCptGef(text);
    expect(errors).toEqual([]);
    expect(sounding).not.toBeNull();
    expect(sounding!.id).toBe("CPT-42");
    expect(sounding!.groundElev).toBe(12.5);
    expect(sounding!.readings.length).toBe(3);
    // 1.2 MPa → 1200 kPa
    expect(sounding!.readings[0]!.qc).toBeCloseTo(1200, 1);
  });

  it("falls back to default column ordering when no COLUMNINFO supplied", () => {
    const text = `#EOH=
0.5 1.2 0.012
1.0 1.5 0.014
`;
    const { sounding, warnings } = parseCptGef(text);
    expect(sounding).not.toBeNull();
    expect(sounding!.readings.length).toBe(2);
    expect(warnings.some(w => /assuming depth, qc, fs/i.test(w))).toBe(true);
  });
});

// ── Derivation ────────────────────────────────────────────────────────────────

function makeSounding(): CptSounding {
  // A simple two-layer profile: 0–4 m clay (low qc), 4–10 m sand (high qc)
  const readings: { depth: number; qc: number; fs: number; u2?: number }[] = [];
  for (let z = 0.5; z <= 10; z += 0.5) {
    if (z < 4) {
      readings.push({ depth: z, qc: 800, fs: 32, u2: 50 + z * 8 });   // clay
    } else {
      readings.push({ depth: z, qc: 12000, fs: 80, u2: 60 + z * 5 }); // sand
    }
  }
  return {
    id: "TEST",
    readings,
    netAreaRatio: 0.8,
    waterTableDepth: 2.0,
    unitWeightProfile: { kind: "constant", gamma: 19 },
  };
}

describe("deriveCpt", () => {
  it("produces a derived row for every reading", () => {
    const s = makeSounding();
    const d = deriveCpt(s);
    expect(d.length).toBe(s.readings.length);
  });

  it("computes total and effective stress monotonically", () => {
    const s = makeSounding();
    const d = deriveCpt(s);
    for (let i = 1; i < d.length; i++) {
      expect(d[i]!.sigmaV0).toBeGreaterThanOrEqual(d[i - 1]!.sigmaV0 - 1e-6);
      expect(d[i]!.sigmaV0Eff).toBeGreaterThan(0);
    }
  });

  it("classifies the clay layer as fine-grained (zones 2-4) and the sand as zones 5-7", () => {
    const s = makeSounding();
    const d = deriveCpt(s);
    const clayZones = d.filter(r => r.depth < 4).map(r => r.sbt);
    const sandZones = d.filter(r => r.depth >= 4.5).map(r => r.sbt);
    // Most clay zones should be fine-grained
    const finishCount = clayZones.filter(z => z >= 1 && z <= 4).length;
    expect(finishCount / clayZones.length).toBeGreaterThan(0.6);
    // Sand zones should be predominantly 5-7
    const coarseCount = sandZones.filter(z => z >= 5 && z <= 8).length;
    expect(coarseCount / sandZones.length).toBeGreaterThan(0.6);
  });

  it("derives Su in fine-grained zones and φ′/Dr in coarse-grained zones", () => {
    const s = makeSounding();
    const d = deriveCpt(s);
    const fines = d.filter(r => r.depth < 4 && r.Su !== undefined);
    const sands = d.filter(r => r.depth >= 4.5 && r.phiPrime !== undefined);
    expect(fines.length).toBeGreaterThan(0);
    expect(sands.length).toBeGreaterThan(0);
    // φ′ should be in a reasonable range for medium-dense sand
    for (const r of sands) {
      expect(r.phiPrime!).toBeGreaterThan(25);
      expect(r.phiPrime!).toBeLessThan(50);
    }
  });

  it("returns Bq = null when u2 is missing", () => {
    const s: CptSounding = {
      id: "no-u2",
      readings: [
        { depth: 1, qc: 1000, fs: 10 },
        { depth: 2, qc: 1200, fs: 12 },
      ],
    };
    const d = deriveCpt(s);
    expect(d[0]!.Bq).toBeNull();
  });
});

// ── SBT summary & SVG ─────────────────────────────────────────────────────────

describe("summariseSbtBands", () => {
  it("collapses contiguous zones into bands", () => {
    const s = makeSounding();
    const d = deriveCpt(s);
    const bands = summariseSbtBands(d);
    expect(bands.length).toBeGreaterThan(0);
    // Bands must be contiguous
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]!.topDepth).toBeCloseTo(bands[i - 1]!.baseDepth, 6);
    }
  });

  it("handles a single-zone profile", () => {
    const s: CptSounding = {
      id: "uniform",
      readings: [
        { depth: 1, qc: 10000, fs: 50 },
        { depth: 2, qc: 11000, fs: 55 },
        { depth: 3, qc: 12000, fs: 60 },
      ],
    };
    const d = deriveCpt(s);
    const bands = summariseSbtBands(d);
    expect(bands.length).toBe(1);
  });
});

describe("renderCptSvg", () => {
  it("produces an SVG string containing tracks", () => {
    const s = makeSounding();
    const d = deriveCpt(s);
    const svg = renderCptSvg(s, d);
    expect(svg).toMatch(/<svg/);
    expect(svg).toMatch(/qt \(kPa\)/);
    expect(svg).toMatch(/SBT/);
    expect(svg).toMatch(/<\/svg>/);
  });
});

describe("sbtName", () => {
  it("provides a human-readable name for each zone", () => {
    expect(sbtName(3)).toMatch(/[Cc]lay/);
    expect(sbtName(6)).toMatch(/[Ss]and/);
  });
});
