import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import type { RomEntry } from '../context/RomLibraryContext';
import type { ImportAsset } from './importBatch';
import {
  MAX_ARCHIVE_BYTES, MAX_ROM_BYTES, base64ToBytes, bytesToBase64,
  extractZipRomAndArtwork, hashBytes, type ZipArtwork,
} from './romArtwork';

export interface ImportOptions {
  keepExisting?: boolean;
  webBase64?: string;
}
type AddRom = (entry: Omit<RomEntry, 'id' | 'addedAt'>, options?: ImportOptions) => Promise<RomEntry>;

/** Holds at most one ROM/archive in JS, and never sends ROM bytes to a WebView. */
export async function importRomAsset(asset: ImportAsset, addRom: AddRom) {
  const archive = /\.zip$/i.test(asset.name);
  const limit = archive ? MAX_ARCHIVE_BYTES : MAX_ROM_BYTES;
  let romName = asset.name;
  let size = asset.size ?? 0;
  let contentHash = '';
  let base64: string | undefined;
  let artwork: ZipArtwork[] = [];
  let stagedPath: string | undefined;
  let committed = false;
  try {
    if (Platform.OS === 'web') {
      if (size > limit) throw new Error(`File exceeds the ${limit / 1048576} MB limit.`);
      const response = await fetch(asset.uri);
      if (!response.ok) throw new Error('The selected file could not be read.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > limit) throw new Error(`File exceeds the ${limit / 1048576} MB limit.`);
      const extracted = archive ? await extractZipRomAndArtwork(bytes, asset.name) : undefined;
      const romBytes = extracted?.rom ?? bytes;
      if (romBytes.length < 192) throw new Error('The selected file is not a valid GBA ROM.');
      size = romBytes.length;
      base64 = bytesToBase64(romBytes);
      contentHash = hashBytes(romBytes);
      romName = extracted?.romName ?? romName;
      artwork = extracted?.artworkCandidates ?? [];
    } else {
      const directory = `${FileSystem.documentDirectory}gba_roms/`;
      await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      // Copy content:// sources first: metadata/read APIs vary between providers.
      stagedPath = `${directory}${id}.${archive ? 'zip.tmp' : 'gba'}`;
      if (size > limit) throw new Error(`File exceeds the ${limit / 1048576} MB limit.`);
      await FileSystem.copyAsync({ from: asset.uri, to: stagedPath });
      const info = await FileSystem.getInfoAsync(stagedPath, { md5: !archive });
      if (!info.exists || !Number.isFinite(info.size) || info.size > limit || info.size < 192) {
        throw new Error(`Invalid or oversized file (maximum ${limit / 1048576} MB).`);
      }
      size = info.size;
      if (archive) {
        const encoded = await FileSystem.readAsStringAsync(stagedPath, { encoding: FileSystem.EncodingType.Base64 });
        const extracted = await extractZipRomAndArtwork(base64ToBytes(encoded), asset.name);
        // The extracted ROM is staged independently; commit its manifest last.
        const romPath = `${directory}${id}.gba`;
        try {
          await FileSystem.writeAsStringAsync(romPath, bytesToBase64(extracted.rom), { encoding: FileSystem.EncodingType.Base64 });
        } catch (error) {
          await FileSystem.deleteAsync(romPath, { idempotent: true }).catch(() => {});
          throw error;
        }
        await FileSystem.deleteAsync(stagedPath, { idempotent: true });
        stagedPath = romPath;
        size = extracted.rom.length;
        contentHash = hashBytes(extracted.rom);
        romName = extracted.romName;
        artwork = extracted.artworkCandidates;
      } else {
        contentHash = info.md5?.toLowerCase() ?? '';
        if (!contentHash) {
          const encoded = await FileSystem.readAsStringAsync(stagedPath, { encoding: FileSystem.EncodingType.Base64 });
          contentHash = hashBytes(base64ToBytes(encoded));
        }
      }
    }
    const entry = await addRom({
      name: romName.replace(/\.(gba|agb|bin)$/i, ''),
      fileName: romName, size, is64MB: size > 33554432,
      filePath: stagedPath, contentHash, saveStates: [],
    }, { keepExisting: true, webBase64: base64 });
    // A duplicate returns its existing entry unchanged, including its save/artwork.
    if (stagedPath && entry.filePath !== stagedPath) {
      await FileSystem.deleteAsync(stagedPath, { idempotent: true });
      stagedPath = undefined;
    }
    committed = true;
    return { entry, artwork, romName };
  } finally {
    if (!committed && stagedPath) {
      await FileSystem.deleteAsync(stagedPath, { idempotent: true }).catch(() => {});
    }
  }
}
