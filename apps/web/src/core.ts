/**
 * Thin wrappers around @geoflow/core for use in the web SPA.
 * Re-exports only what the UI tabs need, with web-friendly types.
 */

export {
  decodeBytes,
  parseStr,
  validateFileBytes,
  fixBytes,
  summarizeInfoBytes,
  renderInfo,
  diffFiles,
  renderDiffText,
  diffToSummary,
  isIdentical,
  serialize,
  writeDiggs,
  readDiggs,
  Format,
  Severity,
} from '@geoflow/core';

export type {
  ParseOutcome,
  ValidateResult,
  FixResult,
  InfoSummary,
  DiffResult,
  AgsFile,
  AgsGroup,
  AgsRow,
  AgsValue,
  ConversionReport,
} from '@geoflow/core';
