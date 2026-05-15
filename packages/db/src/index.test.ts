import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Option } from "effect";
import { PACKAGE_NAME, GeoflowDb, openDb } from "./index.js";
import type { AgsFile } from "@geoflow/core";

// ── Package identity ──────────────────────────────────────────────────────────

describe("@geoflow/db package", () => {
  it("exposes its package name", () => {
    expect(PACKAGE_NAME).toBe("@geoflow/db");
  });
});

// ── SQLite availability check ─────────────────────────────────────────────────

// Probe whether better-sqlite3 native bindings are usable.
// The JS wrapper loads without error; we must actually open a DB to confirm.
let sqliteAvailable = false;
try {
  const req = createRequire(import.meta.url);
  const Sqlite = req("better-sqlite3");
  const probe = new Sqlite(":memory:");
  probe.close();
  sqliteAvailable = true;
} catch {
  sqliteAvailable = false;
}

// ── Shared test fixtures ──────────────────────────────────────────────────────

function makeAgsFile(groups: AgsFile["groups"]): AgsFile {
  return { groups, source_path: Option.none(), ags_version: Option.none() };
}

const MINIMAL_FILE = makeAgsFile({
  PROJ: {
    name: "PROJ",
    headings: [
      { name: "PROJ_ID",   unit: "", data_type: "ID" },
      { name: "PROJ_NAME", unit: "", data_type: "X" },
    ],
    rows: [{ PROJ_ID: "P001", PROJ_NAME: "Test Project" }],
    source_line: Option.none(),
  },
  LOCA: {
    name: "LOCA",
    headings: [
      { name: "LOCA_ID",   unit: "", data_type: "ID" },
      { name: "LOCA_TYPE", unit: "", data_type: "X" },
      { name: "LOCA_NATE", unit: "m", data_type: { _tag: "DP", n: 2 } },
      { name: "LOCA_NATN", unit: "m", data_type: { _tag: "DP", n: 2 } },
      { name: "LOCA_GL",   unit: "m", data_type: { _tag: "DP", n: 2 } },
      { name: "LOCA_FDEP", unit: "m", data_type: { _tag: "DP", n: 2 } },
    ],
    rows: [
      { LOCA_ID: "BH01", LOCA_TYPE: "BH", LOCA_NATE: 530000.00, LOCA_NATN: 180000.00, LOCA_GL: 50.0, LOCA_FDEP: 12.0 },
      { LOCA_ID: "BH02", LOCA_TYPE: "BH", LOCA_NATE: 530050.00, LOCA_NATN: 180000.00, LOCA_GL: 49.5, LOCA_FDEP: 8.5 },
    ],
    source_line: Option.none(),
  },
  GEOL: {
    name: "GEOL",
    headings: [
      { name: "LOCA_ID",   unit: "", data_type: "ID" },
      { name: "GEOL_TOP",  unit: "m", data_type: { _tag: "DP", n: 2 } },
      { name: "GEOL_BASE", unit: "m", data_type: { _tag: "DP", n: 2 } },
      { name: "GEOL_DESC", unit: "", data_type: "X" },
    ],
    rows: [
      { LOCA_ID: "BH01", GEOL_TOP: 0.0, GEOL_BASE: 1.5, GEOL_DESC: "Topsoil" },
      { LOCA_ID: "BH01", GEOL_TOP: 1.5, GEOL_BASE: 12.0, GEOL_DESC: "Clay" },
      { LOCA_ID: "BH02", GEOL_TOP: 0.0, GEOL_BASE: 8.5, GEOL_DESC: "Clay" },
    ],
    source_line: Option.none(),
  },
});

// ── GeoflowDb integration tests ───────────────────────────────────────────────

describe.skipIf(!sqliteAvailable)("GeoflowDb", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "geoflow-db-test-"));
    dbPath = join(tmpDir, "test.gpkg");
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("opens without error and creates GeoPackage schema", () => {
    const db = openDb(dbPath);
    expect(db).toBeInstanceOf(GeoflowDb);
    db.close();
  });

  it("ingest returns correct import report", () => {
    const db = openDb(dbPath);
    try {
      const report = db.ingest(MINIMAL_FILE, "/test/source.ags");
      expect(report.sourceFile).toBe("/test/source.ags");
      expect(report.locaCount).toBe(2);
      expect(report.groupsImported).toContain("PROJ");
      expect(report.groupsImported).toContain("LOCA");
      expect(report.groupsImported).toContain("GEOL");
    } finally {
      db.close();
    }
  });

  it("queryGroup returns correct columns and rows for LOCA", () => {
    const db = openDb(dbPath);
    try {
      const result = db.queryGroup("LOCA");
      expect(result.group).toBe("LOCA");
      expect(result.columns).toContain("LOCA_ID");
      expect(result.columns).toContain("LOCA_FDEP");
      // Should not expose fid, geom, source_file, imported_at
      expect(result.columns).not.toContain("fid");
      expect(result.columns).not.toContain("geom");
      // Data rows
      const ids = result.rows.map((r) => r[result.columns.indexOf("LOCA_ID")]);
      expect(ids).toContain("BH01");
      expect(ids).toContain("BH02");
    } finally {
      db.close();
    }
  });

  it("queryGroup returns correct rows for GEOL", () => {
    const db = openDb(dbPath);
    try {
      const result = db.queryGroup("GEOL");
      expect(result.columns).toContain("GEOL_DESC");
      const descIdx = result.columns.indexOf("GEOL_DESC");
      const descs = result.rows.map((r) => r[descIdx]);
      expect(descs).toContain("Topsoil");
      expect(descs).toContain("Clay");
    } finally {
      db.close();
    }
  });

  it("queryGroup returns empty result for non-existent group", () => {
    const db = openDb(dbPath);
    try {
      const result = db.queryGroup("NONEXISTENT");
      expect(result.columns).toHaveLength(0);
      expect(result.rows).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("listImports returns one import record", () => {
    const db = openDb(dbPath);
    try {
      const imports = db.listImports();
      expect(imports.length).toBeGreaterThanOrEqual(1);
      const imp = imports[0]!;
      expect(imp.id).toBeGreaterThan(0);
      expect(typeof imp.importedAt).toBe("string");
      expect(imp.locaCount).toBe(2);
    } finally {
      db.close();
    }
  });

  it("listImports tracks multiple ingests", () => {
    const db = openDb(dbPath);
    try {
      db.ingest(MINIMAL_FILE, "/test/second.ags");
      const imports = db.listImports();
      expect(imports.length).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
  });

  it("queryLocaByBbox returns locations within bounding box", () => {
    const db = openDb(dbPath);
    try {
      // BH01 and BH02 are at BNG 530000/180000 area → WGS84 ~ -0.2°, 51.5°
      const results = db.queryLocaByBbox(-2, 50, 2, 53);
      // Should find both boreholes
      expect(results.length).toBeGreaterThanOrEqual(2);
      for (const r of results) {
        expect(r.loca_id).toBeTruthy();
        expect(isFinite(r.lon)).toBe(true);
        expect(isFinite(r.lat)).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("queryLocaByBbox returns nothing for out-of-range bbox", () => {
    const db = openDb(dbPath);
    try {
      // Australia bbox
      const results = db.queryLocaByBbox(110, -45, 155, -10);
      expect(results).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("LOCA rows include WGS84 lon/lat attributes", () => {
    const db = openDb(dbPath);
    try {
      const results = db.queryLocaByBbox(-2, 50, 2, 53);
      if (results.length > 0) {
        const first = results[0]!;
        // Longitude should be in western UK (~-0.2)
        expect(first.lon).toBeGreaterThan(-2);
        expect(first.lon).toBeLessThan(2);
        // Latitude should be in UK (~51.5)
        expect(first.lat).toBeGreaterThan(50);
        expect(first.lat).toBeLessThan(53);
      }
    } finally {
      db.close();
    }
  });

  it("handles file with lat/lon coordinates directly", () => {
    const fileWithLatLon = makeAgsFile({
      LOCA: {
        name: "LOCA",
        headings: [
          { name: "LOCA_ID",  unit: "", data_type: "ID" },
          { name: "LOCA_LAT", unit: "deg", data_type: { _tag: "DP", n: 6 } },
          { name: "LOCA_LON", unit: "deg", data_type: { _tag: "DP", n: 6 } },
          { name: "LOCA_FDEP", unit: "m", data_type: { _tag: "DP", n: 2 } },
        ],
        rows: [{ LOCA_ID: "GPS01", LOCA_LAT: 51.5, LOCA_LON: -0.1, LOCA_FDEP: 5.0 }],
        source_line: Option.none(),
      },
    });
    const db = openDb(dbPath);
    try {
      const report = db.ingest(fileWithLatLon, "/test/latlon.ags");
      expect(report.locaCount).toBe(1);
      const results = db.queryLocaByBbox(-1, 51, 0, 52);
      expect(results.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });
});
