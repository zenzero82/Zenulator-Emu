/** Small, platform-independent rules shared by the native picker and tests. */
export interface ImportAsset {
  uri: string;
  name: string;
  size?: number;
}
export interface ImportSummary {
  imported: number;
  duplicates: number;
  skipped: number;
  failed: { name: string; message: string }[];
  warnings: string[];
  cancelled: boolean;
}
export const isRomAsset = (name: string) => /\.(gba|agb|bin|zip)$/i.test(name);
export const isArtworkAsset = (name: string) => /\.(png|jpe?g|webp|gif)$/i.test(name);

export function documentName(uri: string): string {
  // SAF providers percent-encode the entire document ID, including slashes.
  let decoded = uri;
  try { decoded = decodeURIComponent(uri); } catch { /* retain malformed name for reporting */ }
  return decoded.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop()?.replace(/^.*:/, '') || 'Unnamed document';
}

function stem(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase();
}

export function companionArtwork(romName: string, assets: ImportAsset[]): ImportAsset[] {
  const name = stem(romName);
  return assets.filter((asset) => {
    if (!isArtworkAsset(asset.name)) return false;
    const image = stem(asset.name);
    return image === name || image === `${name}.cover` || image === `${name}-cover` ||
      image === `${name}_cover` || image === `${name} cover`;
  });
}

export async function runImportBatch(
  assets: ImportAsset[],
  importOne: (asset: ImportAsset) => Promise<'imported' | 'duplicate'>,
  cancelled: () => boolean,
  progress: (completed: number, total: number, name: string) => void,
): Promise<ImportSummary> {
  const roms = assets.filter((asset) => isRomAsset(asset.name));
  const summary: ImportSummary = {
    imported: 0, duplicates: 0,
    skipped: assets.filter((a) => !isRomAsset(a.name) && !isArtworkAsset(a.name)).length,
    failed: [], warnings: [], cancelled: false,
  };
  for (let index = 0; index < roms.length; index++) {
    if (cancelled()) { summary.cancelled = true; break; }
    const asset = roms[index];
    progress(index, roms.length, asset.name);
    // Yield before each file, so the progress/cancel controls can render.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (cancelled()) { summary.cancelled = true; break; }
    try {
      const result = await importOne(asset);
      if (result === 'duplicate') summary.duplicates++;
      else summary.imported++;
    } catch (error) {
      summary.failed.push({ name: asset.name, message: error instanceof Error ? error.message : String(error) });
    }
    progress(index + 1, roms.length, asset.name);
  }
  summary.cancelled ||= cancelled();
  return summary;
}
