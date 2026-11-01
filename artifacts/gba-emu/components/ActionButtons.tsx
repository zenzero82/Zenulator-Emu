import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from '@/hooks/useHapticFeedback';
import { Ionicons } from '@expo/vector-icons';
import { useGameplayControl } from '@/components/GameplayControls';
import { ControlSlot } from '@/components/ControlSlot';
import { speedLabel, type ControlLayout, type SpeedFactor } from '@/library/gameplayPreferences';

interface Props {
  onKeyChange: (key: string, pressed: boolean) => void;
  layout?: ControlLayout;
}

interface ButtonDef {
  key: string;
  label: string;
}

const AB_BUTTONS: Record<'a' | 'b', ButtonDef> = {
  a: { key: 'a', label: 'A' },
  b: { key: 'b', label: 'B' },
};

function GameButton({ def, size, onKeyChange }: { def: ButtonDef; size: number; onKeyChange: (k: string, p: boolean) => void }) {
  const { touchProps, touchRef, pressed } = useGameplayControl(def.key as 'a' | 'b', onKeyChange, {
    onPress: () => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    },
  });
  return (
      <View
        {...touchProps}
        ref={touchRef}
        collapsable={false}
        accessibilityRole="button"
        accessibilityLabel={def.label}
        accessibilityState={{ selected: pressed }}
        aria-selected={pressed}
        testID={`game-button-${def.key}`}
        style={[
          styles.abBtn,
          { width: size, height: size, borderRadius: size / 2 },
          pressed && styles.btnPressed,
          Platform.OS === 'android' && styles.androidTouchSurface,
        ]}
      >
        <View pointerEvents="none"><Text style={[styles.abLabel, { fontSize: Math.round(20 * (size / 58)) }]}>{def.label}</Text></View>
      </View>
  );
}

function ShoulderButton({ label, keyName, onKeyChange, scale = 1 }: { label: string; keyName: string; onKeyChange: (k: string, p: boolean) => void; scale?: number }) {
  const { touchProps, touchRef, pressed } = useGameplayControl(keyName as 'l' | 'r', onKeyChange, {
    onPress: () => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    },
  });
  return (
      <View
        {...touchProps}
        ref={touchRef}
        collapsable={false}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: pressed }}
        aria-selected={pressed}
        testID={`game-button-${keyName}`}
        style={[
          styles.shoulder,
          { paddingHorizontal: Math.round(38 * scale), paddingVertical: Math.round(11 * scale) },
          pressed && styles.btnPressed,
          Platform.OS === 'android' && styles.androidTouchSurface,
        ]}
      >
        <View pointerEvents="none"><Text style={[styles.shoulderLabel, { fontSize: Math.round(13 * scale) }]}>{label}</Text></View>
      </View>
  );
}

function MenuButton({ label, keyName, onKeyChange, scale = 1 }: { label: string; keyName: string; onKeyChange: (k: string, p: boolean) => void; scale?: number }) {
  const { touchProps, touchRef, pressed } = useGameplayControl(keyName as 'start' | 'select', onKeyChange, {
    onPress: () => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    },
  });
  return (
    <View style={styles.menuItem}>
        <View
          {...touchProps}
          ref={touchRef}
          collapsable={false}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ selected: pressed }}
          aria-selected={pressed}
          testID={`game-button-${keyName}`}
          style={[
            styles.menuBtn,
            { width: Math.round(26 * scale), height: Math.round(26 * scale), borderRadius: Math.round(13 * scale) },
            pressed && styles.btnPressed,
            Platform.OS === 'android' && styles.androidTouchSurface,
          ]}
        />
      <Text style={styles.menuLabel}>{label}</Text>
    </View>
  );
}

export function ShoulderButtons({ onKeyChange, lLayout, rLayout }: Props & { lLayout?: ControlLayout; rLayout?: ControlLayout }) {
  return (
    <View style={styles.shoulders}>
      <LButton onKeyChange={onKeyChange} layout={lLayout} />
      <RButton onKeyChange={onKeyChange} layout={rLayout} />
    </View>
  );
}

/** Individual L shoulder button — used in landscape layout. */
export function LButton({ onKeyChange, layout }: Props) {
  return (
    <ControlSlot layout={layout}>
      <ShoulderButton label="L" keyName="l" onKeyChange={onKeyChange} scale={layout?.scale} />
    </ControlSlot>
  );
}

/** Individual R shoulder button — used in landscape layout. */
export function RButton({ onKeyChange, layout }: Props) {
  return (
    <ControlSlot layout={layout}>
      <ShoulderButton label="R" keyName="r" onKeyChange={onKeyChange} scale={layout?.scale} />
    </ControlSlot>
  );
}

export function MenuButtons({ onKeyChange, layout }: Props) {
  return (
    <ControlSlot layout={layout}>
      <View style={styles.menuRow}>
        <MenuButton label="SELECT" keyName="select" onKeyChange={onKeyChange} scale={layout?.scale} />
        <MenuButton label="START" keyName="start" onKeyChange={onKeyChange} scale={layout?.scale} />
      </View>
    </ControlSlot>
  );
}

/** Diamond A/B layout — B lower-left, A upper-right, matching handheld skins. */
export function ABButtons({ onKeyChange, layout }: Props) {
  const scale = layout?.scale ?? 1;
  const diamond = Math.round(DIAMOND * scale);
  const button = Math.round(58 * scale);
  return (
    <ControlSlot layout={layout}>
      <View style={[styles.abDiamond, { width: diamond, height: diamond }]}>
        <View style={styles.abTopRight}>
          <GameButton def={AB_BUTTONS.a} size={button} onKeyChange={onKeyChange} />
        </View>
        <View style={styles.abBottomLeft}>
          <GameButton def={AB_BUTTONS.b} size={button} onKeyChange={onKeyChange} />
        </View>
      </View>
    </ControlSlot>
  );
}

export function HomeButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Save and exit to home"
      testID="home-button"
      onPress={onPress}
      style={({ pressed }) => [styles.homeBtn, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Ionicons name="home-outline" size={18} color="#8A8A94" />
    </Pressable>
  );
}

/**
 * Four presses: Normal -> FF +1x (2x) -> FF +2x (3x) -> FF +3x (4x)
 * -> Normal. Actual speed still depends on processing headroom.
 */
export function SpeedButton({ speed, onPress }: { speed: SpeedFactor; onPress: () => void }) {
  const active = speed !== 1;
  // Use the same independent pointer ownership as B/D-pad. Ordinary native
  // Pressables can lose a second finger while another gameplay key is held.
  const { touchProps, touchRef, pressed } = useGameplayControl('speed', () => {}, { onPress });
  return (
    <View
      {...touchProps}
      ref={touchRef}
      collapsable={false}
      accessibilityRole="button"
      accessibilityLabel={`Fast-forward: ${speedLabel(speed)} (${speed} times normal speed)`}
      accessibilityHint="Cycles Normal, FF plus 1x, FF plus 2x, FF plus 3x, then Normal"
      accessibilityState={{ selected: active }}
      testID="fast-forward-button"
      onAccessibilityTap={onPress}
      style={[
        styles.utilityBtn,
        active && styles.fastForwardActive,
        pressed && styles.btnPressed,
      ]}
    >
      {active ? (
        <Text style={styles.speedLabelActive}>{`FF\n+${speed - 1}×`}</Text>
      ) : (
        <Ionicons name="play-forward" size={18} color="#A8A8B0" />
      )}
    </View>
  );
}

export function MenuToggleButton({ open, onPress }: { open: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={open ? 'Close game menu' : 'Open game menu'}
      accessibilityState={{ expanded: open }}
      testID="game-menu-button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.utilityBtn,
        open && styles.menuOpen,
        pressed && styles.btnPressed,
      ]}
    >
      <Ionicons name={open ? 'close' : 'menu'} size={20} color="#A8A8B0" />
    </Pressable>
  );
}

const DIAMOND = 122;

const styles = StyleSheet.create({
  // Physical press feedback: sink 1-2px, drop the shadow, darken slightly.
  // No scale animations — controls must feel immediate.
  btnPressed: {
    transform: [{ translateY: 2 }],
    backgroundColor: '#2A2A2C',
    shadowOpacity: 0.15,
    elevation: 1,
  },
  // Android routes from measured page bounds. Keep the hit surface stationary
  // while held; color/shadow feedback remains, iOS/web keep the sinking effect.
  androidTouchSurface: {
    transform: [],
  },
  abDiamond: {
    width: DIAMOND,
    height: DIAMOND,
    position: 'relative',
  },
  abTopRight: {
    position: 'absolute',
    top: 0,
    right: 0,
  },
  abBottomLeft: {
    position: 'absolute',
    bottom: 0,
    left: 0,
  },
  abBtn: {
    backgroundColor: '#38383C',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#48484E',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.55,
    shadowRadius: 4,
    elevation: 6,
  },
  abLabel: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: 1,
    color: '#9A9AA0',
  },
  shoulders: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    width: '100%',
  },
  shoulder: {
    backgroundColor: '#38383C',
    paddingHorizontal: 38,
    paddingVertical: 11,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#48484E',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.45,
    shadowRadius: 3,
    elevation: 3,
  },
  shoulderLabel: {
    color: '#8A8A90',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  menuRow: {
    flexDirection: 'row',
    gap: 22,
    alignItems: 'center',
  },
  menuItem: {
    alignItems: 'center',
    gap: 5,
  },
  menuBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#38383C',
    borderWidth: 1,
    borderColor: '#48484E',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 2,
    elevation: 2,
  },
  menuLabel: {
    color: '#6B6B70',
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 1,
  },
  homeBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#333336',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#444448',
  },
  utilityBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#333336',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#444448',
  },
  fastForwardActive: {
    backgroundColor: 'rgba(167,139,250,0.85)',
    borderColor: '#B8A4FF',
  },
  speedLabelActive: {
    color: '#14101F',
    fontSize: 11,
    textAlign: 'center',
    fontWeight: '800',
  },
  menuOpen: {
    backgroundColor: '#47474C',
  },
});
