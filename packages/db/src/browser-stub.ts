// Browser-side stub: @geoflow/db is node-only. Importing in the browser is a
// configuration error — surface it loudly rather than dragging in better-sqlite3.
export const PACKAGE_NAME = "@geoflow/db";

export function unavailable(): never {
  throw new Error(
    "@geoflow/db is unavailable in the browser. Use the CLI or a Node runtime.",
  );
}
