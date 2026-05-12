// @geoflow/rules — bundled YAML rule packs (data-only).
// Real packs are migrated from rules/specs/ in Milestone 3.
export const PACKAGE_NAME = "@geoflow/rules";

export interface PackRef {
  registry: string;
  pack: string;
  version: string;
}
