import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import type { LinkPlayStatus } from '@/hooks/useLinkPlay';

interface LinkPlayPanelProps {
  visible: boolean;
  status: LinkPlayStatus;
  roomCode: string;
  role: 'host' | 'guest' | null;
  message: string;
  romReady: boolean;
  onClose: () => void;
  onCreate: () => void;
  onJoin: (code: string) => void;
  onLeave: () => void;
}

export default function LinkPlayPanel({
  visible,
  status,
  roomCode,
  role,
  message,
  romReady,
  onClose,
  onCreate,
  onJoin,
  onLeave,
}: LinkPlayPanelProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [joinCode, setJoinCode] = useState('');

  if (!visible) return null;

  const isActive = status === 'waiting' || status === 'connected';
  const isConnecting = status === 'connecting';
  const normalizedCode = joinCode.replace(/[^A-Z2-9]/g, '').slice(0, 6);

  const shareRoom = () => {
    if (!roomCode) return;
    Share.share({
      message: `Join my Zenulator Link Play room: ${roomCode}\nUse the exact same game and ROM revision.`,
    }).catch(() => {});
  };

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={[
        styles.backdrop,
        {
          paddingTop: Math.max(insets.top, 16),
          paddingBottom: Math.max(insets.bottom, 16),
          backgroundColor: colors.background,
        },
      ]}
    >
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <View style={[styles.titleIcon, { backgroundColor: colors.secondary }]}>
            <Ionicons name="git-network-outline" size={20} color={colors.accent} />
          </View>
          <View>
            <Text style={[styles.title, { color: colors.foreground }]}>Link Play</Text>
            <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
              Private two-player GBA cable
            </Text>
          </View>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close Link Play"
          onPress={onClose}
          style={({ pressed }) => [
            styles.closeButton,
            { backgroundColor: colors.secondary, opacity: pressed ? 0.65 : 1 },
          ]}
        >
          <Ionicons name="close" size={20} color={colors.foreground} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        style={styles.contentScroll}
      >
        {isActive ? (
          <View
            style={[
              styles.sessionCard,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <View style={styles.connectionRow}>
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: status === 'connected' ? colors.accent : colors.primary },
                ]}
              />
              <Text style={[styles.connectionLabel, { color: colors.foreground }]}>
                {status === 'connected' ? 'Cable connected' : 'Waiting for player 2'}
              </Text>
            </View>

            <Text style={[styles.roomLabel, { color: colors.mutedForeground }]}>
              PRIVATE ROOM CODE
            </Text>
            <Text selectable style={[styles.roomCode, { color: colors.foreground }]}>
              {roomCode}
            </Text>

            <Text style={[styles.sessionDetail, { color: colors.mutedForeground }]}>
              {role === 'host' ? 'Player 1 · cable master' : 'Player 2'}
            </Text>
            <Text style={[styles.message, { color: colors.mutedForeground }]}>
              {message}
            </Text>

            {status === 'waiting' ? (
              <Pressable
                accessibilityRole="button"
                onPress={shareRoom}
                style={({ pressed }) => [
                  styles.primaryButton,
                  { backgroundColor: colors.primary, opacity: pressed ? 0.75 : 1 },
                ]}
              >
                <Ionicons name="share-outline" size={18} color={colors.primaryForeground} />
                <Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>
                  Share invite code
                </Text>
              </Pressable>
            ) : (
              <View
                style={[
                  styles.readyNotice,
                  { backgroundColor: colors.secondary, borderColor: colors.border },
                ]}
              >
                <Ionicons name="checkmark-circle" size={20} color={colors.accent} />
                <Text style={[styles.readyText, { color: colors.secondaryForeground }]}>
                  Open the game&apos;s normal Cable Club or multiplayer menu.
                </Text>
              </View>
            )}

            <Pressable
              accessibilityRole="button"
              onPress={onLeave}
              style={({ pressed }) => [
                styles.leaveButton,
                { borderColor: colors.destructive, opacity: pressed ? 0.65 : 1 },
              ]}
            >
              <Text style={[styles.leaveText, { color: colors.destructive }]}>Leave room</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View
              style={[
                styles.infoCard,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <Ionicons name="shield-checkmark-outline" size={20} color={colors.accent} />
              <Text style={[styles.infoText, { color: colors.mutedForeground }]}>
                Both players must own and load the exact same game and revision. ROMs and save
                files never leave either device.
              </Text>
            </View>

            {message ? (
              <View
                style={[
                  styles.messageCard,
                  {
                    backgroundColor: status === 'error' ? colors.secondary : colors.card,
                    borderColor: status === 'error' ? colors.destructive : colors.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.message,
                    { color: status === 'error' ? colors.destructive : colors.mutedForeground },
                  ]}
                >
                  {message}
                </Text>
              </View>
            ) : null}

            <Pressable
              accessibilityRole="button"
              disabled={!romReady || isConnecting}
              onPress={onCreate}
              style={({ pressed }) => [
                styles.primaryButton,
                {
                  backgroundColor: colors.primary,
                  opacity: !romReady || isConnecting ? 0.4 : pressed ? 0.75 : 1,
                },
              ]}
            >
              {isConnecting ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Ionicons name="add-circle-outline" size={19} color={colors.primaryForeground} />
              )}
              <Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>
                Create private room
              </Text>
            </Pressable>

            <View style={styles.dividerRow}>
              <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
              <Text style={[styles.dividerText, { color: colors.mutedForeground }]}>OR JOIN</Text>
              <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
            </View>

            <TextInput
              accessibilityLabel="Link Play room code"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={6}
              onChangeText={(value) =>
                setJoinCode(value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6))
              }
              onSubmitEditing={() => {
                if (romReady && normalizedCode.length === 6 && !isConnecting) {
                  onJoin(normalizedCode);
                }
              }}
              placeholder="ROOM CODE"
              placeholderTextColor={colors.mutedForeground}
              returnKeyType="go"
              value={normalizedCode}
              style={[
                styles.codeInput,
                {
                  backgroundColor: colors.input,
                  borderColor: colors.border,
                  color: colors.foreground,
                },
              ]}
            />
            <Pressable
              accessibilityRole="button"
              disabled={!romReady || normalizedCode.length !== 6 || isConnecting}
              onPress={() => onJoin(normalizedCode)}
              style={({ pressed }) => [
                styles.joinButton,
                {
                  backgroundColor: colors.secondary,
                  borderColor: colors.border,
                  opacity:
                    !romReady || normalizedCode.length !== 6 || isConnecting
                      ? 0.4
                      : pressed
                        ? 0.7
                        : 1,
                },
              ]}
            >
              <Text style={[styles.joinButtonText, { color: colors.secondaryForeground }]}>
                Join room
              </Text>
            </Pressable>

            {!romReady ? (
              <Text style={[styles.hashWait, { color: colors.mutedForeground }]}>
                Finishing game compatibility check…
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    paddingHorizontal: 20,
  },
  header: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  titleIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3 },
  subtitle: { fontSize: 12, marginTop: 2 },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contentScroll: { width: '100%', maxWidth: 480, alignSelf: 'center' },
  content: { paddingTop: 12, paddingBottom: 24 },
  infoCard: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginBottom: 18,
  },
  infoText: { flex: 1, fontSize: 13, lineHeight: 19 },
  messageCard: { borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 14 },
  message: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  primaryButton: {
    minHeight: 52,
    borderRadius: 15,
    flexDirection: 'row',
    gap: 9,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  primaryButtonText: { fontSize: 15, fontWeight: '700' },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 20 },
  dividerLine: { height: StyleSheet.hairlineWidth, flex: 1 },
  dividerText: { fontSize: 10, fontWeight: '700', letterSpacing: 1.4 },
  codeInput: {
    height: 58,
    borderWidth: 1,
    borderRadius: 15,
    textAlign: 'center',
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 8,
    paddingLeft: 18,
  },
  joinButton: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  joinButtonText: { fontSize: 14, fontWeight: '700' },
  hashWait: { fontSize: 12, textAlign: 'center', marginTop: 14 },
  sessionCard: {
    borderWidth: 1,
    borderRadius: 20,
    padding: 20,
    alignItems: 'stretch',
  },
  connectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 24,
  },
  statusDot: { width: 9, height: 9, borderRadius: 5 },
  connectionLabel: { fontSize: 14, fontWeight: '700' },
  roomLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1.4, textAlign: 'center' },
  roomCode: {
    fontSize: 38,
    lineHeight: 48,
    fontWeight: '700',
    letterSpacing: 8,
    textAlign: 'center',
    marginTop: 4,
  },
  sessionDetail: { fontSize: 12, textAlign: 'center', marginBottom: 8 },
  readyNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 14,
    padding: 13,
    marginTop: 18,
  },
  readyText: { flex: 1, fontSize: 12, lineHeight: 17, fontWeight: '600' },
  leaveButton: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
  },
  leaveText: { fontSize: 14, fontWeight: '700' },
});