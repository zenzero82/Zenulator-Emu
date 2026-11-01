// User-facing core release label, shared by Settings and debug/GPU reports.
// Change CORE_VERSION only when the user is ready for a new store release.
// For delivered updates within that release, increment CORE_REVISION manually.
// Reset the revision to 0 when starting a new release. Do not tie either value
// to dates, native build numbers, app startup, or individual development edits.
export const CORE_VERSION = '1.0';
export const CORE_REVISION = 0;

export function formatCoreTag(version: string, revision: number): string {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('Invalid core version');
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid core revision');
  return `Version ${version}${revision > 0 ? ` (${revision})` : ''}`;
}

export const BUILD_TAG = formatCoreTag(CORE_VERSION, CORE_REVISION);
