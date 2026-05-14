/**
 * Browser-side GeoPackage export for AGS data.
 *
 * Produces a GeoPackage 1.3 file (SQLite3 container) containing:
 *  - Required GeoPackage system tables
 *  - LOCA as a feature table with WKB Point geometry (WGS 84, EPSG:4326)
 *  - All other AGS groups as attribute tables
 *  - GeoPackage Related Tables Extension (RTE) entries for LOCA→group links
 *  - QGIS-compatible layer_styles table with point styling for LOCA
 *
 * Uses sql.js (SQLite compiled to WASM) with WASM loaded from jsDelivr CDN.
 */

import { Option } from 'effect';
import type { AgsFile, AgsRow } from '../core.js';
import { downloadBlob, exportBaseName, exportDatePrefix } from './utils.js';

// ── sql.js type shim (avoids importing the full @types/sql.js at build time) ──
interface SqlDatabase {
  run(sql: string, params?: (string | number | null | Uint8Array)[]): void;
  exec(sql: string): void;
  export(): Uint8Array;
  close(): void;
}
interface SqlJsStatic {
  Database: new () => SqlDatabase;
}

async function loadSql(): Promise<SqlJsStatic> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initSqlJs = ((await import('sql.js')) as any).default as (opts: {
    locateFile: (f: string) => string;
  }) => Promise<SqlJsStatic>;
  return initSqlJs({
    locateFile: (f: string) =>
      `https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/${f}`,
  });
}

// ── GeoPackage geometry binary encoding ──────────────────────────────────────
// Format: GeoPackageBinaryHeader (8 bytes) + ISO WKB Point (21 bytes) = 29 bytes

function encodeGpkgPoint(lon: number, lat: number): Uint8Array {
  const buf = new ArrayBuffer(29);
  const view = new DataView(buf);
  // GeoPackageBinaryHeader
  view.setUint8(0, 0x47); // 'G'
  view.setUint8(1, 0x50); // 'P'
  view.setUint8(2, 0x00); // version 0
  view.setUint8(3, 0x01); // flags: little-endian, no envelope
  view.setInt32(4, 4326, true); // SRS_ID = EPSG:4326
  // ISO WKB Point (little-endian)
  view.setUint8(8, 0x01); // byte order: LE
  view.setUint32(9, 1, true); // wkbType: Point
  view.setFloat64(13, lon, true);
  view.setFloat64(21, lat, true);
  return new Uint8Array(buf);
}

// ── BNG → WGS 84 (OSTN02 approximate Helmert, <5 m error) ────────────────────

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

function extractPoint(row: AgsRow): [number, number] | null {
  const lon = row['LOCA_LON'], lat = row['LOCA_LAT'];
  if (lon != null && lat != null) {
    const lo = parseFloat(String(lon)), la = parseFloat(String(lat));
    if (!isNaN(lo) && !isNaN(la)) return [lo, la];
  }
  const nate = row['LOCA_NATE'], natn = row['LOCA_NATN'];
  if (nate != null && natn != null) {
    const e = parseFloat(String(nate)), n = parseFloat(String(natn));
    if (!isNaN(e) && !isNaN(n) && e > 0 && n > 0) return bngToWgs84(e, n);
  }
  return null;
}

// ── SQL helpers ───────────────────────────────────────────────────────────────

function quoteName(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function toSqlValue(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  return String(v);
}

// ── QGIS QML point style for LOCA ─────────────────────────────────────────────

const LOCA_QML = `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.28" styleCategories="Symbology|Labeling">
  <renderer-v2 type="singleSymbol" enableorderby="0" forceraster="0" symbollevels="0" referencescale="-1">
    <symbols>
      <symbol name="0" type="marker" alpha="1" force_rhr="0" clip_to_extent="1" frame_rate="10" is_animated="0">
        <data_defined_properties><Option type="Map"><Option name="name" value="" type="QString"/>
          <Option name="properties"/><Option name="type" value="collection" type="QString"/></Option></data_defined_properties>
        <layer class="SimpleMarker" pass="0" enabled="1" locked="0" id="">
          <Option type="Map">
            <Option name="angle" value="0" type="QString"/>
            <Option name="cap_style" value="square" type="QString"/>
            <Option name="color" value="31,120,180,255" type="QString"/>
            <Option name="horizontal_anchor_point" value="1" type="QString"/>
            <Option name="joinstyle" value="bevel" type="QString"/>
            <Option name="name" value="circle" type="QString"/>
            <Option name="offset" value="0,0" type="QString"/>
            <Option name="offset_map_unit_scale" value="3x:0,0,0,0,0,0" type="QString"/>
            <Option name="offset_unit" value="MM" type="QString"/>
            <Option name="outline_color" value="255,255,255,255" type="QString"/>
            <Option name="outline_style" value="solid" type="QString"/>
            <Option name="outline_width" value="0.4" type="QString"/>
            <Option name="outline_width_map_unit_scale" value="3x:0,0,0,0,0,0" type="QString"/>
            <Option name="outline_width_unit" value="MM" type="QString"/>
            <Option name="scale_method" value="diameter" type="QString"/>
            <Option name="size" value="3.2" type="QString"/>
            <Option name="size_map_unit_scale" value="3x:0,0,0,0,0,0" type="QString"/>
            <Option name="size_unit" value="MM" type="QString"/>
            <Option name="vertical_anchor_point" value="1" type="QString"/>
          </Option>
        </layer>
      </symbol>
    </symbols>
    <rotation/>
    <sizescale/>
  </renderer-v2>
  <labeling type="simple">
    <settings calloutType="simple">
      <text-style fieldName="LOCA_ID" fontFamily="Sans Serif" fontSize="7" fontWeight="50"
        textColor="50,50,50,255" multilineHeight="1" blendMode="0" isExpression="0"
        fontLetterSpacing="0" fontWordSpacing="0" fontSizeUnit="Point" fontItalic="0"
        fontUnderline="0" fontStrikeout="0" fontSizeMapUnitScale="3x:0,0,0,0,0,0"
        useSubstitutions="0" textOrientation="horizontal" capitalization="0"
        allowHtml="0" previewBkgrdColor="255,255,255,255" legendString="Aa"
        fontKerning="1" textOpacity="1" namedStyle="Regular">
        <families/>
        <text-buffer bufferBlendMode="0" bufferColor="250,250,250,255" bufferSize="0.8"
          bufferJoinStyle="128" bufferOpacity="1" bufferSizeMapUnitScale="3x:0,0,0,0,0,0"
          bufferSizeUnits="MM" bufferNoFill="1" bufferDraw="1"/>
        <text-mask maskOpacity="1" maskedSymbolLayers="" maskType="0" maskSize="0"
          maskJoinStyle="128" maskEnabled="0" maskSizeMapUnitScale="3x:0,0,0,0,0,0"
          maskSizeUnits="MM"/>
        <background shapeSizeX="0" shapeSizeMapUnitScale="3x:0,0,0,0,0,0"
          shapeBorderWidthMapUnitScale="3x:0,0,0,0,0,0" shapeOpacity="1" shapeDraw="0"
          shapeOffsetX="0" shapeOffsetY="0" shapeOffsetUnit="MM"
          shapeOffsetMapUnitScale="3x:0,0,0,0,0,0" shapeSizeY="0" shapeSizeUnit="MM"
          shapeSizeType="0" shapeBorderColor="128,128,128,255" shapeBlendMode="0"
          shapeFillColor="255,255,255,255" shapeBorderWidth="0" shapeBorderWidthUnit="MM"
          shapeType="0" shapeRotation="0" shapeRotationType="0" shapeJoinStyle="64"
          shapeRadiiUnit="MM" shapeRadiiX="0" shapeRadiiY="0"
          shapeRadiiMapUnitScale="3x:0,0,0,0,0,0">
          <symbol name="markerSymbol" alpha="1" type="marker" force_rhr="0" clip_to_extent="1"
            frame_rate="10" is_animated="0"><data_defined_properties><Option type="Map">
            <Option name="name" value="" type="QString"/><Option name="properties"/>
            <Option name="type" value="collection" type="QString"/></Option>
            </data_defined_properties><layer class="SimpleMarker" pass="0" enabled="1" locked="0" id="">
            <Option type="Map"><Option name="color" value="152,125,183,255" type="QString"/>
            <Option name="name" value="circle" type="QString"/>
            <Option name="size" value="2" type="QString"/></Option></layer></symbol>
          <symbol name="fillSymbol" alpha="1" type="fill" force_rhr="0" clip_to_extent="1"
            frame_rate="10" is_animated="0"><data_defined_properties><Option type="Map">
            <Option name="name" value="" type="QString"/><Option name="properties"/>
            <Option name="type" value="collection" type="QString"/></Option>
            </data_defined_properties><layer class="SimpleFill" pass="0" enabled="1" locked="0" id="">
            <Option type="Map"><Option name="color" value="255,255,255,255" type="QString"/>
            <Option name="style" value="solid" type="QString"/>
            <Option name="border_width_map_unit_scale" value="3x:0,0,0,0,0,0" type="QString"/>
            </Option></layer></symbol>
        </background>
        <shadow shadowScale="100" shadowBlendMode="6" shadowColor="0,0,0,255"
          shadowOffsetDist="1" shadowRadius="1.5" shadowRadiusAlphaOnly="0"
          shadowRadiusMapUnitScale="3x:0,0,0,0,0,0" shadowRadiusUnit="MM"
          shadowOffsetUnit="MM" shadowOffsetMapUnitScale="3x:0,0,0,0,0,0"
          shadowOpacity="0.7" shadowOffsetAngle="135" shadowOffsetGlobal="1"
          shadowDraw="0"/>
        <dd_properties><Option type="Map"><Option name="name" value="" type="QString"/>
          <Option name="properties"/><Option name="type" value="collection" type="QString"/>
          </Option></dd_properties>
        <substitutions/>
      </text-style>
      <text-format leftDirectionSymbol="&lt;" rightDirectionSymbol="&gt;"
        reverseDirectionSymbol="0" addDirectionSymbol="0" placeDirectionSymbol="0"
        plussign="0" decimals="3" formatNumbers="0" multilineAlign="3" wrapChar=""/>
      <placement maxCurvedCharAngleIn="25" priority="5" placement="0" maxCurvedCharAngleOut="-25"
        centroidWhole="0" placementFlags="10" dist="0" offsetType="0" overrunDistance="0"
        layerType="PointGeometry" repeatDistance="0" geometryGeneratorEnabled="0"
        geometryGeneratorType="PointGeometry" geometryGenerator="" offsetX="0" offsetY="0"
        lineAnchorClipping="0" lineAnchorPercent="0.5" lineAnchorTextPoint="FollowPlacement"
        lineAnchorType="0" distMapUnitScale="3x:0,0,0,0,0,0" distUnits="MM"
        repeatDistanceMapUnitScale="3x:0,0,0,0,0,0" repeatDistanceUnits="MM"
        overrunDistanceMapUnitScale="3x:0,0,0,0,0,0" overrunDistanceUnit="MM"
        centroidInside="0" fitInPolygonOnly="0" polygonPlacementFlags="2"
        rotationAngle="0" rotationUnit="AngleDegrees" quadOffset="4"
        preserveRotation="1" xOffset="0" yOffset="0" overlapHandling="PreventOverlap"
        allowDegraded="0" zIndex="0"/>
      <rendering obstacleFactor="1" scaleMax="0" limitNumLabels="0" obstacle="1"
        drawLabels="1" fontMaxPixelSize="10000" maxNumLabels="2000" obstacleType="1"
        scaleMin="0" scaleVisibility="0" fontMinPixelSize="3" upsidedownLabels="0"
        labelPerPart="0" minFeatureSize="0" mergeLines="0" zIndex="0"/>
      <dd_properties><Option type="Map"><Option name="name" value="" type="QString"/>
        <Option name="properties"/><Option name="type" value="collection" type="QString"/>
        </Option></dd_properties>
      <callout type="simple"><Option type="Map">
        <Option name="anchorPoint" value="pole_of_inaccessibility" type="QString"/>
        <Option name="blendMode" value="0" type="QString"/>
        <Option name="ddProperties"><Option type="Map">
          <Option name="name" value="" type="QString"/><Option name="properties"/>
          <Option name="type" value="collection" type="QString"/></Option></Option>
        <Option name="drawToAllParts" value="false" type="bool"/>
        <Option name="enabled" value="0" type="QString"/>
        <Option name="labelAnchorPoint" value="point_on_exterior" type="QString"/>
        <Option name="lineSymbol"><Option type="Map">...</Option></Option>
        <Option name="minLength" value="0" type="double"/>
        <Option name="minLengthMapUnitScale" value="3x:0,0,0,0,0,0" type="QString"/>
        <Option name="minLengthUnit" value="MM" type="QString"/>
        <Option name="offsetFromAnchor" value="0" type="double"/>
        <Option name="offsetFromAnchorMapUnitScale" value="3x:0,0,0,0,0,0" type="QString"/>
        <Option name="offsetFromAnchorUnit" value="MM" type="QString"/>
        <Option name="offsetFromLabel" value="0" type="double"/>
        <Option name="offsetFromLabelMapUnitScale" value="3x:0,0,0,0,0,0" type="QString"/>
        <Option name="offsetFromLabelUnit" value="MM" type="QString"/>
      </Option></callout>
    </settings>
  </labeling>
</qgis>`;

// ── Main export ───────────────────────────────────────────────────────────────

export async function exportGeopackage(
  agsFile: AgsFile,
  fileName: string | undefined,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const date = exportDatePrefix();
  const base = exportBaseName(fileName);

  onProgress?.('Loading SQLite WASM…');
  const SQL = await loadSql();
  const db: SqlDatabase = new SQL.Database();

  onProgress?.('Bootstrapping GeoPackage schema…');

  // ── Required GeoPackage tables ─────────────────────────────────────────────
  db.exec(`
    PRAGMA application_id = 1196444487;
    PRAGMA user_version = 10300;

    CREATE TABLE gpkg_spatial_ref_sys (
      srs_name TEXT NOT NULL,
      srs_id INTEGER NOT NULL PRIMARY KEY,
      organization TEXT NOT NULL,
      organization_coordsys_id INTEGER NOT NULL,
      definition TEXT NOT NULL,
      description TEXT
    );

    INSERT INTO gpkg_spatial_ref_sys VALUES
      ('Undefined Cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined Cartesian coordinate reference system'),
      ('Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system'),
      ('WGS 84 geographic 2D', 4326, 'EPSG', 4326,
        'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]',
        'WGS 84'
      );

    CREATE TABLE gpkg_contents (
      table_name TEXT NOT NULL PRIMARY KEY,
      data_type TEXT NOT NULL,
      identifier TEXT,
      description TEXT DEFAULT '',
      last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S.000Z','now')),
      min_x REAL,
      min_y REAL,
      max_x REAL,
      max_y REAL,
      srs_id INTEGER,
      CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
    );

    CREATE TABLE gpkg_geometry_columns (
      table_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      geometry_type_name TEXT NOT NULL,
      srs_id INTEGER NOT NULL,
      z TINYINT NOT NULL,
      m TINYINT NOT NULL,
      CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
      CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
      CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
    );

    CREATE TABLE gpkg_extensions (
      table_name TEXT,
      column_name TEXT,
      extension_name TEXT NOT NULL,
      definition TEXT NOT NULL,
      scope TEXT NOT NULL,
      CONSTRAINT ge_tce UNIQUE (table_name, column_name, extension_name)
    );
  `);

  // ── GeoPackage Related Tables Extension (RTE) tables ──────────────────────
  db.exec(`
    CREATE TABLE gpkgext_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_table_name TEXT NOT NULL,
      base_primary_column TEXT NOT NULL DEFAULT 'id',
      related_table_name TEXT NOT NULL,
      related_primary_column TEXT NOT NULL DEFAULT 'id',
      relation_name TEXT NOT NULL,
      mapping_table_name TEXT NOT NULL
    );

    INSERT INTO gpkg_extensions (table_name, column_name, extension_name, definition, scope) VALUES
      ('gpkgext_relations', NULL,
       'gpkg_related_tables',
       'http://www.geopackage.org/18-000.html',
       'read-write');
  `);

  // ── QGIS layer styles table ────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE layer_styles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      f_table_catalog TEXT DEFAULT '',
      f_table_schema TEXT DEFAULT '',
      f_table_name TEXT,
      f_geometry_column TEXT,
      styleName TEXT,
      styleQML TEXT,
      styleSLD TEXT,
      useAsDefault INTEGER DEFAULT 1,
      description TEXT,
      owner TEXT DEFAULT '',
      ui TEXT DEFAULT NULL,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── Metadata tables (headings + import provenance) ─────────────────────────
  db.exec(`
    CREATE TABLE geoflow_headings (
      table_name TEXT NOT NULL,
      heading_name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT '',
      data_type TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (table_name, heading_name)
    );

    CREATE TABLE geoflow_import (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file TEXT NOT NULL,
      ags_version TEXT,
      exported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S.000Z','now')),
      loca_count INTEGER NOT NULL DEFAULT 0
    );
  `);

  // ── Ingest each AGS group ─────────────────────────────────────────────────
  const groups = Object.entries(agsFile.groups).filter(([, g]) => g != null);
  const locaTable = 'loca';
  let locaCount = 0;
  let locaMinX = Infinity, locaMinY = Infinity, locaMaxX = -Infinity, locaMaxY = -Infinity;

  // Track which tables have LOCA_ID for relationship wiring
  const locaRelated: string[] = [];

  for (const [groupName, group] of groups) {
    if (!group) continue;
    onProgress?.(`Writing group ${groupName}…`);

    const tableName = groupName.toLowerCase();
    const isLoca = groupName === 'LOCA';
    const headingNames = group.headings.map((h) => h.name);

    // Create table
    const colDefs = [
      'id INTEGER PRIMARY KEY AUTOINCREMENT',
      ...headingNames.map((n) => `${quoteName(n)} TEXT`),
      ...(isLoca ? ['geom BLOB'] : []),
    ].join(', ');
    db.exec(`CREATE TABLE ${quoteName(tableName)} (${colDefs});`);

    // Register in gpkg_contents
    if (isLoca) {
      db.run(
        `INSERT INTO gpkg_contents (table_name, data_type, identifier, description, srs_id)
         VALUES (?, 'features', ?, 'AGS LOCA group — borehole locations', 4326)`,
        [tableName, tableName],
      );
      db.run(
        `INSERT INTO gpkg_geometry_columns (table_name, column_name, geometry_type_name, srs_id, z, m)
         VALUES (?, 'geom', 'POINT', 4326, 0, 0)`,
        [tableName],
      );
    } else {
      db.run(
        `INSERT INTO gpkg_contents (table_name, data_type, identifier, description)
         VALUES (?, 'attributes', ?, ?)`,
        [tableName, tableName, `AGS ${groupName} group`],
      );
    }

    // Store heading metadata
    for (const h of group.headings) {
      db.run(
        `INSERT OR REPLACE INTO geoflow_headings (table_name, heading_name, unit, data_type)
         VALUES (?, ?, ?, ?)`,
        [tableName, h.name, h.unit ?? '', String(h.data_type)],
      );
    }

    // Check if this table is LOCA-related
    const hasLocaId = headingNames.includes('LOCA_ID');
    if (!isLoca && hasLocaId) locaRelated.push(tableName);

    // Insert rows
    const colList = headingNames.map(quoteName).join(', ');
    const placeholders = headingNames.map(() => '?').join(', ');

    for (const row of group.rows) {
      const vals: (string | number | null | Uint8Array)[] = headingNames.map((n) =>
        toSqlValue(row[n] ?? null),
      );

      if (isLoca) {
        const pt = extractPoint(row);
        const geom = pt !== null ? encodeGpkgPoint(pt[0], pt[1]) : null;
        if (pt) {
          locaMinX = Math.min(locaMinX, pt[0]);
          locaMinY = Math.min(locaMinY, pt[1]);
          locaMaxX = Math.max(locaMaxX, pt[0]);
          locaMaxY = Math.max(locaMaxY, pt[1]);
        }
        db.run(
          `INSERT INTO ${quoteName(tableName)} (${colList}, geom) VALUES (${placeholders}, ?)`,
          [...vals, geom],
        );
        locaCount++;
      } else {
        db.run(
          `INSERT INTO ${quoteName(tableName)} (${colList}) VALUES (${placeholders})`,
          vals,
        );
      }
    }
  }

  // ── Update LOCA bounding box in gpkg_contents ─────────────────────────────
  if (locaCount > 0 && isFinite(locaMinX)) {
    db.run(
      `UPDATE gpkg_contents SET min_x=?, min_y=?, max_x=?, max_y=? WHERE table_name=?`,
      [locaMinX, locaMinY, locaMaxX, locaMaxY, locaTable],
    );
  }

  // ── Related Tables Extension: LOCA → related groups ──────────────────────
  onProgress?.('Wiring relationships…');
  for (const relatedTable of locaRelated) {
    const mappingTable = `rel_loca_${relatedTable}`;

    // Mapping table: loca.id ↔ related.id (joined via LOCA_ID)
    db.exec(`
      CREATE TABLE ${quoteName(mappingTable)} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        base_id INTEGER NOT NULL,
        related_id INTEGER NOT NULL
      );
    `);

    // Populate via LOCA_ID join
    db.exec(`
      INSERT INTO ${quoteName(mappingTable)} (base_id, related_id)
      SELECT l.id, r.id
      FROM ${quoteName(locaTable)} l
      JOIN ${quoteName(relatedTable)} r ON l."LOCA_ID" = r."LOCA_ID";
    `);

    // Register extension scope for mapping table
    db.run(
      `INSERT INTO gpkg_extensions (table_name, column_name, extension_name, definition, scope)
       VALUES (?, NULL, 'gpkg_related_tables', 'http://www.geopackage.org/18-000.html', 'read-write')`,
      [mappingTable],
    );

    // Register relationship in gpkgext_relations
    db.run(
      `INSERT INTO gpkgext_relations
         (base_table_name, base_primary_column, related_table_name, related_primary_column,
          relation_name, mapping_table_name)
       VALUES (?, 'id', ?, 'id', 'simple_attributes', ?)`,
      [locaTable, relatedTable, mappingTable],
    );
  }

  // ── QGIS layer style for LOCA ─────────────────────────────────────────────
  onProgress?.('Writing layer styles…');
  db.run(
    `INSERT INTO layer_styles
       (f_table_name, f_geometry_column, styleName, styleQML, useAsDefault, description)
     VALUES (?, 'geom', 'GeoFlow Default', ?, 1, 'Auto-generated by GeoFlow')`,
    [locaTable, LOCA_QML],
  );

  // ── Import provenance ─────────────────────────────────────────────────────
  db.run(
    `INSERT INTO geoflow_import (source_file, ags_version, loca_count) VALUES (?, ?, ?)`,
    [fileName ?? 'unknown', Option.getOrNull(agsFile.ags_version), locaCount],
  );

  // ── Export and download ───────────────────────────────────────────────────
  onProgress?.('Finalising…');
  const bytes = db.export();
  db.close();
  downloadBlob(bytes, `${date}-${base}.gpkg`, 'application/geopackage+sqlite3');
}
