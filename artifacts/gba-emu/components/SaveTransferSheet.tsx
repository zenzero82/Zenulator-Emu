import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import type { RomEntry } from '@/context/RomLibraryContext';
import { exportBatterySave, pickBatterySave } from '@/library/batterySaveFiles';
import { hasPreImportSave, importBatterySave, readBatterySave, restorePreImportSave } from '@/library/batterySaveStorage';

interface Props { rom: RomEntry; onClose: () => void }

export default function SaveTransferSheet({ rom, onClose }: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(true);
  const [hasSave, setHasSave] = useState(false);
  const [hasBackup, setHasBackup] = useState(false);
  const [pending, setPending] = useState<{ json: string; name: string } | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function refresh() {
    setHasSave(!!(await readBatterySave(rom.id)));
    setHasBackup(await hasPreImportSave(rom.id));
  }
  useEffect(() => {
    let active = true;
    Promise.all([readBatterySave(rom.id), hasPreImportSave(rom.id)]).then(([save, backup]) => {
      if (active) { setHasSave(!!save); setHasBackup(backup); }
    }).catch((e: unknown) => {
      if (active) setError(e instanceof Error ? e.message : String(e));
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [rom.id]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const button = (label: string, icon: React.ComponentProps<typeof Ionicons>['name'], action: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button" accessibilityLabel={label} testID={label.toLowerCase().replace(/ /g, '-')}
      disabled={busy || disabled} onPress={action}
      style={[styles.button, { backgroundColor: colors.secondary, borderColor: colors.border, opacity: busy || disabled ? 0.45 : 1 }]}
    >
      <Ionicons name={icon} size={19} color={colors.foreground} />
      <Text style={[styles.buttonText, { color: colors.foreground }]}>{label}</Text>
    </Pressable>
  );

  return (
    <Modal visible transparent animationType="slide" onRequestClose={() => { if (!busy) onClose(); }}>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border, paddingBottom: Math.max(insets.bottom, 20), marginTop: insets.top + (Platform.OS === 'web' ? 67 : 16) }]}>
          <View style={styles.header}>
            <View style={styles.heading}>
              <Text accessibilityRole="header" style={[styles.title, { color: colors.foreground }]}>Game save</Text>
              <Text numberOfLines={2} style={{ color: colors.mutedForeground }}>{rom.name}</Text>
            </View>
            <Pressable disabled={busy} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close save transfer" style={styles.close}>
              <Ionicons name="close" size={24} color={colors.foreground} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={[styles.body, { color: colors.mutedForeground }]}>
              Save inside the game, then return to the Library. Export a .sav file before removing an old ROM. Import it into the updated ROM to continue.
            </Text>
            <Text style={[styles.body, { color: colors.mutedForeground }]}>
              This transfers in-game progress, not quick-save states. The new ROM must support the old save format; some hack updates are incompatible.
            </Text>
            {busy && <ActivityIndicator color={colors.primary} />}
            {!!error && <Text accessibilityRole="alert" style={[styles.body, { color: colors.destructive }]}>{error}</Text>}
            {!!message && <Text accessibilityLiveRegion="polite" style={[styles.body, { color: colors.accent }]}>{message}</Text>}
            {pending ? (
              <>
                <Text style={[styles.body, { color: colors.foreground }]}>
                  Import "{pending.name}" into "{rom.name}"? {hasSave ? 'This replaces its current in-game progress. A copy of the current save will be kept for recovery.' : 'The game will use this save the next time you play.'}
                </Text>
                {button('Confirm import', 'download-outline', () => void run(async () => {
                  await importBatterySave(rom.id, pending.json);
                  setPending(null);
                  await refresh();
                  setMessage('Save imported. Open the game and choose Continue. Do not load an old quick-save state.');
                }))}
                {button('Cancel import', 'close-outline', () => setPending(null))}
              </>
            ) : confirmRestore ? (
              <>
                <Text style={[styles.body, { color: colors.foreground }]}>Restore the save from before your last import? This replaces the current in-game progress.</Text>
                {button('Confirm restore', 'refresh-outline', () => void run(async () => {
                  if (!(await restorePreImportSave(rom.id))) throw new Error('No pre-import save is available.');
                  setConfirmRestore(false);
                  await refresh();
                  setMessage('Previous save restored.');
                }))}
                {button('Cancel restore', 'close-outline', () => setConfirmRestore(false))}
              </>
            ) : (
              <>
                {!busy && !hasSave && <Text style={[styles.body, { color: colors.mutedForeground }]}>No in-game save to export yet. You can still import one.</Text>}
                {button('Export save', 'share-outline', () => void run(async () => {
                  const json = await readBatterySave(rom.id);
                  if (!json) throw new Error('No save found. Save inside the game first.');
                  if (await exportBatterySave(rom.name, json)) setMessage(Platform.OS === 'ios' ? 'Save shared. Keep the exported file before deleting the old ROM.' : 'Save exported. Keep the file before deleting the old ROM.');
                }), !hasSave)}
                {button('Import save', 'download-outline', () => void run(async () => {
                  const file = await pickBatterySave();
                  if (file) setPending(file);
                }))}
                {hasBackup && button('Restore previous save', 'refresh-outline', () => setConfirmRestore(true))}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'flex-end', alignItems: 'center' },
  sheet: { width: '100%', maxWidth: 540, maxHeight: '90%', borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, padding: 20 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 12 },
  heading: { flex: 1, gap: 5 },
  title: { fontSize: 22, fontWeight: '700' },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  content: { gap: 14, paddingBottom: 12 },
  body: { fontSize: 14, lineHeight: 21 },
  button: { minHeight: 48, flexDirection: 'row', gap: 10, borderRadius: 12, borderWidth: 1, paddingHorizontal: 16, alignItems: 'center' },
  buttonText: { fontSize: 15, fontWeight: '600' },
});