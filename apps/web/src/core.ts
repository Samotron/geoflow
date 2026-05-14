/**
 * Thin wrappers around @geoflow/core for use in the web SPA.
 * Re-exports only what the UI tabs need, with web-friendly types.
 */

export {
  decodeBytes,
  parseStr,
  validate,
  Registry,
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
  assessQuality,
  AgsTypeFunctions,
  Format,
  Severity,
} from '@geoflow/core';

export type {
  ParseOutcome,
  ValidateResult,
  FixResult,
  InfoSummary,
  DiffResult,
  GroupDiff,
  AgsFile,
  AgsGroup,
  AgsHeading,
  AgsRow,
  AgsValue,
  AgsType,
  ConversionReport,
  Diagnostic,
  QualityReport,
  QualityDimension,
} from '@geoflow/core';
