import type { SaveState } from '@/lib/db';

function sameBuffer(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.every((value, index) => value === b[index]);
}

export type StateRecoveryChoice =
  | { kind: 'browser'; state: SaveState | null }
  | { kind: 'linked'; state: SaveState | null }
  | { kind: 'prompt' }
  | { kind: 'unavailable' };

// This pure decision is shared by the play route and tests. Crucially, an
// explicit browser-recovery choice never attempts a denied folder read.
export function chooseStateRecovery(
  browserState: SaveState | null,
  linkedState: SaveState | null,
  folderWasReadable: boolean,
  useBrowserRecovery: boolean,
): StateRecoveryChoice {
  if (useBrowserRecovery) return { kind: 'browser', state: browserState };
  if (!folderWasReadable) return browserState ? { kind: 'prompt' } : { kind: 'unavailable' };
  if (browserState && linkedState && !sameBuffer(browserState.data, linkedState.data)) return { kind: 'prompt' };
  return { kind: 'linked', state: linkedState ?? browserState };
}