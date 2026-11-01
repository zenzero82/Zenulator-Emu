import React, { useCallback, useEffect, useRef, useState } from 'react';
import LibraryScenery from '@/components/LibraryScenery';
import {
  Alert,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useRomLibrary, type RomEntry } from '@/context/RomLibraryContext';
import RomCarousel from '@/components/RomCarousel';
import { library, pillReserve } from '@/constants/libraryTheme';
import { resolveSelection } from '@/library/carouselSelection';
import { LinearGradient } from 'expo-linear-gradient';
import SaveTransferSheet from '@/components/SaveTransferSheet';
import RenameGameSheet from '@/components/RenameGameSheet';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { useRomImport } from '@/hooks/useRomImport';
import { useRouter } from 'expo-router';
import {
  bytesToBase64,
  type ZipArtwork,
} from '@/library/romArtwork';

interface ArtworkChoice {
  candidate: ZipArtwork;
  previewUri: string;
}

export default function LibraryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    roms,
    ready,
    loadError,
    removeRom,
    setArtwork,
    removeArtwork,
    setActiveRomId,
  } = useRomLibrary();
  const [saveTransferRom, setSaveTransferRom] = useState<RomEntry | null>(null);
  const [renameRom, setRenameRom] = useState<RomEntry | null>(null);
  const [artworkLoadingId, setArtworkLoadingId] = useState<string | null>(null);
  const [artworkChoice, setArtworkChoice] = useState<{
    choices: ArtworkChoice[];
    hasExistingArtwork: boolean;
    resolve: (choice?: ZipArtwork) => void;
  } | null>(null);
  const artworkChoiceRef = useRef(artworkChoice);
  artworkChoiceRef.current = artworkChoice;
  useEffect(() => () => { artworkChoiceRef.current?.resolve(undefined); }, []);

  const chooseBundledArtwork = useCallback((
    candidates: ZipArtwork[],
    hasExistingArtwork: boolean,
  ): Promise<ZipArtwork | undefined> => {
    if (Platform.OS === 'web' || candidates.length === 0) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      setArtworkChoice({
        choices: candidates.map((candidate) => ({
          candidate,
          previewUri: `data:${candidate.info.mimeType};base64,${bytesToBase64(candidate.bytes)}`,
        })),
        hasExistingArtwork,
        resolve,
      });
    });
  }, []);

  const resolveArtworkChoice = useCallback((choice?: ZipArtwork) => {
    const pending = artworkChoice;
    setArtworkChoice(null);
    pending?.resolve(choice);
  }, [artworkChoice]);

  const importer = useRomImport(chooseBundledArtwork);
  const loading = importer.busy;
  const pickRom = importer.pickFiles;

  const handlePlay = useCallback(async (rom: RomEntry) => {
    setActiveRomId(rom.id);
    router.push({ pathname: '/emulator', params: { romId: rom.id } });
  }, [setActiveRomId, router]);

  const pickArtwork = useCallback(async (rom: RomEntry) => {
    if (Platform.OS === 'web') {
      Alert.alert('Artwork unavailable', 'Custom ROM artwork is available on iOS and Android.');
      return;
    }
    try {
      setArtworkLoadingId(rom.id);
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      await setArtwork(rom.id, {
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType,
        size: asset.size,
      });
    } catch (error) {
      Alert.alert('Artwork not saved', String(error));
    } finally {
      setArtworkLoadingId(null);
    }
  }, [setArtwork]);

  const handleRemoveArtwork = useCallback((rom: RomEntry) => {
    Alert.alert(
      'Remove artwork',
      `Remove the custom cover for "${rom.name}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => removeArtwork(rom.id).catch((error) => {
            Alert.alert('Artwork not removed', String(error));
          }),
        },
      ],
    );
  }, [removeArtwork]);

  const handleDelete = useCallback((rom: RomEntry) => {
    Alert.alert(
      'Remove ROM',
      `Remove "${rom.name}" and its local saves from your library? Export its in-game save first if you want to use it with an updated ROM.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => removeRom(rom.id),
        },
      ]
    );
  }, [removeRom]);

  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const lastIndex = useRef(0);
  const prevIds = useRef<string[] | null>(null);

  useEffect(() => {
    const prev = prevIds.current;
    const ids = roms.map((r) => r.id);
    prevIds.current = ids;
    setSelectedId((cur) => resolveSelection(ids, prev, cur, lastIndex.current));
  }, [roms]);

  const found = roms.findIndex((r) => r.id === selectedId);
  const selectedIndex = found >= 0 ? found : Math.min(lastIndex.current, Math.max(0, roms.length - 1));
  if (found >= 0) lastIndex.current = found;
  const selected: RomEntry | undefined = roms[selectedIndex];

  const onSelectIndex = useCallback((i: number) => {
    const rom = roms[i];
    if (rom) setSelectedId(rom.id);
  }, [roms]);

  const bottomPad = pillReserve(insets.bottom) + 20;
  const sideInset = Math.max(insets.left, insets.right);
  const contentW = width - sideInset * 2;
  const cover = Math.round(Math.max(150, Math.min(contentW * 0.62, landscape ? 230 : height * 0.36, 340)));
  const mb = selected ? selected.size / 1048576 : 0;
  const saves = selected?.saveStates?.length ?? 0;
  const description = selected
    ? [
        selected.lastPlayed
          ? `Last played ${new Date(selected.lastPlayed).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
          : 'Never played',
        `Added ${new Date(selected.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`,
        saves > 0 ? `${saves} save state${saves > 1 ? 's' : ''}` : null,
      ].filter(Boolean).join('  ·  ')
    : '';
  const dotsTotal = Math.min(roms.length, 7);
  const dotStart = Math.max(0, Math.min(selectedIndex - 3, roms.length - dotsTotal));

  return (
    <View style={[styles.container, { backgroundColor: library.bg }]}>
      <LinearGradient
        colors={library.gradient}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <LibraryScenery />
      <ScrollView
        style={{ flex: 1, minHeight: 0, ...(Platform.OS === 'web' ? { touchAction: 'auto' as const } : {}) }}
        contentContainerStyle={{ width, paddingBottom: bottomPad, paddingLeft: sideInset, paddingRight: sideInset, flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
        testID="library-scroll"
      >
        <View style={[styles.header, { paddingTop: topPad + 12 }]}>
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.headerTitle} accessibilityRole="header">Library</Text>
            <Text style={styles.headerSub}>
              {roms.length} game{roms.length !== 1 ? 's' : ''} · Up to 64MB supported
            </Text>
          </View>
          <Pressable
            onPress={pickRom}
            disabled={loading || !ready}
            testID="import-rom"
            accessibilityRole="button"
            accessibilityLabel="Import ROM files"
            style={({ pressed }) => [styles.importBtn, { opacity: pressed || loading ? 0.7 : 1 }]}
          >
            <Ionicons name={loading ? 'hourglass-outline' : 'add'} size={22} color={library.onAccent} />
            <Text style={styles.importBtnText}>{loading ? 'Loading…' : 'Import'}</Text>
          </Pressable>
        </View>

        <View style={{ paddingHorizontal: 24, gap: 10 }}>
          <Text style={{ color: library.sheetAction, fontSize: 12 }}>
            Select multiple ROMs or ZIPs. Include matching cover images to add them automatically.
          </Text>
          {Platform.OS === 'android' ? (
            <Pressable
              accessibilityRole="button" accessibilityLabel="Import ROM folder"
              testID="import-rom-folder" disabled={loading || !ready}
              onPress={importer.pickFolder} style={styles.importBtn}
            >
              <Ionicons name="folder-open-outline" size={18} color={library.onAccent} />
              <Text style={styles.importBtnText}>Import folder</Text>
            </Pressable>
          ) : null}
          {loadError ? <Text accessibilityRole="alert" style={{ color: library.danger }}>{loadError}</Text> : null}
          {importer.progress ? (
            <View accessibilityLiveRegion="polite" style={{ gap: 8 }}>
              <Text style={{ color: library.onAccent }}>{importer.progress}</Text>
              <Pressable accessibilityRole="button" onPress={importer.cancel}>
                <Text style={{ color: library.accentBright }}>Cancel after current file</Text>
              </Pressable>
            </View>
          ) : null}
          {importer.error ? <Text accessibilityRole="alert" style={{ color: library.danger }}>{importer.error}</Text> : null}
          {importer.summary ? (
            <View accessibilityLiveRegion="polite" style={{ gap: 8 }}>
              <Text testID="import-summary" style={{ color: library.onAccent }}>
                {importer.summary.cancelled ? 'Import cancelled · ' : ''}
                {importer.summary.imported} imported · {importer.summary.duplicates} duplicates kept · {importer.summary.skipped} unsupported · {importer.summary.failed.length} failed
              </Text>
              {importer.summary.failed.slice(0, 20).map((failure, index) => (
                <Text key={index} selectable style={{ color: library.danger }}>{failure.name}: {failure.message}</Text>
              ))}
              {importer.summary.warnings.slice(0, 20).map((warning, index) => (
                <Text key={index} selectable style={{ color: library.sheetAction }}>{warning}</Text>
              ))}
              <Pressable accessibilityRole="button" accessibilityLabel="Dismiss import results" onPress={importer.dismiss}>
                <Text style={{ color: library.accentBright }}>Dismiss</Text>
              </Pressable>
            </View>
          ) : null}
        </View>

        {roms.length === 0 || !selected ? (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <Ionicons name="game-controller-outline" size={40} color={library.accentBright} />
            </View>
            <Text style={styles.emptyTitle}>No ROMs yet</Text>
            <Text style={styles.emptyText}>
              Import your GBA game files to get started.{'\n'}Supports ROMs up to 64MB.
            </Text>
            <Pressable onPress={pickRom} disabled={loading || !ready} testID="browse-files" accessibilityRole="button" accessibilityLabel="Browse files" style={styles.emptyBtn}>
              <Ionicons name="folder-open-outline" size={18} color={library.onAccent} />
              <Text style={styles.emptyBtnText}>Browse Files</Text>
            </Pressable>
          </View>
        ) : (
          <View style={[styles.stage, { width: contentW }]}>
            <RomCarousel
              roms={roms}
              selectedIndex={selectedIndex}
              width={contentW}
              cover={cover}
              onSelectIndex={onSelectIndex}
            />
            <View style={styles.dots} accessibilityLabel={`Game ${selectedIndex + 1} of ${roms.length}`}>
              {Array.from({ length: dotsTotal }, (_, i) => dotStart + i).map((i) => (
                <View key={i} style={[styles.dot, i === selectedIndex && styles.dotOn]} />
              ))}
            </View>
            <Text style={styles.title} numberOfLines={2} testID="selected-title">{selected.name}</Text>
            <Text style={styles.meta}>{mb.toFixed(1)} MB   |   GBA{selected.is64MB ? '   |   64MB' : ''}</Text>
            <Text style={styles.desc}>{description}</Text>
            <View style={styles.actions}>
              <Pressable
                disabled={loading}
                onPress={() => handlePlay(selected)}
                testID="play-selected"
                accessibilityRole="button"
                accessibilityLabel={`Play ${selected.name}`}
                style={({ pressed }) => [styles.playBtn, { opacity: pressed ? 0.85 : 1 }]}
              >
                <Ionicons name="play" size={24} color={library.onAccent} />
                <Text style={styles.playText}>Play</Text>
              </Pressable>
              <Pressable
                disabled={loading}
                onPress={() => setOptionsOpen(true)}
                testID="game-options"
                accessibilityRole="button"
                accessibilityLabel={`Game options for ${selected.name}`}
                style={({ pressed }) => [styles.moreBtn, { opacity: pressed ? 0.7 : 1 }]}
              >
                <Ionicons name="ellipsis-horizontal" size={24} color={library.onAccent} />
              </Pressable>
            </View>
          </View>
        )}
      </ScrollView>

      <Modal visible={optionsOpen && !!selected} transparent animationType="fade" onRequestClose={() => setOptionsOpen(false)} accessibilityViewIsModal>
        <Pressable style={styles.choiceBackdrop} onPress={() => setOptionsOpen(false)} accessibilityLabel="Close options">
          <Pressable style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) + 12 }]} onPress={() => {}}>
            <Text style={styles.sheetTitle} numberOfLines={1}>{selected?.name}</Text>
            {selected && [
              { k: 'rename', icon: 'pencil-outline' as const, label: 'Rename game', run: () => setRenameRom(selected) },
              { k: 'saves', icon: 'save-outline' as const, label: 'Manage saves', run: () => setSaveTransferRom(selected) },
              { k: 'art', icon: 'image-outline' as const, label: selected.artworkPath ? 'Replace artwork' : 'Add artwork', run: () => pickArtwork(selected) },
              ...(selected.artworkPath ? [{ k: 'rmart', icon: 'close-circle-outline' as const, label: 'Remove artwork', run: () => handleRemoveArtwork(selected) }] : []),
              { k: 'del', icon: 'trash-outline' as const, label: 'Remove from library', run: () => handleDelete(selected), danger: true },
            ].map((a) => (
              <Pressable
                key={a.k}
                testID={`option-${a.k}`}
                accessibilityRole="button"
                accessibilityLabel={`${a.label} for ${selected.name}`}
                disabled={a.k.includes('art') && artworkLoadingId === selected.id}
                onPress={() => { setOptionsOpen(false); setTimeout(a.run, 250); }}
                style={({ pressed }) => [styles.sheetRow, { opacity: pressed ? 0.6 : 1 }]}
              >
                <Ionicons name={a.icon} size={22} color={'danger' in a && a.danger ? library.danger : library.sheetAction} />
                <Text style={[styles.sheetText, 'danger' in a && a.danger ? { color: library.danger } : null]}>{a.label}</Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
      {saveTransferRom && <SaveTransferSheet key={saveTransferRom.id} rom={saveTransferRom} onClose={() => setSaveTransferRom(null)} />}
      {renameRom && <RenameGameSheet key={renameRom.id} rom={renameRom} onClose={() => setRenameRom(null)} />}
      <Modal
        visible={!!artworkChoice}
        transparent
        animationType="slide"
        onRequestClose={() => resolveArtworkChoice()}
        accessibilityViewIsModal
      >
        <View style={styles.choiceBackdrop}>
          <View style={[styles.choiceCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.choiceTitle, { color: colors.foreground }]} accessibilityRole="header">
              Choose bundled artwork
            </Text>
            <Text style={[styles.choiceDescription, { color: colors.mutedForeground }]}>
              {artworkChoice?.hasExistingArtwork
                ? 'Select a new cover, or keep your current artwork.'
                : 'Select a cover for this ROM, or skip artwork.'}
            </Text>
            <ScrollView contentContainerStyle={styles.choiceList}>
              {artworkChoice?.choices.map(({ candidate, previewUri }, index) => (
                <Pressable
                  key={`${candidate.entryName}-${index}`}
                  onPress={() => resolveArtworkChoice(candidate)}
                  accessibilityRole="button"
                  accessibilityLabel={`Use bundled artwork ${candidate.entryName}`}
                  style={({ pressed }) => [
                    styles.choiceItem,
                    { borderColor: colors.border, backgroundColor: colors.muted, opacity: pressed ? 0.7 : 1 },
                  ]}
                >
                  <Image source={{ uri: previewUri }} style={styles.choiceImage} resizeMode="cover" />
                  <Text style={[styles.choiceName, { color: colors.foreground }]} numberOfLines={2}>
                    {candidate.entryName}
                  </Text>
                  <Ionicons name="checkmark-circle-outline" size={22} color={colors.primary} />
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              onPress={() => resolveArtworkChoice()}
              accessibilityRole="button"
              accessibilityLabel={artworkChoice?.hasExistingArtwork ? 'Keep current artwork' : 'Skip artwork'}
              style={[styles.choiceCancel, { borderColor: colors.border }]}
            >
              <Text style={[styles.choiceCancelText, { color: colors.foreground }]}>
                {artworkChoice?.hasExistingArtwork ? 'Keep current artwork' : 'Skip artwork'}
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 12, gap: 12,
  },
  headerTitle: { fontSize: 32, fontWeight: '700', letterSpacing: -0.5, color: library.text },
  headerSub: { fontSize: 13, marginTop: 2, color: library.textSoft },
  importBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 18,
    minHeight: 48, borderRadius: 24, backgroundColor: library.accent,
  },
  importBtnText: { color: library.onAccent, fontSize: 15, fontWeight: '600' },
  stage: { alignItems: 'center', paddingTop: 16 },
  dots: { flexDirection: 'row', gap: 8, marginTop: 14, height: 10, alignItems: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: library.dot },
  dotOn: { backgroundColor: library.accentBright, width: 10, height: 10, borderRadius: 5 },
  title: { marginTop: 18, fontSize: 26, fontWeight: '700', color: library.text, textAlign: 'center', paddingHorizontal: 24 },
  meta: { marginTop: 6, fontSize: 14, color: library.textSoft },
  desc: { marginTop: 8, fontSize: 14, lineHeight: 20, color: library.textDim, textAlign: 'center', paddingHorizontal: 32 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 24, paddingHorizontal: 24 },
  playBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    minWidth: 200, flexGrow: 1, maxWidth: 280, height: 62, borderRadius: 31, backgroundColor: library.accent,
  },
  playText: { color: library.onAccent, fontSize: 20, fontWeight: '700' },
  moreBtn: {
    width: 62, height: 62, borderRadius: 31, alignItems: 'center', justifyContent: 'center',
    backgroundColor: library.glass, borderWidth: 1, borderColor: library.glassBorder,
  },
  sheet: {
    backgroundColor: library.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 16, gap: 2, borderWidth: 1, borderColor: library.glass,
  },
  sheetTitle: { color: library.text, fontSize: 16, fontWeight: '700', paddingHorizontal: 8, paddingBottom: 8 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52, paddingHorizontal: 8 },
  sheetText: { color: library.text, fontSize: 16, fontWeight: '500' },
  empty: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, paddingTop: 60, gap: 12 },
  emptyIcon: {
    width: 80, height: 80, borderRadius: 24, alignItems: 'center', justifyContent: 'center',
    marginBottom: 4, backgroundColor: library.accentSoft,
  },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: library.text },
  emptyText: { fontSize: 14, textAlign: 'center', lineHeight: 20, color: library.textSoft },
  emptyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 24, minHeight: 48,
    borderRadius: 24, marginTop: 8, backgroundColor: library.accent,
  },
  emptyBtnText: { color: library.onAccent, fontSize: 15, fontWeight: '600' },
  choiceBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: library.scrim,
  },
  choiceCard: {
    maxHeight: '82%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    gap: 10,
  },
  choiceTitle: {
    fontSize: 20,
    fontWeight: '700',
  },
  choiceDescription: {
    fontSize: 13,
    lineHeight: 19,
  },
  choiceList: {
    gap: 10,
    paddingVertical: 6,
  },
  choiceItem: {
    minHeight: 76,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 8,
  },
  choiceImage: {
    width: 60,
    height: 60,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.12)',
  },
  choiceName: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
  },
  choiceCancel: {
    minHeight: 46,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceCancelText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
