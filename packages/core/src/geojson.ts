/**
 * geojson.ts — Export LOCA locations as GeoJSON FeatureCollection.
 *
 * Each LOCA row becomes a Point Feature. Coordinates are taken from
 * (LOCA_LON, LOCA_LAT) when present; otherwise from (LOCA_NATE, LOCA_NATN)
 * with an optional `--epsg` reprojection performed by the caller. AGS does
 * not encode a CRS for the eastings/northings, so by default they are
 * passed through unchanged and the consumer can supply CRS metadata via
 * the `crs` option.
 *
 * Properties carry every non-null LOCA heading verbatim, plus a small set
 * of derived fields (`depth_max`, `geol_top_count`, etc.) for quick
 * filtering in GIS tools.
 */

import type { AgsFile, AgsValue } from "./model.js";

export interface GeoJsonExportOptions {
  /** CRS name (e.g. "EPSG:27700") — included as a top-level `crs` member. */
  crs?: string;
  /**
   * Force which AGS headings provide longitude/latitude. By default the
   * exporter looks for LOCA_LON/LOCA_LAT (decimal degrees) and falls back to
   * LOCA_NATE/LOCA_NATN.
   */
  lonHeading?: string;
  latHeading?: string;
  /** If true, also include LOCA rows with no coordinates (as a Feature with `geometry: null`). */
  includeUnlocated?: boolean;
}

export interface GeoJsonFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] } | null;
  properties: Record<string, string | number | null>;
}

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
  /** Non-standard but widely-used member for GIS tooling. */
  crs?: { type: "name"; properties: { name: string } };
}

/**
 * Convert the LOCA group of an AgsFile into a GeoJSON FeatureCollection.
 *
 * Returns an empty FeatureCollection if no LOCA group exists.
 */
export function locationsToGeoJson(
  file: AgsFile,
  options: GeoJsonExportOptions = {},
): GeoJsonFeatureCollection {
  const loca = file.groups.LOCA;
  const features: GeoJsonFeature[] = [];

  if (loca) {
    const lonHeading = options.lonHeading ?? "LOCA_LON";
    const latHeading = options.latHeading ?? "LOCA_LAT";
    const includeUnlocated = options.includeUnlocated === true;

    const geolByLoca = new Map<string, { count: number; maxBase: number | null }>();
    for (const r of file.groups.GEOL?.rows ?? []) {
      const id = stringValue(r["LOCA_ID"]);
      if (!id) continue;
      const base = numericValue(r["GEOL_BASE"]);
      const entry = geolByLoca.get(id) ?? { count: 0, maxBase: null };
      entry.count += 1;
      if (base !== null && (entry.maxBase === null || base > entry.maxBase)) {
        entry.maxBase = base;
      }
      geolByLoca.set(id, entry);
    }

    for (const row of loca.rows) {
      const props: Record<string, string | number | null> = {};
      for (const heading of loca.headings) {
        const v = row[heading.name];
        if (v === null || v === undefined || v === "") continue;
        props[heading.name] = typeof v === "number" ? v : String(v);
      }

      const id = stringValue(row["LOCA_ID"]);
      if (id) {
        const summary = geolByLoca.get(id);
        if (summary) {
          props["geol_layer_count"] = summary.count;
          if (summary.maxBase !== null) props["depth_max_m"] = summary.maxBase;
        }
      }

      const lon = numericValue(row[lonHeading]);
      const lat = numericValue(row[latHeading]);
      const nate = numericValue(row["LOCA_NATE"]);
      const natn = numericValue(row["LOCA_NATN"]);

      let geometry: GeoJsonFeature["geometry"] = null;
      if (lon !== null && lat !== null) {
        geometry = { type: "Point", coordinates: [lon, lat] };
      } else if (nate !== null && natn !== null) {
        geometry = { type: "Point", coordinates: [nate, natn] };
      }

      if (geometry === null && !includeUnlocated) continue;
      features.push({ type: "Feature", geometry, properties: props });
    }
  }

  const collection: GeoJsonFeatureCollection = {
    type: "FeatureCollection",
    features,
  };
  if (options.crs) {
    collection.crs = { type: "name", properties: { name: options.crs } };
  }
  return collection;
}

function stringValue(v: AgsValue | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function numericValue(v: AgsValue | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}
