export function indexFromOffset(x: number, itemW: number, count: number): number {
  'worklet';
  if (count <= 0 || itemW <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(x / itemW)));
}

/** Stable selection by id across imports, removals and reloads. */
export function resolveSelection(
  ids: string[],
  prevIds: string[] | null,
  currentId: string | null,
  lastIndex: number,
): string | null {
  if (ids.length === 0) return null;
  if (prevIds && prevIds.length > 0) {
    const added = ids.find((id) => !prevIds.includes(id));
    if (added) return added;
  }
  if (currentId && ids.includes(currentId)) return currentId;
  return ids[Math.min(Math.max(lastIndex, 0), ids.length - 1)];
}
