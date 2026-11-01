export const SAVE_STATE_BUFFER_LENGTHS: Record<string, number> = {
  wram: 0x40000,
  iwram: 0x8000,
  io: 0x400,
  pal: 0x400,
  vram: 0x18000,
  oam: 0x400,
  sram: 0x20000,
  eeprom: 0x2000,
};

export function base64ByteLength(value: string): number {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return -1;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export function validateBatterySave(value: string): void {
  let save: unknown;
  try { save = JSON.parse(value); } catch { throw new Error('This backup contains an invalid battery save.'); }
  if (!save || typeof save !== 'object') throw new Error('This backup contains an invalid battery save.');
  const data = save as Record<string, unknown>;
  const allowedTypes = new Set(['sram', 'eeprom', 'flash64', 'flash128']);
  if (
    data.v !== 1 || typeof data.saveType !== 'string' || !allowedTypes.has(data.saveType) ||
    !Number.isInteger(data.len) || Number(data.len) < 0 || Number(data.len) > 0x20000 ||
    !Number.isInteger(data.checksum) || Number(data.checksum) < 0 ||
    typeof data.data !== 'string' || base64ByteLength(data.data) !== data.len
  ) throw new Error('This backup contains an invalid battery save.');
  const bytes = Uint8Array.from(atob(data.data), (character) => character.charCodeAt(0));
  if (bytes.reduce((sum, byte) => (sum + byte) >>> 0, 0) !== data.checksum) {
    throw new Error('The battery save in this backup is corrupted.');
  }
}

export function validateSaveState(value: string): void {
  let state: unknown;
  try { state = JSON.parse(value); } catch { throw new Error('This backup contains an invalid save state.'); }
  if (!state || typeof state !== 'object') throw new Error('This backup contains an invalid save state.');
  const data = state as Record<string, unknown>;
  if (
    !Array.isArray(data.r) || data.r.length !== 16 || !data.r.every(Number.isFinite) ||
    !Number.isFinite(data.cpsr) || !Number.isFinite(data.scanline) || !Number.isFinite(data.scanlineCycles)
  ) throw new Error('This backup contains an invalid save state.');
  for (const [name, byteLength] of Object.entries(SAVE_STATE_BUFFER_LENGTHS)) {
    if (typeof data[name] !== 'string' || base64ByteLength(data[name]) !== byteLength) {
      throw new Error('This backup contains an invalid save state.');
    }
  }
}