import { parse as parseYaml } from "yaml";
import type { AgsFile } from "./model.js";
import type { Diagnostic} from "./diagnostics.js";
import { DiagnosticBuilder, Severity } from "./diagnostics.js";
import type { Rule } from "./validate.js";
import { BUILTIN_AGS_DICT } from "./dict.data.js";

export interface GroupDef {
  required_headings: string[];
  depth_headings: string[];
  key_headings: string[];
  parent_group?: string;
  heading_order: string[];
}

export interface DictFile {
  groups: Record<string, GroupDef>;
}

const DEFAULT_DICT: Record<string, GroupDef> = { ...BUILTIN_AGS_DICT };

let activeDict = DEFAULT_DICT;

export function currentDict(): Record<string, GroupDef> {
  return activeDict;
}

export function activateCustomDict(dict: Record<string, GroupDef>) {
  activeDict = { ...DEFAULT_DICT, ...dict };
}

export function deactivateCustomDict() {
  activeDict = DEFAULT_DICT;
}

/**
 * Parse a YAML dict file into a record of group definitions.
 *
 * Two layouts are accepted:
 *  - `{ groups: { GROUP: GroupDef, ... } }` (matches the `DictFile` shape)
 *  - `{ GROUP: GroupDef, ... }` (top-level, same shape as the built-in dict)
 *
 * Each group entry must at minimum supply `heading_order`. Optional
 * `required_headings`, `depth_headings`, `key_headings`, `parent_group` are
 * defaulted to sensible values if absent.
 */
export function parseDictYaml(yamlText: string): Record<string, GroupDef> {
  const raw = parseYaml(yamlText);
  if (typeof raw !== "object" || raw === null) {
    throw new Error("custom dict must be a YAML object");
  }
  const obj = raw as Record<string, unknown>;
  const groupsObj = (
    typeof obj.groups === "object" && obj.groups !== null && !Array.isArray(obj.groups)
      ? obj.groups
      : obj
  ) as Record<string, unknown>;

  const out: Record<string, GroupDef> = {};
  for (const [name, value] of Object.entries(groupsObj)) {
    if (name === "groups" && value === groupsObj) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const def = value as Record<string, unknown>;
    const headingOrder = arrayOfStrings(def.heading_order);
    if (headingOrder === null) {
      throw new Error(`group ${name}: heading_order must be an array of strings`);
    }
    const groupDef: GroupDef = {
      heading_order: headingOrder,
      required_headings: arrayOfStrings(def.required_headings) ?? [],
      depth_headings: arrayOfStrings(def.depth_headings) ?? [],
      key_headings: arrayOfStrings(def.key_headings) ?? [],
    };
    if (typeof def.parent_group === "string") {
      groupDef.parent_group = def.parent_group;
    }
    out[name] = groupDef;
  }
  return out;
}

function arrayOfStrings(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

export class DictRequiredHeadingsRule implements Rule {
  readonly id = "AGS-DICT-001";
  readonly description = "Required standard heading missing from group";
  readonly default_severity = Severity.Error;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const dict = currentDict();
    for (const groupName in dict) {
      const groupDef = dict[groupName]!;
      if (groupDef.required_headings.length === 0) continue;

      const group = file.groups[groupName];
      if (!group) continue;

      const present = new Set(group.headings.map((h) => h.name));
      for (const req of groupDef.required_headings) {
        if (!present.has(req)) {
          diagnostics.push(
            new DiagnosticBuilder(
              this.id,
              this.default_severity,
              `${groupName} is missing required heading ${req}`
            )
              .atGroup(groupName)
              .build()
          );
        }
      }
    }
  }
}

export class DictDepthUnitsRule implements Rule {
  readonly id = "AGS-DICT-002";
  readonly description = "Depth heading should carry unit \"m\"";
  readonly default_severity = Severity.Warning;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const dict = currentDict();
    for (const groupName in dict) {
      const groupDef = dict[groupName]!;
      if (groupDef.depth_headings.length === 0) continue;

      const group = file.groups[groupName];
      if (!group) continue;

      const depthSet = new Set(groupDef.depth_headings);
      for (const heading of group.headings) {
        if (!depthSet.has(heading.name)) continue;

        const unit = heading.unit.trim();
        if (unit !== "" && unit !== "m") {
          diagnostics.push(
            new DiagnosticBuilder(
              this.id,
              this.default_severity,
              `${groupName}.${heading.name} has unit ${JSON.stringify(unit)}; depth headings should use "m"`
            )
              .atGroup(groupName)
              .build()
          );
        }
      }
    }
  }
}
