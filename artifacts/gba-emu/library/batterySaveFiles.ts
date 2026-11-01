import { Platform, Share } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import { base64ToBytes, bytesToBase64 } from './romArtwork';
import { decodeBatteryFile, encodeBatteryFile } from './batterySaveCodec.mjs';

const MAX_SAVE_BYTES = 256 * 1024;

export async function pickBatterySave(): Promise<{ json: string; name: string } | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || !result.assets?.[0]) return null;
  const asset = result.assets[0];
  let bytes: Uint8Array;
  if (Platform.OS === 'web') {
    if (!asset.file) throw new Error('The browser did not provide the selected file.');
    if (asset.file.size <= 0 || asset.file.size > MAX_SAVE_BYTES) throw new Error('Choose a save file up to 256 KB.');
    bytes = new Uint8Array(await asset.file.arrayBuffer());
  } else {
    const info = await FileSystem.getInfoAsync(asset.uri);
    if (!info.exists || !info.size || info.size > MAX_SAVE_BYTES) throw new Error('Choose a save file up to 256 KB.');
    bytes = base64ToBytes(await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 }));
  }
  return { json: decodeBatteryFile(bytes), name: asset.name };
}

export async function exportBatterySave(name: string, json: string): Promise<boolean> {
  const bytes = encodeBatteryFile(json);
  const safeName = name.replace(/[^a-zA-Z0-9 _-]/g, '_').slice(0, 80).trim() || 'game';
  const filename = `${safeName}.sav`;
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  }
  const base64 = bytesToBase64(bytes);
  if (Platform.OS === 'android') {
    // The native directory picker grants access without broad storage permissions.
    const access = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!access.granted) return false;
    const uri = await FileSystem.StorageAccessFramework.createFileAsync(access.directoryUri, filename, 'application/octet-stream');
    await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 });
    return true;
  }
  if (!FileSystem.cacheDirectory) throw new Error('Export storage is unavailable.');
  const dir = `${FileSystem.cacheDirectory}save_exports/${Date.now()}-${Math.random().toString(36).slice(2)}/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const uri = dir + filename;
  await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 });
  // Keep the cached file available for share extensions that read it asynchronously.
  const result = await Share.share({ url: uri, title: filename });
  return result.action !== Share.dismissedAction;
}