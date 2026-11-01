import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Directory } from 'expo-file-system';
import { useRomLibrary } from '../context/RomLibraryContext';
import {
  companionArtwork, documentName, runImportBatch, type ImportAsset, type ImportSummary,
} from '../library/importBatch';
import { importRomAsset } from '../library/importRomAsset';
import {
  base64ToBytes, bytesToBase64, validateArtworkBytes, MAX_ARTWORK_BYTES, type ZipArtwork,
} from '../library/romArtwork';

export function useRomImport(chooseArtwork: (candidates: ZipArtwork[], existing: boolean) => Promise<ZipArtwork | undefined>) {
  const { roms, ready, addRom, setArtworkFromBase64 } = useRomLibrary();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  const running = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);

  const run = useCallback(async (assets: ImportAsset[], scanWarnings: string[] = []) => {
    const known = new Set(roms.map((rom) => rom.id));
    const warnings = [...scanWarnings];
    const result = await runImportBatch(assets, async (asset) => {
      const imported = await importRomAsset(asset, addRom);
      const duplicate = known.has(imported.entry.id);
      known.add(imported.entry.id);
      // Never replace an existing cover merely because a ROM was selected again.
      if (Platform.OS !== 'web' && !imported.entry.artworkPath && !cancelled.current) {
        try {
          let candidates = imported.artwork;
          if (!candidates.length) {
            candidates = [];
            let artworkBytes = 0;
            for (const image of companionArtwork(imported.romName, assets).slice(0, 8)) {
              try {
                if ((image.size ?? 0) > MAX_ARTWORK_BYTES) throw new Error('Image exceeds 8 MB.');
                // Copy SAF content first, and bound reads using the copied metadata.
                const temp = `${FileSystem.cacheDirectory}cover-import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                try {
                  await FileSystem.copyAsync({ from: image.uri, to: temp });
                  const info = await FileSystem.getInfoAsync(temp);
                  if (!info.exists || info.size > MAX_ARTWORK_BYTES || artworkBytes + info.size > MAX_ARTWORK_BYTES * 2) {
                    throw new Error('Artwork exceeds the import memory limit.');
                  }
                  const encoded = await FileSystem.readAsStringAsync(temp, { encoding: FileSystem.EncodingType.Base64 });
                  const bytes = base64ToBytes(encoded);
                  const imageInfo = validateArtworkBytes(bytes);
                  artworkBytes += bytes.length;
                  candidates.push({ bytes, info: imageInfo, entryName: image.name });
                } finally {
                  await FileSystem.deleteAsync(temp, { idempotent: true }).catch(() => {});
                }
              } catch (failure) {
                warnings.push(`${image.name}: ${String(failure)}`);
              }
            }
          }
          const choice = candidates.length === 1 ? candidates[0]
            : candidates.length ? await chooseArtwork(candidates, false) : undefined;
          if (choice && !cancelled.current) {
            await setArtworkFromBase64(imported.entry.id, bytesToBase64(choice.bytes), choice.info.extension);
          }
        } catch (failure) {
          warnings.push(`${asset.name}: imported, but cover was skipped: ${String(failure)}`);
        }
      }
      return duplicate ? 'duplicate' : 'imported';
    }, () => cancelled.current, (done, total, name) => setProgress(`${done}/${total} · ${name}`));
    result.warnings = warnings;
    setSummary(result);
  }, [roms, addRom, chooseArtwork, setArtworkFromBase64]);

  const pick = useCallback(async (folder = false) => {
    if (running.current || !ready) return;
    running.current = true;
    cancelled.current = false;
    setBusy(true);
    setSummary(null);
    setError(null);
    setProgress(folder ? 'Reading selected folder…' : 'Choose ROMs and matching cover images…');
    try {
      if (folder && Platform.OS === 'android') {
        const saf = FileSystem.StorageAccessFramework;
        if (!saf?.requestDirectoryPermissionsAsync) throw new Error('Folder selection is unavailable. Use Import files instead.');
        const permission = await saf.requestDirectoryPermissionsAsync();
        if (!permission.granted || cancelled.current) return;
        const queue = [permission.directoryUri];
        const visited = new Set<string>();
        const assets: ImportAsset[] = [];
        const scanWarnings: string[] = [];
        // Providers can expose virtual/cyclic trees. Bound metadata, depth, and work.
        while (queue.length && !cancelled.current && visited.size < 256 && assets.length < 5000) {
          const directory = queue.shift()!;
          if (visited.has(directory)) continue;
          visited.add(directory);
          try {
            // Legacy getInfoAsync hardcodes isDirectory=false for content://.
            // SDK54's Directory.list uses DocumentFile's actual directory type.
            const children = new Directory(directory).list();
            for (const child of children) {
              if (cancelled.current || assets.length >= 5000) break;
              const uri = child.uri.replace(/\/+$/, '');
              if (child instanceof Directory) queue.push(uri);
              else assets.push({ uri, name: documentName(uri) });
            }
          } catch (failure) {
            scanWarnings.push(`${documentName(directory)}: could not read folder: ${String(failure)}. Try Import files for this location.`);
          }
          setProgress(`Scanning folders · ${assets.length} files found`);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        if (queue.length || assets.length >= 5000) scanWarnings.push('Scan limit reached (256 folders / 5,000 files). Import remaining folders separately.');
        await run(assets, scanWarnings);
      } else {
        const result = await DocumentPicker.getDocumentAsync({
          type: '*/*', copyToCacheDirectory: true, multiple: true,
        });
        if (!result.canceled) await run(result.assets);
      }
    } catch (failure) {
      setError(`${String(failure)}${folder ? ' You can use Import files instead.' : ''}`);
    } finally {
      running.current = false;
      setBusy(false);
      setProgress(null);
    }
  }, [ready, run]);

  return { busy, progress, summary, error, pickFiles: () => pick(false), pickFolder: () => pick(true),
    cancel: () => { cancelled.current = true; setProgress('Cancelling after the current file…'); },
    dismiss: () => { setSummary(null); setError(null); } };
}
