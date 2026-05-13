/**
 * @geoflow/db — SQLite/GeoPackage ingest + query (node-only).
 *
 * One SQLite table per AGS group, created dynamically from the group's headings.
 * LOCA gets a `geom BLOB` (WKB point) column; every other group is an attribute table.
 */

import { createRequire } from "node:module";
import type { AgsFile, AgsRow, AgsValue } from "@geoflow/core";

export const PACKAGE_NAME = "@geoflow/db";

const _require = createRequire(import.meta.url);

// better-sqlite3 is an optional dependency — load it lazily so the module can
// still be imported without it (the functions will throw if called).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function requireSqlite(): any {
  return _require("better-sqlite3");
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ImportReport {
  sourceFile: string;
  locaCount: number;
  groupsImported: string[];
}

export interface LocaRecord {
  loca_id: string;
  lon: number;
  lat: number;
  attrs: Record<string, string | null>;
}

export interface QueryResult {
  group: string;
  columns: string[];
  rows: Array<Array<string | null>>;
}

// ── GeoPackage bootstrap ──────────────────────────────────────────────────────

const BOOTSTRAP_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS gpkg_spatial_ref_sys (
  srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY,
  organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL,
  definition TEXT NOT NULL, description TEXT
);
INSERT OR IGNORE INTO gpkg_spatial_ref_sys VALUES
  ('WGS 84',4326,'EPSG',4326,'GEOGCS["WGS 84"...]','WGS 84');

CREATE TABLE IF NOT EXISTS gpkg_contents (
  table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL,
  identifier TEXT, description TEXT, last_change DATETIME,
  min_x REAL, min_y REAL, max_x REAL, max_y REAL, srs_id INTEGER
);

CREATE TABLE IF NOT EXISTS gpkg_geometry_columns (
  table_name TEXT NOT NULL, column_name TEXT NOT NULL,
  geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL,
  z TINYINT NOT NULL, m TINYINT NOT NULL
);

CREATE TABLE IF NOT EXISTS geoflow_headings (
  table_name TEXT NOT NULL, heading_name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '', data_type TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (table_name, heading_name)
);

CREATE TABLE IF NOT EXISTS geoflow_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  loca_count INTEGER NOT NULL DEFAULT 0,
  proj_name TEXT
);
`;

// ── WKB point encoding (ISO WKB, little-endian) ───────────────────────────────

function encodePoint(lon: number, lat: number): Buffer {
  const buf = Buffer.alloc(21);
  buf.writeUInt8(1, 0);        // byte order: little-endian
  buf.writeUInt32LE(1, 1);     // geometry type: Point
  buf.writeDoubleLE(lon, 5);
  buf.writeDoubleLE(lat, 13);
  return buf;
}

// ── BNG → WGS 84 (approximate Helmert transform, error < 5 m) ────────────────

function bngToWgs84(easting: number, northing: number): [number, number] {
  const a = 6377563.396, b = 6356256.909;
  const F0 = 0.9996012717;
  const lat0 = (49 * Math.PI) / 180, lon0 = (-2 * Math.PI) / 180;
  const N0 = -100000, E0 = 400000;
  const e2 = 1 - (b * b) / (a * a);
  const nn = (a - b) / (a + b);

  let lat = lat0, M = 0, latPrev = 0;
  do {
    latPrev = lat;
    M = b * F0 * (
      (1 + nn + 1.25 * nn ** 2 + 1.25 * nn ** 3) * (lat - lat0)
      - (3 * nn + 3 * nn ** 2 + 2.625 * nn ** 3) * Math.sin(lat - lat0) * Math.cos(lat + lat0)
      + (1.875 * nn ** 2 + 1.875 * nn ** 3) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0))
      - (35 / 24) * nn ** 3 * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0))
    );
    lat = (northing - N0 - M) / (a * F0) + latPrev;
  } while (Math.abs(northing - N0 - M) >= 1e-5);

  const sinLat = Math.sin(lat), cosLat = Math.cos(lat), tanLat = Math.tan(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sinLat ** 2);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sinLat ** 2, 1.5);
  const eta2 = nu / rho - 1;
  const dE = easting - E0;
  const VII = tanLat / (2 * rho * nu);
  const VIII = (tanLat / (24 * rho * nu ** 3)) * (5 + 3 * tanLat ** 2 + eta2 - 9 * tanLat ** 2 * eta2);
  const IX = (tanLat / (720 * rho * nu ** 5)) * (61 + 90 * tanLat ** 2 + 45 * tanLat ** 4);
  const X = 1 / (cosLat * nu);
  const XI = (1 / (cosLat * 6 * nu ** 3)) * (nu / rho + 2 * tanLat ** 2);
  const XII = (1 / (cosLat * 120 * nu ** 5)) * (5 + 28 * tanLat ** 2 + 24 * tanLat ** 4);
  const XIIA = (1 / (cosLat * 5040 * nu ** 7)) * (61 + 662 * tanLat ** 2 + 1320 * tanLat ** 4 + 720 * tanLat ** 6);

  const latRad = lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6;
  const lonRad = lon0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7;

  return [(lonRad * 180) / Math.PI, (latRad * 180) / Math.PI];
}

// ── Geometry extraction from LOCA row ─────────────────────────────────────────

function extractPoint(row: AgsRow): [number, number] | null {
  const lon = row["LOCA_LON"];
  const lat = row["LOCA_LAT"];
  if (lon != null && lat != null) {
    const lo = parseFloat(String(lon));
    const la = parseFloat(String(lat));
    if (!isNaN(lo) && !isNaN(la)) return [lo, la];
  }
  const nate = row["LOCA_NATE"];
  const natn = row["LOCA_NATN"];
  if (nate != null && natn != null) {
    const e = parseFloat(String(nate));
    const n = parseFloat(String(natn));
    if (!isNaN(e) && !isNaN(n) && e > 0 && n > 0) return bngToWgs84(e, n);
  }
  return null;
}

// ── SQL helpers ───────────────────────────────────────────────────────────────

function col(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function toSql(v: AgsValue): string | number | null {
  if (v === null) return null;
  if (typeof v === "number") return v;
  return String(v);
}

// ── Public API ────────────────────────────────────────────────────────────────

export class GeoflowDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  constructor(path: string) {
    const Sqlite = requireSqlite();
    this.db = new Sqlite(path);
    this.db.exec(BOOTSTRAP_SQL);
  }

  close(): void {
    this.db.close();
  }

  /** Import all groups from an AgsFile into the database. */
  ingest(file: AgsFile, sourceFile = "<unknown>"): ImportReport {
    const report: ImportReport = { sourceFile, locaCount: 0, groupsImported: [] };

    const tx = this.db.transaction(() => {
      for (const [groupName, group] of Object.entries(file.groups)) {
        const table = groupName.toLowerCase();
        const isLoca = groupName === "LOCA";
        const headingNames = (group as AgsFile["groups"][string]).headings.map((h) => h.name);

        const colDefs = [
          "fid INTEGER PRIMARY KEY AUTOINCREMENT",
          "source_file TEXT NOT NULL DEFAULT ''",
          "imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
          ...headingNames.map((n) => `${col(n)} TEXT`),
          ...(isLoca ? ["geom BLOB"] : []),
        ];
        this.db.exec(`CREATE TABLE IF NOT EXISTS ${col(table)} (${colDefs.join(", ")});`);

        if (isLoca) {
          this.db.prepare(
            `INSERT OR IGNORE INTO gpkg_contents (table_name, data_type, identifier, srs_id) VALUES (?, 'features', ?, 4326)`
          ).run(table, table);
          this.db.prepare(
            `INSERT OR IGNORE INTO gpkg_geometry_columns (table_name, column_name, geometry_type_name, srs_id, z, m) VALUES (?, 'geom', 'POINT', 4326, 0, 0)`
          ).run(table);
        } else {
          this.db.prepare(
            `INSERT OR IGNORE INTO gpkg_contents (table_name, data_type, identifier) VALUES (?, 'attributes', ?)`
          ).run(table, table);
        }

        const insertHeading = this.db.prepare(
          `INSERT OR REPLACE INTO geoflow_headings (table_name, heading_name, unit, data_type) VALUES (?, ?, ?, ?)`
        );
        for (const h of (group as AgsFile["groups"][string]).headings) {
          insertHeading.run(table, h.name, h.unit, String(h.data_type));
        }

        const colList = headingNames.map(col).join(", ");
        const placeholders = headingNames.map(() => "?").join(", ");
        const geomExtra = isLoca ? ", geom" : "";
        const geomPh = isLoca ? ", ?" : "";
        const insertRow = this.db.prepare(
          `INSERT INTO ${col(table)} (source_file, ${colList}${geomExtra}) VALUES (?, ${placeholders}${geomPh})`
        );

        for (const row of (group as AgsFile["groups"][string]).rows) {
          const vals: Array<string | number | null | Buffer> = [
            sourceFile,
            ...headingNames.map((n) => toSql(row[n] ?? null)),
          ];
          if (isLoca) {
            const pt = extractPoint(row);
            vals.push(pt !== null ? encodePoint(pt[0], pt[1]) : null);
            report.locaCount++;
          }
          insertRow.run(...vals);
        }

        report.groupsImported.push(groupName);
      }

      const projName =
        (file.groups["PROJ"]?.rows[0]?.["PROJ_NAME"] ?? null) as string | null;
      this.db.prepare(
        `INSERT INTO geoflow_imports (source_file, loca_count, proj_name) VALUES (?, ?, ?)`
      ).run(sourceFile, report.locaCount, projName);
    });

    tx();
    return report;
  }

  /** Query LOCA records whose WGS 84 point falls within a bounding box. */
  queryLocaByBbox(minLon: number, minLat: number, maxLon: number, maxLat: number): LocaRecord[] {
    const rows = this.db.prepare(`SELECT * FROM loca`).all() as Array<Record<string, unknown>>;
    return rows
      .map((row) => {
        const geom = row["geom"] as Buffer | null;
        if (!geom || geom.length < 21) return null;
        const lon = geom.readDoubleLE(5);
        const lat = geom.readDoubleLE(13);
        if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return null;
        const attrs: Record<string, string | null> = {};
        for (const [k, v] of Object.entries(row)) {
          if (k === "geom" || k === "fid" || k === "imported_at") continue;
          attrs[k] = v === null || v === undefined ? null : String(v);
        }
        return { loca_id: String(row["loca_id"] ?? ""), lon, lat, attrs };
      })
      .filter((r): r is LocaRecord => r !== null);
  }

  /** Query all rows from an AGS group table. */
  queryGroup(groupName: string): QueryResult {
    const table = groupName.toLowerCase();
    const rows = this.db.prepare(`SELECT * FROM ${col(table)}`).all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return { group: groupName, columns: [], rows: [] };
    const columns = Object.keys(rows[0]!).filter(
      (k) => k !== "fid" && k !== "geom" && k !== "imported_at" && k !== "source_file"
    );
    const data = rows.map((row) =>
      columns.map((c) => {
        const v = row[c];
        return v === null || v === undefined ? null : String(v);
      })
    );
    return { group: groupName, columns, rows: data };
  }

  /** List all recorded imports. */
  listImports(): Array<{ id: number; sourceFile: string; importedAt: string; locaCount: number; projName: string | null }> {
    const rows = this.db.prepare(`SELECT * FROM geoflow_imports ORDER BY id`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r["id"] as number,
      sourceFile: String(r["source_file"] ?? ""),
      importedAt: String(r["imported_at"] ?? ""),
      locaCount: r["loca_count"] as number,
      projName: r["proj_name"] as string | null,
    }));
  }
}

/** Open (or create) a GeoPackage database at the given path. */
export function openDb(path: string): GeoflowDb {
  return new GeoflowDb(path);
}
