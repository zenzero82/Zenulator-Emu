import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import type { RomEntry } from '@/context/RomLibraryContext';
import { resolveArtworkUri } from '@/library/romArtwork';
import * as FileSystem from 'expo-file-system/legacy';

interface Props {
  rom: RomEntry;
  onPlay: () => void;
  onDelete: () => void;
  onArtworkPress?: () => void;
  onRemoveArtwork?: () => void;
  artworkLoading?: boolean;
  onSavesPress?: () => void;
}

function formatSize(bytes: number): string {
  const mb = bytes / 1048576;
  return mb.toFixed(1) + ' MB';
}

function formatDate(ts?: number): string {
  if (!ts) return 'Never played';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function RomCard({
  rom,
  onPlay,
  onDelete,
  onArtworkPress,
  onRemoveArtwork,
  artworkLoading = false,
  onSavesPress,
}: Props) {
  const colors = useColors();
  const artworkUri = resolveArtworkUri(rom.artworkPath, FileSystem.documentDirectory);
  const hasArtwork = !!rom.artworkPath;

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Pressable onPress={onPlay} style={({ pressed }) => [styles.mainRow, { opacity: pressed ? 0.85 : 1 }]}>
      {/* Cover */}
      <View style={styles.coverSlot}>
        <Pressable
          onPress={(event) => { event.stopPropagation(); onArtworkPress?.(); }}
          disabled={!onArtworkPress || artworkLoading}
          accessibilityRole="button"
          accessibilityLabel={hasArtwork ? `Replace artwork for ${rom.name}` : `Add artwork for ${rom.name}`}
          style={[styles.iconWrap, { backgroundColor: colors.muted }]}
        >
          {artworkUri ? (
            <Image source={{ uri: artworkUri }} style={styles.coverImage} resizeMode="cover" />
          ) : (
            <MaterialCommunityIcons name="memory" size={28} color={colors.primary} />
          )}
        </Pressable>
        {hasArtwork && onRemoveArtwork ? (
          <Pressable
            onPress={(event) => { event.stopPropagation(); onRemoveArtwork?.(); }}
            accessibilityRole="button"
            accessibilityLabel={`Remove artwork for ${rom.name}`}
            hitSlop={6}
            style={[styles.removeArtwork, { backgroundColor: colors.card }]}
          >
            <Ionicons name="close" size={12} color={colors.mutedForeground} />
          </Pressable>
        ) : null}
      </View>

      {/* Info */}
      <View style={styles.info}>
        <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
          {rom.name}
        </Text>
        <View style={styles.meta}>
          <Text style={[styles.metaText, { color: colors.mutedForeground }]}>
            {formatSize(rom.size)}
          </Text>
          {rom.is64MB && (
            <View style={[styles.badge, { backgroundColor: colors.primary + '33' }]}>
              <Text style={[styles.badgeText, { color: colors.primary }]}>64MB</Text>
            </View>
          )}
          {(rom.saveStates?.length ?? 0) > 0 && (
            <View style={[styles.badge, { backgroundColor: colors.accent + '22' }]}>
              <Text style={[styles.badgeText, { color: colors.accent }]}>
                {rom.saveStates!.length} save{rom.saveStates!.length > 1 ? 's' : ''}
              </Text>
            </View>
          )}
        </View>
        <Text style={[styles.lastPlayed, { color: colors.mutedForeground }]}>
          {formatDate(rom.lastPlayed)}
        </Text>
      </View>

        <Pressable
          onPress={(event) => { event.stopPropagation(); onPlay(); }}
          accessibilityRole="button"
          accessibilityLabel={`Play ${rom.name}`}
          style={[styles.playBtn, { backgroundColor: colors.primary }]}
        >
          <Ionicons name="play" size={18} color="#fff" />
        </Pressable>
      </Pressable>

      {/* Secondary actions stay separate from the tap-to-play area. */}
      <View style={[styles.actions, { borderTopColor: colors.border }]}>
        <Pressable
          onPress={(event) => { event.stopPropagation(); onSavesPress?.(); }}
          disabled={!onSavesPress}
          accessibilityRole="button"
          accessibilityLabel={`Manage saves for ${rom.name}`}
          style={styles.deleteBtn}
        >
          <Ionicons name="save-outline" size={18} color={colors.primary} />
        </Pressable>
        <Pressable
          onPress={onDelete}
          accessibilityRole="button"
          accessibilityLabel={`Delete ${rom.name}`}
          style={styles.deleteBtn}
        >
          <Ionicons name="trash-outline" size={16} color={colors.mutedForeground} />
        </Pressable>
        <Pressable
          onPress={onArtworkPress}
          disabled={!onArtworkPress || artworkLoading}
          accessibilityRole="button"
          accessibilityLabel={hasArtwork ? `Replace artwork for ${rom.name}` : `Add artwork for ${rom.name}`}
          style={styles.deleteBtn}
        >
          <Ionicons
            name={artworkLoading ? 'hourglass-outline' : 'image-outline'}
            size={16}
            color={colors.mutedForeground}
          />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 10,
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 12,
  },
  iconWrap: {
    width: 52,
    height: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  coverSlot: {
    width: 52,
    height: 52,
    flexShrink: 0,
    position: 'relative',
  },
  coverImage: {
    width: '100%',
    height: '100%',
    borderRadius: 12,
  },
  removeArtwork: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  info: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  name: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  metaText: {
    fontSize: 12,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  lastPlayed: {
    fontSize: 11,
    marginTop: 1,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 2,
  },
  playBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBtn: {
    flex: 1,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

function hueFor(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

function initialsFor(name: string): string {
  const words = name.replace(/[\[\(].*?[\]\)]/g, ' ').split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return 'GBA';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return (words[0][0] + words[1][0] + (words[2]?.[0] ?? '')).toUpperCase();
}

/** Cover art for the carousel: user artwork, or a generated cover from real metadata. */
export function RomCover({ rom }: { rom: RomEntry }) {
  const uri = resolveArtworkUri(rom.artworkPath, FileSystem.documentDirectory);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [uri]);
  if (uri && !failed) {
    return (
      <Image
        source={{ uri }}
        style={coverStyles.fill}
        resizeMode="cover"
        onError={() => setFailed(true)}
        accessibilityIgnoresInvertColors
      />
    );
  }
  const hue = hueFor(rom.contentHash || rom.id || rom.name);
  return (
    <View style={[coverStyles.fill, coverStyles.generated, { backgroundColor: `hsl(${hue}, 45%, 22%)` }]}>
      <View style={[coverStyles.band, { backgroundColor: `hsl(${(hue + 40) % 360}, 55%, 34%)` }]} />
      <View style={[coverStyles.band2, { backgroundColor: `hsl(${(hue + 300) % 360}, 50%, 14%)` }]} />
      <Text style={coverStyles.initials} numberOfLines={1} adjustsFontSizeToFit>{initialsFor(rom.name)}</Text>
      <Text style={coverStyles.tag}>GAME BOY ADVANCE</Text>
    </View>
  );
}

const coverStyles = StyleSheet.create({
  fill: { width: '100%', height: '100%' },
  generated: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden', paddingHorizontal: 12 },
  band: { position: 'absolute', width: '160%', height: '40%', top: '-8%', transform: [{ rotate: '-18deg' }], opacity: 0.55 },
  band2: { position: 'absolute', width: '160%', height: '45%', bottom: '-14%', transform: [{ rotate: '-18deg' }], opacity: 0.8 },
  initials: { fontSize: 52, fontWeight: '800', color: 'rgba(255,255,255,0.92)', letterSpacing: 2 },
  tag: { position: 'absolute', bottom: 12, fontSize: 9, fontWeight: '700', letterSpacing: 2, color: 'rgba(255,255,255,0.6)' },
});
