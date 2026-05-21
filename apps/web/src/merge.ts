/**
 * Re-export of @geoflow/core merge for the web app. The conflict-resolver
 * UI is in components/ConflictResolver.tsx; the merge logic itself is
 * shared with the CLI.
 */

export { mergeAgsFiles, mergeAgsFilesN, applyConflictResolutions } from '@geoflow/core';
export type { MergeConflict, MergeResult } from '@geoflow/core';
