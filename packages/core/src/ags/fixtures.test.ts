import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeBytes, parseStr } from "./parser.js";
import { serialize } from "./serializer.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "../../../../tests/fixtures/ags");
const AGS_FIXTURES = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".ags"))
  .sort();

const NON_EXACT_ROUNDTRIP = new Set([
  "browser_explorer.ags",
  "sample_v3.ags",
  "short_row.ags",
]);

function readFixture(name: string) {
  return readFileSync(join(FIXTURE_DIR, name));
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

describe("AGS fixture parity", () => {
  for (const fixture of AGS_FIXTURES) {
    it(`parses ${fixture}`, () => {
      const text = decodeBytes(readFixture(fixture));
      const outcome = parseStr(text);

      if (fixture === "sample_v3.ags") {
        expect(outcome.diagnostics.map((d) => d.rule_id)).toContain("AGS-V3-UNSUPPORTED");
        expect(Object.keys(outcome.file.groups)).toHaveLength(0);
        return;
      }

      expect(Object.keys(outcome.file.groups).length).toBeGreaterThan(0);
    });
  }

  for (const fixture of AGS_FIXTURES.filter((name) => name !== "sample_v3.ags")) {
    it(`round-trips ${fixture} semantically`, () => {
      const text = decodeBytes(readFixture(fixture));
      const first = parseStr(text);
      const second = parseStr(serialize(first.file));

      expect(second.file).toEqual(first.file);
    });
  }

  for (const fixture of AGS_FIXTURES.filter((name) => !NON_EXACT_ROUNDTRIP.has(name))) {
    it(`round-trips ${fixture} byte-for-byte after newline normalization`, () => {
      const text = decodeBytes(readFixture(fixture));
      const outcome = parseStr(text);

      expect(serialize(outcome.file).trimEnd()).toBe(normalizeLineEndings(text).trimEnd());
    });
  }

  it("documents the remaining non-exact round-trip fixtures", () => {
    const mismatchSummary = AGS_FIXTURES
      .filter((name) => NON_EXACT_ROUNDTRIP.has(name))
      .map((name) => {
        const text = decodeBytes(readFixture(name));
        const outcome = parseStr(text);
        return {
          fixture: basename(name),
          diagnostics: outcome.diagnostics.map((d) => d.rule_id),
          exact: serialize(outcome.file).trimEnd() === normalizeLineEndings(text).trimEnd(),
        };
      });

    expect(mismatchSummary).toEqual([
      { fixture: "browser_explorer.ags", diagnostics: [], exact: false },
      { fixture: "sample_v3.ags", diagnostics: ["AGS-V3-UNSUPPORTED"], exact: false },
      { fixture: "short_row.ags", diagnostics: ["AGS-DATA-SHORT", "AGS-DATA-SHORT"], exact: false },
    ]);
  });
});
