/**
 * Patterns to mask in CLI output to avoid false-positive parity failures
 * due to non-deterministic or environment-specific data.
 */
export const COSMETIC_PATTERNS = [
  // Timestamps: e.g. 2026-05-12T10:00:00Z or 12:00:00
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g,
  /\d{2}:\d{2}:\d{2}/g,

  // Absolute paths — matches Unix (/home/…/geoflow/) and all Windows
  // variants (C:\Users\…\geoflow\, D:\a\geoflow\geoflow\, etc.) using
  // [/\\] so no global backslash-normalisation is needed.
  /(?:[a-zA-Z]:)?[/\\](?:[^/\\\s]+[/\\])*geoflow[/\\]/gi,

  // Version strings: e.g. geoflow 2026.506.0
  /geoflow \d{4}\.\d{1,3}\.\d+/g,

  // File paths in diagnostics often vary by platform (slash vs backslash)
  // or absolute vs relative.
];

/**
 * Applies all cosmetic masking patterns to a string.
 */
export function maskCosmetic(text: string): string {
  // Normalise Windows path separators first so the path patterns (which use
  // [/\\]) reliably match, and so the post-mask remainder uses forward slashes.
  let masked = text.replace(/\\/g, "/");
  for (const pattern of COSMETIC_PATTERNS) {
    masked = masked.replace(pattern, '<MASKED>');
  }
  return masked;
}
