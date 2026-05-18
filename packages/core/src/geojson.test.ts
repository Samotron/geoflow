import { describe, expect, it } from "vitest";
import { locationsToGeoJson } from "./geojson.js";
import { parseStr } from "./ags/parser.js";

const SAMPLE = `"GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"

"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_TYPE","LOCA_NATE","LOCA_NATN","LOCA_GL"
"UNIT","","","m","m","m"
"TYPE","ID","X","2DP","2DP","2DP"
"DATA","BH01","CP","523456.00","181234.50","45.50"
"DATA","BH02","CP","523500.00","181300.00","46.10"
"DATA","BH03","CP","","","47.00"

"GROUP","GEOL"
"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC"
"UNIT","","m","m",""
"TYPE","ID","2DP","2DP","X"
"DATA","BH01","0.00","1.50","Topsoil"
"DATA","BH01","1.50","6.20","Sandy clay"
`;

describe("locationsToGeoJson", () => {
  it("emits one Feature per located LOCA row by default", () => {
    const { file } = parseStr(SAMPLE);
    const fc = locationsToGeoJson(file);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0]!.geometry).toEqual({
      type: "Point",
      coordinates: [523456.0, 181234.5],
    });
    expect(fc.features[0]!.properties["LOCA_ID"]).toBe("BH01");
    expect(fc.features[0]!.properties["LOCA_GL"]).toBe(45.5);
  });

  it("includes a CRS member when supplied", () => {
    const { file } = parseStr(SAMPLE);
    const fc = locationsToGeoJson(file, { crs: "EPSG:27700" });
    expect(fc.crs).toEqual({ type: "name", properties: { name: "EPSG:27700" } });
  });

  it("decorates Features with GEOL summary fields", () => {
    const { file } = parseStr(SAMPLE);
    const fc = locationsToGeoJson(file);
    const bh01 = fc.features.find((f) => f.properties["LOCA_ID"] === "BH01")!;
    expect(bh01.properties["geol_layer_count"]).toBe(2);
    expect(bh01.properties["depth_max_m"]).toBe(6.2);
  });

  it("optionally includes unlocated rows with geometry: null", () => {
    const { file } = parseStr(SAMPLE);
    const fc = locationsToGeoJson(file, { includeUnlocated: true });
    expect(fc.features).toHaveLength(3);
    const bh03 = fc.features.find((f) => f.properties["LOCA_ID"] === "BH03")!;
    expect(bh03.geometry).toBeNull();
  });

  it("prefers LON/LAT over NATE/NATN when present", () => {
    const text = `"GROUP","LOCA"
"HEADING","LOCA_ID","LOCA_NATE","LOCA_NATN","LOCA_LON","LOCA_LAT"
"UNIT","","m","m","deg","deg"
"TYPE","ID","2DP","2DP","DP","DP"
"DATA","BH01","523456.00","181234.50","-1.234","53.456"
`;
    const { file } = parseStr(text);
    const fc = locationsToGeoJson(file);
    expect(fc.features[0]!.geometry!.coordinates).toEqual([-1.234, 53.456]);
  });

  it("returns an empty collection when LOCA is absent", () => {
    const { file } = parseStr(`"GROUP","PROJ"
"HEADING","PROJ_ID"
"UNIT",""
"TYPE","ID"
"DATA","P1"
`);
    expect(locationsToGeoJson(file).features).toEqual([]);
  });
});
