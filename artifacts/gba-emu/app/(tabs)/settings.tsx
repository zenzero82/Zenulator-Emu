import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useHapticFeedback } from '@/hooks/useHapticFeedback';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { pillReserve } from '@/constants/libraryTheme';
import { BUILD_TAG } from '@/emulator/buildTag';
import type * as UpdatesModule from 'expo-updates';
import { useRouter } from 'expo-router';
import { useGameplayPreferences } from '@/hooks/useGameplayPreferences';
import { isNativeInputAvailable } from '@/modules/zenulator-input';

interface SettingRowProps {
  icon: React.ReactNode;
  title: string;
  value?: string;
  borderColor: string;
  foreground: string;
  mutedForeground: string;
}

function SettingRow({ icon, title, value, borderColor, foreground, mutedForeground }: SettingRowProps) {
  return (
    <View style={[styles.row, { borderBottomColor: borderColor }]}>
      <View style={styles.rowIcon}>{icon}</View>
      <Text style={[styles.rowTitle, { color: foreground }]}>{title}</Text>
      {value ? <Text style={[styles.rowValue, { color: mutedForeground }]}>{value}</Text> : null}
    </View>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
  cardBg: string;
  border: string;
  muted: string;
}

function Section({ title, children, cardBg, border, muted }: SectionProps) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: muted }]}>{title}</Text>
      <View style={[styles.sectionCard, { backgroundColor: cardBg, borderColor: border }]}>
        {children}
      </View>
    </View>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function SettingsScreen() {
  const colors = useColors();
  const haptics = useHapticFeedback();
  const router = useRouter();
  const gameplay = useGameplayPreferences();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const [updateAction, setUpdateAction] = useState<'idle' | 'checking' | 'downloading' | 'reloading'>('idle');
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [updates, setUpdates] = useState<typeof UpdatesModule | null>(null);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    let cancelled = false;
    // Do not evaluate expo-updates on web: its native event emitter is not
    // available there. The release-native diagnostics still load on demand.
    import('expo-updates')
      .then((module) => {
        if (!cancelled) setUpdates(module);
      })
      .catch((error: unknown) => {
        if (!cancelled) setUpdateMessage(`Updates module unavailable: ${errorMessage(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Updates API calls are intentionally release-native and user initiated.
  // In particular, this screen never reloads while a game is running.
  const canUseUpdates = Platform.OS !== 'web' && !__DEV__ && updates?.isEnabled === true;

  const checkForUpdate = async () => {
    if (!canUseUpdates || !updates) {
      setUpdateMessage('Manual updates are available only in a release native build.');
      return;
    }

    setUpdateAction('checking');
    setUpdateAvailable(false);
    setUpdateMessage(null);
    try {
      const result = await updates.checkForUpdateAsync();
      if (result.isAvailable) {
        setUpdateAvailable(true);
        setUpdateMessage('An update is available. Download it when ready.');
      } else if (result.isRollBackToEmbedded) {
        setUpdateMessage('A rollback to the embedded update is available.');
      } else {
        setUpdateMessage(`No update available (${result.reason}).`);
      }
    } catch (error) {
      setUpdateMessage(`Update check failed: ${errorMessage(error)}`);
    } finally {
      setUpdateAction('idle');
    }
  };

  const downloadUpdate = async () => {
    if (!canUseUpdates || !updates) {
      setUpdateMessage('Manual updates are available only in a release native build.');
      return;
    }

    setUpdateAction('downloading');
    setUpdateMessage(null);
    try {
      const result = await updates.fetchUpdateAsync();
      if (result.isNew) {
        setUpdateMessage('Update downloaded. It will not be applied until you choose to reload.');
        Alert.alert(
          'Update ready',
          'Reload now to apply this update? Do not reload while a game is running.',
          [
            { text: 'Later', style: 'cancel' },
            { text: 'Reload now', onPress: () => void reloadDownloadedUpdate() },
          ],
        );
      } else if (result.isRollBackToEmbedded) {
        setUpdateMessage('Rollback downloaded. Reload only when you are ready.');
        Alert.alert(
          'Rollback ready',
          'Reload now to use the embedded update?',
          [
            { text: 'Later', style: 'cancel' },
            { text: 'Reload now', onPress: () => void reloadDownloadedUpdate() },
          ],
        );
      } else {
        setUpdateMessage('No new update was downloaded.');
      }
      setUpdateAvailable(false);
    } catch (error) {
      setUpdateMessage(`Update download failed: ${errorMessage(error)}`);
    } finally {
      setUpdateAction('idle');
    }
  };

  const confirmDownload = () => {
    Alert.alert(
      'Download update?',
      'The update will be downloaded but will not reload the app until you confirm.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Download', onPress: () => void downloadUpdate() },
      ],
    );
  };

  async function reloadDownloadedUpdate() {
    if (!canUseUpdates || !updates) return;
    setUpdateAction('reloading');
    setUpdateMessage('Reloading with the downloaded update…');
    try {
      await updates.reloadAsync();
    } catch (error) {
      setUpdateAction('idle');
      setUpdateMessage(`Update reload failed: ${errorMessage(error)}`);
    }
  }

  const rowProps = {
    borderColor: colors.border,
    foreground: colors.foreground,
    mutedForeground: colors.mutedForeground,
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 12, borderBottomColor: colors.border }]}>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Settings</Text>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: pillReserve(insets.bottom) + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        <Section title="FEEDBACK" cardBg={colors.card} border={colors.border} muted={colors.mutedForeground}>
          <View style={[styles.row, { borderBottomColor: colors.border }]}>
            <View style={styles.rowIcon}>
              <MaterialCommunityIcons name="vibrate" size={18} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.feedbackTitle, { color: colors.foreground }]}>Haptic Feedback</Text>
              <Text style={[styles.updateHint, { color: colors.mutedForeground }]}>
                Feel a short vibration when pressing controls on supported iOS and Android devices.
              </Text>
            </View>
            <Switch
              testID="haptic-feedback-toggle"
              accessibilityLabel="Haptic Feedback"
              accessibilityHint="Enable or disable vibrations for controls and emulator actions"
              value={haptics.enabled}
              disabled={!haptics.ready || haptics.saving || Platform.OS === 'web'}
              onValueChange={(enabled) => void haptics.setEnabled(enabled).catch(() => {})}
              trackColor={{ false: colors.border, true: colors.primary }}
            />
          </View>
          {haptics.error ? (
            <View>
              <Text accessibilityRole="alert" style={[styles.feedbackMessage, { color: colors.destructive }]}>
                {haptics.error}
              </Text>
              {!haptics.ready ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Retry loading haptic preference"
                  onPress={() => void haptics.retry().catch(() => {})}
                  style={styles.updateButton}
                >
                  <Text style={{ color: colors.primary }}>Retry</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {Platform.OS === 'web' ? (
            <Text style={[styles.feedbackMessage, { color: colors.mutedForeground }]}>
              Haptic feedback is available in the iOS and Android apps.
            </Text>
          ) : null}
        </Section>
        <Section title="EMULATOR" cardBg={colors.card} border={colors.border} muted={colors.mutedForeground}>
          <SettingRow
            icon={<MaterialCommunityIcons name="memory" size={18} color={colors.primary} />}
            title="Max ROM Size"
            value="64 MB"
            {...rowProps}
          />
          <SettingRow
            icon={<Ionicons name="speedometer-outline" size={18} color={colors.primary} />}
            title="Frame Rate Target"
            value="60 FPS"
            {...rowProps}
          />
          <SettingRow
            icon={<Ionicons name="save-outline" size={18} color={colors.primary} />}
            title="Save State Slots"
            value="Per game"
            {...rowProps}
          />
        </Section>

        <Section title="64MB ROM SUPPORT" cardBg={colors.card} border={colors.border} muted={colors.mutedForeground}>
          <View style={[styles.infoCard, { backgroundColor: colors.primary + '15', borderColor: colors.primary + '40' }]}>
            <Ionicons name="information-circle" size={20} color={colors.primary} />
            <Text style={[styles.infoText, { color: colors.foreground }]}>
              Standard GBA hardware supports ROMs up to 32MB (0x08000000–0x09FFFFFF).
              {'\n\n'}
              This emulator extends support to 64MB by mapping the second 32MB bank at
              address 0x0A000000–0x0BFFFFFF instead of mirroring the first bank.
              {'\n\n'}
              ROM hacks that use this technique are automatically detected and loaded
              in extended mode.
            </Text>
          </View>
        </Section>

        <Section title="UPDATES READINESS" cardBg={colors.card} border={colors.border} muted={colors.mutedForeground}>
          <SettingRow
            icon={<Ionicons name="cloud-done-outline" size={18} color={colors.accent} />}
            title="Updates enabled"
            value={updates ? (updates.isEnabled ? 'Yes' : 'No') : Platform.OS === 'web' ? 'Unavailable' : 'Loading…'}
            {...rowProps}
          />
          <SettingRow
            icon={<Ionicons name="git-network-outline" size={18} color={colors.accent} />}
            title="Channel"
            value={updates?.channel ?? '—'}
            {...rowProps}
          />
          <SettingRow
            icon={<Ionicons name="cube-outline" size={18} color={colors.accent} />}
            title="Runtime version"
            value={updates?.runtimeVersion ?? '—'}
            {...rowProps}
          />
          <SettingRow
            icon={<Ionicons name="finger-print-outline" size={18} color={colors.accent} />}
            title="Update ID"
            value={updates?.updateId ?? '—'}
            {...rowProps}
          />
          <SettingRow
            icon={<Ionicons name="download-outline" size={18} color={colors.accent} />}
            title="Launch source"
            value={updates ? (updates.isEmbeddedLaunch ? 'Embedded binary' : 'Downloaded update') : '—'}
            {...rowProps}
          />
          <SettingRow
            icon={<Ionicons name="code-slash-outline" size={18} color={colors.accent} />}
            title="Core tag"
            value={BUILD_TAG}
            {...rowProps}
          />
          <View style={styles.updateActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Check for updates"
              disabled={updateAction !== 'idle' || !canUseUpdates}
              onPress={() => void checkForUpdate()}
              style={({ pressed }) => [
                styles.updateButton,
                {
                  backgroundColor: colors.secondary,
                  borderColor: colors.border,
                  opacity: pressed || updateAction !== 'idle' || !canUseUpdates ? 0.55 : 1,
                },
              ]}
            >
              {updateAction === 'checking' ? (
                <ActivityIndicator size="small" color={colors.foreground} />
              ) : (
                <Ionicons name="refresh-outline" size={17} color={colors.foreground} />
              )}
              <Text style={[styles.updateButtonText, { color: colors.foreground }]}>
                Check for updates
              </Text>
            </Pressable>
            {updateAvailable ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Download update"
                disabled={updateAction !== 'idle'}
                onPress={confirmDownload}
                style={({ pressed }) => [
                  styles.updateButton,
                  {
                    backgroundColor: colors.primary,
                    borderColor: colors.primary,
                    opacity: pressed || updateAction !== 'idle' ? 0.7 : 1,
                  },
                ]}
              >
                {updateAction === 'downloading' ? (
                  <ActivityIndicator size="small" color={colors.primaryForeground} />
                ) : (
                  <Ionicons name="download-outline" size={17} color={colors.primaryForeground} />
                )}
                <Text style={[styles.updateButtonText, { color: colors.primaryForeground }]}>
                  Download update
                </Text>
              </Pressable>
            ) : null}
            {updateAction === 'reloading' ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : null}
            {updateMessage ? (
              <Text
                selectable
                style={[
                  styles.updateMessage,
                  { color: updateMessage.includes('failed') ? colors.destructive : colors.mutedForeground },
                ]}
              >
                {updateMessage}
              </Text>
            ) : null}
            {!canUseUpdates ? (
              <Text style={[styles.updateHint, { color: colors.mutedForeground }]}>
                Manual checks require a release native build; this app never reloads automatically from this screen.
              </Text>
            ) : null}
          </View>
        </Section>

        <Section title="CONTROLS" cardBg={colors.card} border={colors.border} muted={colors.mutedForeground}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Customize controls"
            accessibilityHint="Touch layout, keyboard and controller mapping"
            testID="open-controls"
            onPress={() => router.push('/controls')}
            style={({ pressed }) => [styles.row, { borderBottomColor: colors.border, opacity: pressed ? 0.6 : 1 }]}
          >
            <View style={styles.rowIcon}><Ionicons name="game-controller-outline" size={18} color={colors.accent} /></View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.feedbackTitle, { color: colors.foreground }]}>Customize controls</Text>
              <Text style={[styles.updateHint, { color: colors.mutedForeground }]}>
                Touch button position, size and opacity; keyboard and controller mapping.
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.mutedForeground} />
          </Pressable>
          <SettingRow
            icon={<Ionicons name="hardware-chip-outline" size={18} color={colors.accent} />}
            title="Hardware input"
            value={Platform.OS === 'android' ? (isNativeInputAvailable ? 'Native' : 'Needs app update') : Platform.OS === 'ios' ? 'Game screen' : 'Browser'}
            {...rowProps}
          />
        </Section>

        <Section title="GAMEPLAY" cardBg={colors.card} border={colors.border} muted={colors.mutedForeground}>
          <View style={[styles.row, { borderBottomColor: colors.border }]}>
            <View style={styles.rowIcon}>
              <MaterialCommunityIcons name="phone-rotate-landscape" size={18} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.feedbackTitle, { color: colors.foreground }]}>Start games in landscape</Text>
              <Text style={[styles.updateHint, { color: colors.mutedForeground }]}>
                {Platform.OS === 'android'
                  ? 'Games open sideways. Leaving the game restores your previous rotation.'
                  : 'Available on Android. On this device, rotate the phone to play in landscape.'}
              </Text>
            </View>
            <Switch
              testID="landscape-start-toggle"
              accessibilityLabel="Start games in landscape"
              value={Platform.OS === 'android' && gameplay.prefs.startInLandscape}
              disabled={Platform.OS !== 'android' || !gameplay.ready}
              onValueChange={(value) => void gameplay.update({ startInLandscape: value })}
              trackColor={{ false: colors.border, true: colors.primary }}
            />
          </View>
          {gameplay.error ? (
            <Text accessibilityRole="alert" style={[styles.feedbackMessage, { color: colors.destructive }]}>{gameplay.error}</Text>
          ) : null}
        </Section>

        <Section title="ABOUT" cardBg={colors.card} border={colors.border} muted={colors.mutedForeground}>
          <SettingRow
            icon={<Ionicons name="pricetag-outline" size={18} color={colors.mutedForeground} />}
            title="Build"
            value={BUILD_TAG}
            {...rowProps}
          />
          <SettingRow
            icon={<Ionicons name="code-slash-outline" size={18} color={colors.mutedForeground} />}
            title="Emulator Core"
            value="ARM7TDMI JS"
            {...rowProps}
          />
          <SettingRow
            icon={<Ionicons name="hardware-chip-outline" size={18} color={colors.mutedForeground} />}
            title="CPU"
            value="ARM + THUMB"
            {...rowProps}
          />
          <SettingRow
            icon={<Ionicons name="tv-outline" size={18} color={colors.mutedForeground} />}
            title="Resolution"
            value="240 × 160"
            {...rowProps}
          />
          <SettingRow
            icon={<Ionicons name="layers-outline" size={18} color={colors.mutedForeground} />}
            title="BG Modes"
            value="0–5"
            {...rowProps}
          />
        </Section>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  scroll: {
    padding: 16,
    gap: 8,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.2,
    marginBottom: 8,
    marginLeft: 4,
  },
  sectionCard: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  rowIcon: {
    width: 26,
    alignItems: 'center',
  },
  rowTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
  },
  rowValue: {
    fontSize: 13,
  },
  feedbackTitle: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 4,
  },
  feedbackMessage: {
    fontSize: 12,
    lineHeight: 18,
    padding: 14,
  },
  infoCard: {
    flexDirection: 'row',
    gap: 10,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    margin: 8,
  },
  infoText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 20,
  },
  updateActions: {
    gap: 10,
    padding: 12,
  },
  updateButton: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 14,
  },
  updateButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  updateMessage: {
    fontSize: 13,
    lineHeight: 19,
  },
  updateHint: {
    fontSize: 12,
    lineHeight: 18,
  },
});
