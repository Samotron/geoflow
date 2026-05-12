import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { BUILTIN_AGS_DICT } from "./dict.data.js";
import { activateCustomDict, currentDict, deactivateCustomDict } from "./dict.js";

describe("dictionary bundle", () => {
  it("includes every group defined in rules/specs/ags/dict/ags4.yml", () => {
    const path = resolve(import.meta.dirname, "../../../rules/specs/ags/dict/ags4.yml");
    const parsed = YAML.parse(readFileSync(path, "utf8")) as { groups: Record<string, GroupDef> };

    for (const [groupName, definition] of Object.entries(parsed.groups)) {
      const builtin = BUILTIN_AGS_DICT[groupName as keyof typeof BUILTIN_AGS_DICT];
      expect(builtin.required_headings).toEqual(definition.required_headings);
      expect(builtin.depth_headings).toEqual(definition.depth_headings);
      expect(builtin.key_headings).toEqual(definition.key_headings);
      expect(builtin.parent_group).toEqual(definition.parent_group);
      expect(builtin.heading_order.slice(0, definition.heading_order.length)).toEqual(definition.heading_order);
    }
  });

  it("extends the reduced YAML dictionary with known standard headings used by fixtures", () => {
    expect(BUILTIN_AGS_DICT.PROJ.heading_order).toContain("PROJ_NAME");
    expect(BUILTIN_AGS_DICT.PROJ.heading_order).toContain("PROJ_LOC");
    expect(BUILTIN_AGS_DICT.TRAN.heading_order).toContain("TRAN_DATE");
    expect(BUILTIN_AGS_DICT.TRAN.heading_order).toContain("TRAN_PROD");
  });

  it("supports custom overlays without mutating the built-in dictionary", () => {
    activateCustomDict({
      TEST: {
        required_headings: ["TEST_ID"],
        depth_headings: [],
        key_headings: ["TEST_ID"],
        heading_order: ["TEST_ID"],
      },
    });

    expect(currentDict().TEST).toEqual({
      required_headings: ["TEST_ID"],
      depth_headings: [],
      key_headings: ["TEST_ID"],
      heading_order: ["TEST_ID"],
    });
    expect(currentDict().PROJ).toEqual(BUILTIN_AGS_DICT.PROJ);

    deactivateCustomDict();
    expect(currentDict().TEST).toBeUndefined();
    expect(currentDict().PROJ).toEqual(BUILTIN_AGS_DICT.PROJ);
  });
});
