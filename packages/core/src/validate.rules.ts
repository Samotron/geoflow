import type { Diagnostic} from "./diagnostics.js";
import { DiagnosticBuilder, Severity } from "./diagnostics.js";
import { currentDict, DictDepthUnitsRule, DictRequiredHeadingsRule } from "./dict.js";
import type { AgsFile, AgsRow, AgsType} from "./model.js";
import { AgsTypeFunctions } from "./model.js";
import type { Rule } from "./validate.js";

function textValue(row: AgsRow, heading: string): string | null {
  const value = row[heading];
  return typeof value === "string" ? value : null;
}

function numericKeyPart(row: AgsRow, heading: string): string | null {
  const value = row[heading];
  if (typeof value === "number") {
    return `${value}`;
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}

export class AbbrCodelistRule implements Rule {
  readonly id = "AGS-ABBR-001";
  readonly description = "PA-type field values must be defined in the ABBR group";
  readonly default_severity = Severity.Error;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const abbrGroup = file.groups.ABBR;
    if (!abbrGroup) {
      return;
    }

    const permitted = new Map<string, Set<string>>();
    for (const row of abbrGroup.rows) {
      const heading = textValue(row, "ABBR_HDNG");
      const code = textValue(row, "ABBR_CODE");
      if (!heading || !code) {
        continue;
      }
      if (!permitted.has(heading)) {
        permitted.set(heading, new Set());
      }
      permitted.get(heading)!.add(code);
    }

    if (permitted.size === 0) {
      return;
    }

    const separator = textValue(file.groups.TRAN?.rows[0] ?? {}, "TRAN_RCON") ?? "+";

    for (const [groupName, group] of Object.entries(file.groups)) {
      for (const heading of group.headings) {
        if (heading.data_type !== "PA") {
          continue;
        }
        const codes = permitted.get(heading.name);
        if (!codes) {
          continue;
        }

        for (const row of group.rows) {
          const value = textValue(row, heading.name);
          if (!value) {
            continue;
          }

          for (const part of value.split(separator).map((item) => item.trim())) {
            if (part.length > 0 && !codes.has(part)) {
              diagnostics.push(
                new DiagnosticBuilder(
                  this.id,
                  this.default_severity,
                  `${groupName}.${heading.name}: ${JSON.stringify(part)} is not defined in ABBR group`
                )
                  .atGroup(groupName)
                  .build()
              );
            }
          }
        }
      }
    }
  }
}

export class UnitCodelistRule implements Rule {
  readonly id = "AGS-UNIT-001";
  readonly description = "PU-type field values must be defined in the UNIT group";
  readonly default_severity = Severity.Warning;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const unitGroup = file.groups.UNIT;
    if (!unitGroup) {
      return;
    }

    const permitted = new Set<string>();
    for (const row of unitGroup.rows) {
      const unit = textValue(row, "UNIT_ABBR");
      if (unit) {
        permitted.add(unit);
      }
    }

    if (permitted.size === 0) {
      return;
    }

    for (const [groupName, group] of Object.entries(file.groups)) {
      if (groupName === "UNIT") {
        continue;
      }

      for (const heading of group.headings) {
        if (heading.data_type !== "PU") {
          continue;
        }

        for (const row of group.rows) {
          const value = textValue(row, heading.name);
          if (value && !permitted.has(value)) {
            diagnostics.push(
              new DiagnosticBuilder(
                this.id,
                this.default_severity,
                `${groupName}.${heading.name}: unit ${JSON.stringify(value)} is not defined in UNIT group`
              )
                .atGroup(groupName)
                .build()
            );
          }
        }
      }
    }
  }
}

export class XrefLocaRule implements Rule {
  readonly id = "AGS-XREF-LOCA";
  readonly description = "All LOCA_ID references must resolve to an existing LOCA row";
  readonly default_severity = Severity.Error;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const locaGroup = file.groups.LOCA;
    if (!locaGroup) {
      return;
    }

    const ids = new Set<string>();
    for (const row of locaGroup.rows) {
      const id = textValue(row, "LOCA_ID");
      if (id) {
        ids.add(id);
      }
    }

    for (const [groupName, group] of Object.entries(file.groups)) {
      if (groupName === "LOCA" || !group.headings.some((heading) => heading.name === "LOCA_ID")) {
        continue;
      }

      for (const row of group.rows) {
        const id = textValue(row, "LOCA_ID");
        if (id && !ids.has(id)) {
          diagnostics.push(
            new DiagnosticBuilder(
              this.id,
              this.default_severity,
              `${groupName}: LOCA_ID ${JSON.stringify(id)} does not exist in LOCA`
            )
              .atGroup(groupName)
              .build()
          );
        }
      }
    }
  }
}

export class IdColumnUniquenessRule implements Rule {
  readonly id = "AGS-ID-001";
  readonly description = "ID-type primary key columns must have unique values within their group";
  readonly default_severity = Severity.Error;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    for (const [groupName, group] of Object.entries(file.groups)) {
      const primaryKey = `${groupName}_ID`;
      const primaryHeading = group.headings.find(
        (heading) => heading.name === primaryKey && heading.data_type === "ID"
      );
      if (!primaryHeading) {
        continue;
      }

      const seen = new Set<string>();
      const reported = new Set<string>();
      for (const row of group.rows) {
        const value = textValue(row, primaryHeading.name);
        if (!value) {
          continue;
        }
        if (seen.has(value) && !reported.has(value)) {
          reported.add(value);
          diagnostics.push(
            new DiagnosticBuilder(
              this.id,
              this.default_severity,
              `${groupName}.${primaryHeading.name}: duplicate value ${JSON.stringify(value)}`
            )
              .atGroup(groupName)
              .build()
          );
        }
        seen.add(value);
      }
    }
  }
}

export class SampCompositeKeyRule implements Rule {
  readonly id = "AGS-KEY-002";
  readonly description = "Within a borehole, LOCA_ID + SAMP_TOP + SAMP_REF must be unique in SAMP";
  readonly default_severity = Severity.Error;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const sampGroup = file.groups.SAMP;
    if (!sampGroup) {
      return;
    }

    const seen = new Set<string>();
    const reported = new Set<string>();
    for (const row of sampGroup.rows) {
      const locaId = textValue(row, "LOCA_ID");
      const sampTop = numericKeyPart(row, "SAMP_TOP");
      const sampRef = textValue(row, "SAMP_REF");
      if (!locaId || sampTop === null || !sampRef) {
        continue;
      }

      const key = `${locaId}\u0000${sampTop}\u0000${sampRef}`;
      if (seen.has(key) && !reported.has(key)) {
        reported.add(key);
        diagnostics.push(
          new DiagnosticBuilder(
            this.id,
            this.default_severity,
            `SAMP: duplicate composite key LOCA_ID=${JSON.stringify(locaId)} SAMP_TOP=${JSON.stringify(sampTop)} SAMP_REF=${JSON.stringify(sampRef)}`
          )
            .atGroup("SAMP")
            .build()
        );
      }
      seen.add(key);
    }
  }
}

export class NonStandardHeadingRule implements Rule {
  readonly id = "AGS-DICT-004";
  readonly description = "Heading is not in the standard AGS dictionary";
  readonly default_severity = Severity.Warning;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const dict = currentDict();
    for (const [groupName, group] of Object.entries(file.groups)) {
      const definition = dict[groupName];
      if (!definition) {
        continue;
      }

      const standardHeadings = new Set(definition.heading_order);
      for (const heading of group.headings) {
        if (!standardHeadings.has(heading.name)) {
          diagnostics.push(
            new DiagnosticBuilder(
              this.id,
              this.default_severity,
              `${groupName}: heading ${JSON.stringify(heading.name)} is not in the standard AGS dictionary`
            )
              .atGroup(groupName)
              .build()
          );
        }
      }
    }
  }
}

export class MissingDictDefinitionsRule implements Rule {
  readonly id = "AGS-DICT-005";
  readonly description = "Non-standard headings must be defined by a DICT group";
  readonly default_severity = Severity.Warning;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    if (file.groups.DICT || !hasNonStandardHeadings(file)) {
      return;
    }

    diagnostics.push(
      new DiagnosticBuilder(
        this.id,
        this.default_severity,
        "file contains non-standard headings but has no DICT group to define them"
      ).build()
    );
  }
}

export class RequiredNonEmptyRule implements Rule {
  readonly id = "AGS-DICT-003";
  readonly description = "Required headings must have non-empty values in every DATA row";
  readonly default_severity = Severity.Error;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const dict = currentDict();
    for (const [groupName, definition] of Object.entries(dict)) {
      if (definition.required_headings.length === 0) {
        continue;
      }

      const group = file.groups[groupName];
      if (!group) {
        continue;
      }

      for (const required of definition.required_headings) {
        if (!group.headings.some((heading) => heading.name === required)) {
          continue;
        }

        for (const row of group.rows) {
          const value = row[required];
          const isEmpty =
            value === null ||
            value === undefined ||
            (typeof value === "string" && value.length === 0);

          if (isEmpty) {
            diagnostics.push(
              new DiagnosticBuilder(
                this.id,
                this.default_severity,
                `${groupName}.${required}: required heading has an empty value`
              )
                .atGroup(groupName)
                .build()
            );
          }
        }
      }
    }
  }
}

export class HeadingNameFormatRule implements Rule {
  readonly id = "AGS-HEAD-004";
  readonly description = "Heading names should be <=9 chars, uppercase alphanumeric and underscore only";
  readonly default_severity = Severity.Warning;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    for (const [groupName, group] of Object.entries(file.groups)) {
      for (const heading of group.headings) {
        if (!isValidHeadingName(heading.name)) {
          diagnostics.push(
            new DiagnosticBuilder(
              this.id,
              this.default_severity,
              `${groupName}: heading ${JSON.stringify(heading.name)} does not follow AGS naming convention (<=9 uppercase alphanumeric/underscore chars)`
            )
              .atGroup(groupName)
              .withFix("uppercase-heading-names")
              .build()
          );
        }
      }
    }
  }
}

function isValidHeadingName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 9 &&
    Array.from(name).every(
      (char) => (char >= "A" && char <= "Z") || (char >= "0" && char <= "9") || char === "_"
    )
  );
}

export class HeadingOrderRule implements Rule {
  readonly id = "AGS-HEAD-007";
  readonly description = "Required headings should appear in the standard dictionary reference order";
  readonly default_severity = Severity.Warning;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const dict = currentDict();
    for (const [groupName, definition] of Object.entries(dict)) {
      if (definition.heading_order.length < 2) {
        continue;
      }

      const group = file.groups[groupName];
      if (!group) {
        continue;
      }

      const actualPositions = new Map<string, number>();
      group.headings.forEach((heading, index) => {
        actualPositions.set(heading.name, index);
      });

      const positions = definition.heading_order
        .map((heading) => actualPositions.get(heading))
        .filter((position): position is number => position !== undefined);

      if (positions.length < 2) {
        continue;
      }

      const ordered = positions.every((position, index) => index === 0 || positions[index - 1]! < position);
      if (!ordered) {
        diagnostics.push(
          new DiagnosticBuilder(
            this.id,
            this.default_severity,
            `${groupName}: headings are not in the standard reference order (expected: ${definition.heading_order.join(", ")})`
          )
            .atGroup(groupName)
            .build()
        );
      }
    }
  }
}

export class EmptyGroupRule implements Rule {
  readonly id = "AGS-STRUCT-005";
  readonly description = "Every group must contain at least one DATA row";
  readonly default_severity = Severity.Warning;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    for (const [groupName, group] of Object.entries(file.groups)) {
      if (group.rows.length === 0) {
        diagnostics.push(
          new DiagnosticBuilder(
            this.id,
            this.default_severity,
            `${groupName}: group has no DATA rows`
          )
            .atGroup(groupName)
            .build()
        );
      }
    }
  }
}

export class CompositeKeyRule implements Rule {
  readonly id = "AGS-KEY-010";
  readonly description = "Composite key fields must be unique within their group";
  readonly default_severity = Severity.Error;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const dict = currentDict();
    for (const [groupName, definition] of Object.entries(dict)) {
      if (definition.key_headings.length < 2 || groupName === "SAMP") {
        continue;
      }

      const group = file.groups[groupName];
      if (!group) {
        continue;
      }

      const allPresent = definition.key_headings.every((key) =>
        group.headings.some((heading) => heading.name === key)
      );
      if (!allPresent) {
        continue;
      }

      const seen = new Set<string>();
      const reported = new Set<string>();

      for (const row of group.rows) {
        const parts = definition.key_headings.map((key) => stringifyKeyValue(row[key]));
        const composite = parts.join("\u0000");

        if (seen.has(composite) && !reported.has(composite)) {
          reported.add(composite);
          const keyFields = definition.key_headings
            .map((key) => `${key}=${JSON.stringify(stringifyKeyValue(row[key]))}`)
            .join(", ");
          diagnostics.push(
            new DiagnosticBuilder(
              this.id,
              this.default_severity,
              `${groupName}: duplicate composite key (${keyFields}) — key fields: ${definition.key_headings.join(", ")}`
            )
              .atGroup(groupName)
              .build()
          );
        }

        seen.add(composite);
      }
    }
  }
}

export class ParentGroupXrefRule implements Rule {
  readonly id = "AGS-XREF-PGRP";
  readonly description = "Child group rows must reference an existing parent group composite key";
  readonly default_severity = Severity.Error;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const dict = currentDict();

    for (const [groupName, definition] of Object.entries(dict)) {
      const parentName = definition.parent_group;
      if (!parentName || parentName === "LOCA") {
        continue;
      }

      const childGroup = file.groups[groupName];
      const parentDefinition = dict[parentName];
      const parentGroup = file.groups[parentName];
      if (!childGroup || !parentDefinition || !parentGroup) {
        continue;
      }

      const sharedKeys = definition.key_headings.filter((key) =>
        parentDefinition.key_headings.includes(key)
      );
      if (sharedKeys.length === 0) {
        continue;
      }

      const parentKeys = new Set(
        parentGroup.rows.map((row) => sharedKeys.map((key) => stringifyKeyValue(row[key])).join("\u0000"))
      );

      for (const row of childGroup.rows) {
        const childKey = sharedKeys.map((key) => stringifyKeyValue(row[key])).join("\u0000");
        if (childKey.replace(/\u0000/g, "").length === 0) {
          continue;
        }

        if (!parentKeys.has(childKey)) {
          const keyDesc = sharedKeys
            .map((key) => `${key}=${JSON.stringify(stringifyKeyValue(row[key]))}`)
            .join(", ");
          diagnostics.push(
            new DiagnosticBuilder(
              this.id,
              this.default_severity,
              `${groupName}: row (${keyDesc}) has no matching parent in ${parentName}`
            )
              .atGroup(groupName)
              .build()
          );
        }
      }
    }
  }
}

function stringifyKeyValue(value: AgsRow[string] | undefined): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return `${value}`;
  }
  if (typeof value === "string") {
    return value;
  }
  return "";
}

export class TranDlimRule implements Rule {
  readonly id = "AGS-TRAN-001";
  readonly description = "TRAN_DLIM must be declared in TRAN when any RL-type field is used";
  readonly default_severity = Severity.Warning;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const hasRl = Object.values(file.groups).some((group) =>
      group.headings.some((heading) => heading.data_type === "RL")
    );
    if (!hasRl) {
      return;
    }

    const tranHasDlim = file.groups.TRAN?.headings.some((heading) => heading.name === "TRAN_DLIM") ?? false;
    if (!tranHasDlim) {
      diagnostics.push(
        new DiagnosticBuilder(
          this.id,
          this.default_severity,
          "file contains RL-type headings but TRAN does not declare TRAN_DLIM"
        ).build()
      );
    }
  }
}

export class RlXrefRule implements Rule {
  readonly id = "AGS-RL-001";
  readonly description = "RL-type field values (GROUP:ID) must reference an existing group and ID";
  readonly default_severity = Severity.Error;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const delimiter = textValue(file.groups.TRAN?.rows[0] ?? {}, "TRAN_DLIM") || ":";
    const idIndex = new Map<string, Set<string>>();

    for (const [groupName, group] of Object.entries(file.groups)) {
      for (const heading of group.headings) {
        if (heading.data_type !== "ID") {
          continue;
        }
        if (!idIndex.has(groupName)) {
          idIndex.set(groupName, new Set());
        }
        const entry = idIndex.get(groupName)!;
        for (const row of group.rows) {
          const value = textValue(row, heading.name);
          if (value) {
            entry.add(value);
          }
        }
      }
    }

    for (const [groupName, group] of Object.entries(file.groups)) {
      for (const heading of group.headings) {
        if (heading.data_type !== "RL") {
          continue;
        }
        for (const row of group.rows) {
          const value = textValue(row, heading.name);
          if (!value) {
            continue;
          }

          const parts = value.split(delimiter);
          if (parts.length !== 2) {
            diagnostics.push(
              new DiagnosticBuilder(
                this.id,
                this.default_severity,
                `${groupName}.${heading.name}: RL value ${JSON.stringify(value)} does not contain delimiter ${JSON.stringify(delimiter)}`
              )
                .atGroup(groupName)
                .build()
            );
            continue;
          }

          const targetGroup = parts[0]!.trim();
          const targetId = parts[1]!.trim();
          const ids = idIndex.get(targetGroup);

          if (!ids) {
            diagnostics.push(
              new DiagnosticBuilder(
                this.id,
                this.default_severity,
                `${groupName}.${heading.name}: RL references group ${JSON.stringify(targetGroup)} which does not exist`
              )
                .atGroup(groupName)
                .build()
            );
            continue;
          }

          if (!ids.has(targetId)) {
            diagnostics.push(
              new DiagnosticBuilder(
                this.id,
                this.default_severity,
                `${groupName}.${heading.name}: RL value ${JSON.stringify(targetId)} not found in ${targetGroup}`
              )
                .atGroup(groupName)
                .build()
            );
          }
        }
      }
    }
  }
}

export class TypeGroupCoverageRule implements Rule {
  readonly id = "AGS-TYPE-003";
  readonly description = "All AGS type codes used in the file must be listed in the TYPE group";
  readonly default_severity = Severity.Warning;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const typeGroup = file.groups.TYPE;
    if (!typeGroup) {
      return;
    }

    const typeStats = new Set<string>();
    for (const row of typeGroup.rows) {
      const value = textValue(row, "TYPE_STAT");
      if (value) {
        typeStats.add(value);
      }
    }

    if (typeStats.size === 0) {
      return;
    }

    for (const [groupName, group] of Object.entries(file.groups)) {
      if (groupName === "TYPE") {
        continue;
      }

      for (const heading of group.headings) {
        const code = AgsTypeFunctions.toString(heading.data_type);
        if (!typeStats.has(code)) {
          diagnostics.push(
            new DiagnosticBuilder(
              this.id,
              this.default_severity,
              `${groupName}.${heading.name}: type code ${JSON.stringify(code)} is not listed in TYPE group`
            )
              .atGroup(groupName)
              .build()
          );
        }
      }
    }
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;
const DMS_RE = /^-?\d+:[0-5]\d:[0-5]\d(\.\d+)?$/;

export class TypeValueRule implements Rule {
  readonly id = "AGS-TYPE-002";
  readonly description = "Data values must conform to their declared AGS type";
  readonly default_severity = Severity.Error;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    for (const [groupName, group] of Object.entries(file.groups)) {
      for (const row of group.rows) {
        for (const heading of group.headings) {
          const value = row[heading.name];
          if (value === undefined) {
            continue;
          }
          const message = typeViolation(groupName, heading.name, value, heading.data_type);
          if (message) {
            const builder = new DiagnosticBuilder(this.id, this.default_severity, message).atGroup(groupName);
            const fixId = typeViolationFixId(value, heading.data_type);
            if (fixId) {
              builder.withFix(fixId);
            }
            diagnostics.push(builder.build());
          }
        }
      }
    }
  }
}

function typeViolation(group: string, heading: string, value: AgsRow[string], type: AgsType): string | null {
  if (value === null) {
    return null;
  }

  if (type === "YN" && typeof value === "string") {
    const upper = value.toUpperCase();
    if (upper !== "Y" && upper !== "N") {
      return `${group}.${heading}: ${JSON.stringify(value)} is not a valid Y/N value (expected Y or N)`;
    }
  }

  if (AgsTypeFunctions.isNumeric(type) && typeof value === "string" && value.length > 0) {
    return `${group}.${heading}: ${JSON.stringify(value)} cannot be parsed as a number (declared type ${AgsTypeFunctions.toString(type)})`;
  }

  if (type === "DT" && typeof value === "string" && value.length > 0 && !DATE_RE.test(value)) {
    return `${group}.${heading}: ${JSON.stringify(value)} does not match date format YYYY-MM-DD`;
  }

  if (type === "T" && typeof value === "string" && value.length > 0 && !TIME_RE.test(value)) {
    return `${group}.${heading}: ${JSON.stringify(value)} does not match time format HH:MM or HH:MM:SS`;
  }

  if (type === "DMS" && typeof value === "string" && value.length > 0 && !DMS_RE.test(value)) {
    return `${group}.${heading}: ${JSON.stringify(value)} does not match DMS format D:MM:SS (colon-separated)`;
  }

  if (type === "U" && typeof value === "string" && value.length > 0 && Number.isNaN(Number(value))) {
    return `${group}.${heading}: ${JSON.stringify(value)} is not numeric (U type requires a number)`;
  }

  return null;
}

function typeViolationFixId(value: AgsRow[string], type: AgsType): string | null {
  if (typeof value === "string" && type === "YN") {
    switch (value.trim().toUpperCase()) {
      case "Y":
      case "YES":
      case "TRUE":
      case "1":
      case "N":
      case "NO":
      case "FALSE":
      case "0":
        return "normalize-yn-values";
    }
  }

  if (typeof value === "string" && value.length > 0 && AgsTypeFunctions.isNumeric(type)) {
    return "coerce-numeric-fields";
  }

  if (typeof value === "string" && value.length > 0 && type === "DT") {
    return "normalize-date-fields";
  }

  return null;
}

export class NumericHeadingsUnitRule implements Rule {
  readonly id = "AGS-HEAD-002";
  readonly description = "Numeric headings should declare a unit.";
  readonly default_severity = Severity.Warning;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const hasMissingUnit = Object.values(file.groups).some((group) =>
      group.headings.some(
        (heading) => AgsTypeFunctions.isNumeric(heading.data_type) && heading.unit.trim() === ""
      )
    );

    if (hasMissingUnit) {
      diagnostics.push(
        new DiagnosticBuilder(
          this.id,
          this.default_severity,
          "one or more numeric headings have no unit declared"
        ).build()
      );
    }
  }
}

export class GeolMonotonicityRule implements Rule {
  readonly id = "AGS-VAL-002";
  readonly description =
    "GEOL layers within each borehole must be in ascending depth order (no overlaps or reversals).";
  readonly default_severity = Severity.Error;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const geol = file.groups.GEOL;
    if (!geol) {
      return;
    }

    const byLoca = new Map<string, number[]>();
    for (const row of geol.rows) {
      const locaId = textValue(row, "LOCA_ID");
      const top = row.GEOL_TOP;
      if (!locaId || typeof top !== "number") {
        continue;
      }
      if (!byLoca.has(locaId)) {
        byLoca.set(locaId, []);
      }
      byLoca.get(locaId)!.push(top);
    }

    for (const [locaId, tops] of byLoca.entries()) {
      for (let i = 1; i < tops.length; i++) {
        if (tops[i - 1]! > tops[i]!) {
          diagnostics.push(
            new DiagnosticBuilder(
              this.id,
              this.default_severity,
              `GEOL layers for LOCA_ID ${locaId} are not in ascending depth order`
            )
              .atGroup("GEOL")
              .build()
          );
          break;
        }
      }
    }
  }
}

const VALID_TRAN_AGS_VERSIONS = new Set(["4.0.3", "4.0.4", "4.1", "4.1.1", "4.2"]);

export class TranAgsVersionRule implements Rule {
  readonly id = "AGS-STRUCT-004";
  readonly description = "TRAN_AGS must be a recognised AGS 4 version";
  readonly default_severity = Severity.Warning;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const tranGroup = file.groups.TRAN;
    if (!tranGroup) {
      return;
    }

    for (const row of tranGroup.rows) {
      const value = row.TRAN_AGS;
      if (typeof value !== "string" || value.length === 0) {
        continue;
      }
      if (!VALID_TRAN_AGS_VERSIONS.has(value)) {
        diagnostics.push(
          new DiagnosticBuilder(
            this.id,
            this.default_severity,
            `TRAN_AGS value '${value}' is not a recognised AGS 4 version`
          )
            .atGroup("TRAN")
            .build()
        );
      }
    }
  }
}

export class TrailingWhitespaceRule implements Rule {
  readonly id = "AGS-FMT-001";
  readonly description = "Rows should not contain values with trailing whitespace";
  readonly default_severity = Severity.Warning;
  readonly fixable_by = "normalize-whitespace";

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    for (const [groupName, group] of Object.entries(file.groups)) {
      let reported = false;
      for (const row of group.rows) {
        if (reported) {
          break;
        }
        for (const value of Object.values(row)) {
          if (typeof value === "string" && /\s+$/.test(value)) {
            diagnostics.push(
              new DiagnosticBuilder(
                this.id,
                this.default_severity,
                `row in ${groupName} contains a value with trailing whitespace`
              )
                .atGroup(groupName)
                .build()
            );
            reported = true;
            break;
          }
        }
      }
    }
  }
}

// ── AGS-STRUCT-001: exactly one PROJ group with one row ──────────────────────

export class ProjGroupRule implements Rule {
  readonly id = "AGS-STRUCT-001";
  readonly description = "AGS files must contain exactly one PROJ group with one row.";
  readonly default_severity = Severity.Error;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const proj = file.groups["PROJ"];
    if (!proj || proj.rows.length !== 1) {
      diagnostics.push(
        new DiagnosticBuilder(
          this.id,
          this.default_severity,
          "PROJ group missing or does not have exactly one DATA row"
        ).build()
      );
    }
  }
}

// ── AGS-STRUCT-002: TRAN group with TRAN_AGS heading ─────────────────────────

export class TranGroupRule implements Rule {
  readonly id = "AGS-STRUCT-002";
  readonly description = "AGS 4 files must contain a TRAN group with a TRAN_AGS heading.";
  readonly default_severity = Severity.Error;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const tran = file.groups["TRAN"];
    const hasAgsHeading = tran?.headings.some((h) => h.name === "TRAN_AGS") ?? false;
    if (!tran || !hasAgsHeading) {
      diagnostics.push(
        new DiagnosticBuilder(
          this.id,
          this.default_severity,
          "missing TRAN group or TRAN_AGS heading"
        ).build()
      );
    }
  }
}

// ── AGS-STRUCT-003: every LOCA row must have a non-empty LOCA_ID ─────────────

export class LocaIdRule implements Rule {
  readonly id = "AGS-STRUCT-003";
  readonly description = "Every LOCA row must have a non-empty LOCA_ID.";
  readonly default_severity = Severity.Error;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const loca = file.groups["LOCA"];
    if (!loca) return;
    for (const row of loca.rows) {
      const id = row["LOCA_ID"];
      if (id === null || id === undefined || id === "") {
        diagnostics.push(
          new DiagnosticBuilder(
            this.id,
            this.default_severity,
            "LOCA row has empty or missing LOCA_ID"
          )
            .atGroup("LOCA")
            .build()
        );
      }
    }
  }
}

// ── AGS-HEAD-001: every group must declare a HEADING row ─────────────────────

export class HeadingRowPresentRule implements Rule {
  readonly id = "AGS-HEAD-001";
  readonly description = "Every group must declare a HEADING row.";
  readonly default_severity = Severity.Error;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    for (const [groupName, group] of Object.entries(file.groups)) {
      if (group.headings.length === 0) {
        diagnostics.push(
          new DiagnosticBuilder(
            this.id,
            this.default_severity,
            `${groupName} is missing a HEADING row`
          )
            .atGroup(groupName)
            .build()
        );
      }
    }
  }
}

// ── AGS-HEAD-003: every heading must have a declared TYPE ─────────────────────

export class HeadingTypeDeclaredRule implements Rule {
  readonly id = "AGS-HEAD-003";
  readonly description = "Every heading must have a declared TYPE.";
  readonly default_severity = Severity.Error;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    for (const [groupName, group] of Object.entries(file.groups)) {
      for (const heading of group.headings) {
        const typeStr = AgsTypeFunctions.toString(heading.data_type);
        if (typeStr === "" || typeStr === "Other") {
          diagnostics.push(
            new DiagnosticBuilder(
              this.id,
              this.default_severity,
              `${groupName}.${heading.name} is missing a TYPE declaration`
            )
              .atGroup(groupName)
              .build()
          );
        }
      }
    }
  }
}

// ── AGS-TYPE-001: TYPE codes must be recognised AGS 4.x codes ────────────────

const VALID_AGS_TYPE_STRINGS = new Set([
  "X", "XN", "MC", "ID", "PA", "PT", "PU", "T", "DT", "YN", "RL", "U", "RECORD_LINK", "DMS",
]);

function isValidAgsType(t: AgsType): boolean {
  if (typeof t === "string") return VALID_AGS_TYPE_STRINGS.has(t);
  return t._tag === "DP" || t._tag === "SF" || t._tag === "SCI";
}

export class ValidAgsTypeCodeRule implements Rule {
  readonly id = "AGS-TYPE-001";
  readonly description = "TYPE codes must be one of the AGS 4.x defined codes.";
  readonly default_severity = Severity.Warning;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    for (const [groupName, group] of Object.entries(file.groups)) {
      for (const heading of group.headings) {
        if (!isValidAgsType(heading.data_type)) {
          diagnostics.push(
            new DiagnosticBuilder(
              this.id,
              this.default_severity,
              `${groupName}.${heading.name} carries an unrecognised TYPE code: ${AgsTypeFunctions.toString(heading.data_type)}`
            )
              .atGroup(groupName)
              .build()
          );
        }
      }
    }
  }
}

// ── AGS-VAL-001: GEOL_BASE must be greater than GEOL_TOP ─────────────────────

export class GeolBaseTopRule implements Rule {
  readonly id = "AGS-VAL-001";
  readonly description = "GEOL_BASE must be greater than GEOL_TOP for every layer.";
  readonly default_severity = Severity.Error;

  check(file: AgsFile, diagnostics: Diagnostic[]): void {
    const geol = file.groups["GEOL"];
    if (!geol) return;
    for (const row of geol.rows) {
      const top = row["GEOL_TOP"];
      const base = row["GEOL_BASE"];
      if (top === null || top === undefined || base === null || base === undefined) continue;
      const topN = typeof top === "number" ? top : parseFloat(String(top));
      const baseN = typeof base === "number" ? base : parseFloat(String(base));
      if (!isNaN(topN) && !isNaN(baseN) && baseN <= topN) {
        diagnostics.push(
          new DiagnosticBuilder(
            this.id,
            this.default_severity,
            `GEOL row has GEOL_BASE (${baseN}) not greater than GEOL_TOP (${topN})`
          )
            .atGroup("GEOL")
            .build()
        );
      }
    }
  }
}

export function standardRules(): Rule[] {
  return [
    // Built-in Rust-equivalent rules (matched to Rust standard_rules() order)
    new DictRequiredHeadingsRule(),
    new DictDepthUnitsRule(),
    new TypeValueRule(),
    new AbbrCodelistRule(),
    new UnitCodelistRule(),
    new XrefLocaRule(),
    new IdColumnUniquenessRule(),
    new SampCompositeKeyRule(),
    new RequiredNonEmptyRule(),
    new HeadingNameFormatRule(),
    new EmptyGroupRule(),
    new NonStandardHeadingRule(),
    new HeadingOrderRule(),
    new CompositeKeyRule(),
    new ParentGroupXrefRule(),
    new TranDlimRule(),
    new RlXrefRule(),
    new TypeGroupCoverageRule(),
    // DSL-pack rules implemented as built-in TS rules (Milestone 3 not yet done)
    new ProjGroupRule(),
    new TranGroupRule(),
    new LocaIdRule(),
    new HeadingRowPresentRule(),
    new NumericHeadingsUnitRule(),
    new HeadingTypeDeclaredRule(),
    new ValidAgsTypeCodeRule(),
    new GeolBaseTopRule(),
    new GeolMonotonicityRule(),
    new TranAgsVersionRule(),
    new TrailingWhitespaceRule(),
    // Extra TS rule (no Rust equivalent, tracked separately)
    new MissingDictDefinitionsRule(),
  ];
}

export function hasNonStandardHeadings(file: AgsFile): boolean {
  const dict = currentDict();
  for (const [groupName, group] of Object.entries(file.groups)) {
    const definition = dict[groupName];
    if (!definition) {
      return true;
    }
    const standard = new Set(definition.heading_order);
    for (const heading of group.headings) {
      if (!standard.has(heading.name)) {
        return true;
      }
    }
  }
  return false;
}
