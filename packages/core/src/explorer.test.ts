import { describe, it, expect } from "vitest";
import { renderExplorerFromBytes } from "./explorer.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MINIMAL_AGS = [
  '"GROUP","PROJ"',
  '"HEADING","PROJ_ID","PROJ_NAME"',
  '"UNIT","",""',
  '"TYPE","ID","X"',
  '"DATA","P001","Test Project"',
  "",
  '"GROUP","TRAN"',
  '"HEADING","TRAN_AGS"',
  '"UNIT",""',
  '"TYPE","X"',
  '"DATA","4.1"',
  "",
].join("\r\n");

const WITH_BOREHOLES_AGS = [
  '"GROUP","PROJ"',
  '"HEADING","PROJ_ID","PROJ_NAME"',
  '"UNIT","",""',
  '"TYPE","ID","X"',
  '"DATA","P001","Test Project"',
  "",
  '"GROUP","LOCA"',
  '"HEADING","LOCA_ID","LOCA_TYPE","LOCA_NATE","LOCA_NATN","LOCA_GL","LOCA_FDEP"',
  '"UNIT","","","m","m","m","m"',
  '"TYPE","ID","X","2DP","2DP","2DP","2DP"',
  '"DATA","BH01","BH","123456.78","234567.89","45.67","10.00"',
  '"DATA","BH02","BH","123460.00","234570.00","45.50","8.50"',
  "",
  '"GROUP","GEOL"',
  '"HEADING","LOCA_ID","GEOL_TOP","GEOL_BASE","GEOL_DESC","GEOL_LEG"',
  '"UNIT","","m","m","",""',
  '"TYPE","ID","2DP","2DP","X","PA"',
  '"DATA","BH01","0.00","1.50","Topsoil","TS"',
  '"DATA","BH01","1.50","10.00","Firm brown clay","CL"',
  '"DATA","BH02","0.00","1.20","Topsoil","TS"',
  '"DATA","BH02","1.20","8.50","Stiff clay","CL"',
  "",
].join("\r\n");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("renderExplorerFromBytes", () => {
  it("returns a non-empty HTML string for minimal file", () => {
    const bytes = new TextEncoder().encode(MINIMAL_AGS);
    const html = renderExplorerFromBytes(bytes, "test.ags");
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(100);
  });

  it("output starts with <!DOCTYPE html>", () => {
    const bytes = new TextEncoder().encode(MINIMAL_AGS);
    const html = renderExplorerFromBytes(bytes, "test.ags");
    expect(html.trimStart()).toMatch(/^<!DOCTYPE html>/i);
  });

  it("output contains basic HTML structure", () => {
    const bytes = new TextEncoder().encode(MINIMAL_AGS);
    const html = renderExplorerFromBytes(bytes, "test.ags");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
    expect(html).toContain("<head");
    expect(html).toContain("<body");
  });

  it("output contains the source file reference", () => {
    const bytes = new TextEncoder().encode(MINIMAL_AGS);
    const html = renderExplorerFromBytes(bytes, "test.ags");
    expect(html).toContain("test.ags");
  });

  it("output contains borehole IDs when LOCA present", () => {
    const bytes = new TextEncoder().encode(WITH_BOREHOLES_AGS);
    const html = renderExplorerFromBytes(bytes, "boreholes.ags");
    expect(html).toContain("BH01");
    expect(html).toContain("BH02");
  });

  it("output contains geological descriptions", () => {
    const bytes = new TextEncoder().encode(WITH_BOREHOLES_AGS);
    const html = renderExplorerFromBytes(bytes, "boreholes.ags");
    expect(html).toContain("Topsoil");
  });

  it("output contains SVG for strip logs", () => {
    const bytes = new TextEncoder().encode(WITH_BOREHOLES_AGS);
    const html = renderExplorerFromBytes(bytes, "boreholes.ags");
    expect(html).toContain("<svg");
  });

  it("handles empty AGS bytes gracefully", () => {
    const bytes = new Uint8Array(0);
    // Should not throw; may produce a minimal HTML page
    expect(() => renderExplorerFromBytes(bytes, "empty.ags")).not.toThrow();
  });

  it("accepts a Buffer as input", () => {
    const bytes = Buffer.from(MINIMAL_AGS, "utf-8");
    expect(() => renderExplorerFromBytes(bytes, "test.ags")).not.toThrow();
  });

  it("is self-contained (no external script src)", () => {
    const bytes = new TextEncoder().encode(WITH_BOREHOLES_AGS);
    const html = renderExplorerFromBytes(bytes, "test.ags");
    // Should not reference external URLs
    expect(html).not.toMatch(/src="https?:\/\//);
    expect(html).not.toMatch(/href="https?:\/\//);
  });
});
