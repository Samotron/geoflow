import { AgsFile } from "./model.js";
import { Diagnostic, DiagnosticBuilder, Severity } from "./diagnostics.js";
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
