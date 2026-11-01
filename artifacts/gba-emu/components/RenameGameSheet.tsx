import React, { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { library } from '@/constants/libraryTheme';
import { useRomLibrary, type RomEntry } from '@/context/RomLibraryContext';

export default function RenameGameSheet({ rom, onClose }: { rom: RomEntry; onClose: () => void }) {
  const { renameRom } = useRomLibrary();
  const [title, setTitle] = useState(rom.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await renameRom(rom.id, title);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The title could not be saved.');
    } finally { setBusy(false); }
  };
  return (
    <Modal transparent animationType="fade" onRequestClose={() => { if (!busy) onClose(); }} accessibilityViewIsModal>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.sheet}>
          <Text style={styles.heading}>Rename game</Text>
          <Text style={styles.help}>Only the library title changes. Your ROM and saves stay linked.</Text>
          <TextInput autoFocus value={title} onChangeText={setTitle} maxLength={120}
            editable={!busy} accessibilityLabel="Game title" placeholder="Game title"
            placeholderTextColor="#999" style={styles.input} returnKeyType="done"
            onSubmitEditing={() => { if (title.trim()) void save(); }} />
          {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
          <View style={styles.actions}>
            <Pressable disabled={busy} onPress={onClose} accessibilityRole="button" style={styles.button}>
              <Text style={styles.text}>Cancel</Text>
            </Pressable>
            <Pressable disabled={busy || !title.trim()} onPress={save} accessibilityRole="button"
              style={[styles.button, { opacity: busy || !title.trim() ? 0.4 : 1 }]}>
              <Text style={styles.text}>{busy ? 'Saving…' : 'Save title'}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: 'rgba(0,0,0,0.75)' },
  sheet: { width: '100%', maxWidth: 440, padding: 24, borderRadius: 22, backgroundColor: '#211b32' },
  heading: { fontSize: 22, fontWeight: '700', color: library.text },
  help: { fontSize: 14, color: library.text, opacity: 0.75, marginTop: 10, marginBottom: 18 },
  input: { borderWidth: 1, borderColor: '#8e72bf', borderRadius: 12, padding: 14, color: library.text, fontSize: 17 },
  error: { color: library.danger, marginTop: 10 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 18 },
  button: { padding: 12 },
  text: { color: library.text, fontWeight: '700', fontSize: 16 },
});
