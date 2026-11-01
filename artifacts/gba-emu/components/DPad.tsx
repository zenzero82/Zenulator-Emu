import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import * as Haptics from '@/hooks/useHapticFeedback';
import { useGameplayControl } from '@/components/GameplayControls';
import { ControlSlot } from '@/components/ControlSlot';
import type { ControlLayout } from '@/library/gameplayPreferences';

const DPAD_SIZE = 150;
const BUTTON_SIZE = 50;

interface Props {
  onKeyChange: (key: string, pressed: boolean) => void;
  /** Saved per-orientation position/size/opacity. */
  layout?: ControlLayout;
}

const DIRS = ['up', 'down', 'left', 'right'] as const;
type Dir = (typeof DIRS)[number];
type DirSet = Record<Dir, boolean>;

const NONE: DirSet = { up: false, down: false, left: false, right: false };

export default function DPad({ onKeyChange, layout }: Props) {
  const scale = layout?.scale ?? 1;
  // The touch surface is laid out at its real scaled size so Android's
  // measured page bounds and local touch coordinates agree; only the purely
  // visual inner cross is drawn with a transform.
  const size = Math.round(DPAD_SIZE * scale);
  const active = useRef<DirSet>(NONE);
  // Mirrors `active` for styling only — key events never wait on a render.
  const [visual, setVisual] = useState<DirSet>(NONE);

  // 8-way direction resolution, like a physical D-pad rocker:
  // - a small central deadzone (with hysteresis: harder to leave a pressed
  //   direction than to enter one, so the pad doesn't flutter at edges)
  // - the angle decides between cardinal (single) and diagonal (two keys),
  //   using 8 equal 45-degree sectors
  const resolve = useCallback((x: number, y: number, held: boolean): DirSet => {
    const dx = x - size / 2;
    const dy = y - size / 2;
    const dist = Math.hypot(dx, dy);
    // Enter at 10% of the pad radius; once held, keep responding until the
    // finger returns within 6% — prevents accidental releases mid-press.
    const enter = size * 0.1;
    const stay = size * 0.06;
    if (dist < (held ? stay : enter)) return NONE;

    // Angle in degrees, 0 = right, counter-clockwise negative in screen
    // coords (y grows downward), normalized to [0, 360).
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (deg < 0) deg += 360;

    const set: DirSet = { up: false, down: false, left: false, right: false };
    // 8 sectors of 45 degrees centered on the 8 directions.
    if (deg < 22.5 || deg >= 337.5) set.right = true;
    else if (deg < 67.5) { set.right = true; set.down = true; }
    else if (deg < 112.5) set.down = true;
    else if (deg < 157.5) { set.down = true; set.left = true; }
    else if (deg < 202.5) set.left = true;
    else if (deg < 247.5) { set.left = true; set.up = true; }
    else if (deg < 292.5) set.up = true;
    else { set.up = true; set.right = true; }
    return set;
  }, [size]);

  const applySet = useCallback((next: DirSet) => {
    const prev = active.current;
    let changed = false;
    let anyNewPress = false;
    for (const d of DIRS) {
      if (prev[d] !== next[d]) {
        onKeyChange(d, next[d]);
        changed = true;
        if (next[d]) anyNewPress = true;
      }
    }
    if (!changed) return;
    active.current = next;
    setVisual(next);
    if (anyNewPress) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    }
  }, [onKeyChange]);

  const { touchProps, touchRef } = useGameplayControl('dpad', onKeyChange, {
    hitSlop: 14,
    onPointsChange: (points) => {
      const next = { ...NONE };
      for (const point of points) {
        const directions = resolve(point.x, point.y, Object.values(active.current).some(Boolean));
        for (const direction of DIRS) next[direction] ||= directions[direction];
      }
      applySet(next);
    },
  });

  // One continuous molded cross with per-arm press feedback: the pressed
  // arm's cap darkens and its tick brightens, so the pad reads and feels
  // like a real rocker button instead of a static slab.
  return (
    <ControlSlot layout={layout}>
      <View
        {...touchProps}
        ref={touchRef}
        collapsable={false}
        style={[styles.dpad, { width: size, height: size }]}
        hitSlop={14}
        accessibilityRole="button"
        accessibilityLabel="D-pad"
        accessibilityState={{ selected: Object.values(visual).some(Boolean) }}
        aria-selected={Object.values(visual).some(Boolean)}
        aria-valuetext={DIRS.filter((direction) => visual[direction]).join(' + ') || 'Released'}
        testID="game-button-dpad"
      >
        <View
          pointerEvents="none"
          style={[styles.visual, { left: (size - DPAD_SIZE) / 2, top: (size - DPAD_SIZE) / 2, transform: [{ scale }] }]}
        >
        <View style={[styles.bar, styles.barVertical]} />
        <View style={[styles.bar, styles.barHorizontal]} />
        {/* Pressed-arm caps (overlay the bars, so they tint just one arm) */}
        {visual.up && <View style={[styles.cap, styles.capUp]} />}
        {visual.down && <View style={[styles.cap, styles.capDown]} />}
        {visual.left && <View style={[styles.cap, styles.capLeft]} />}
        {visual.right && <View style={[styles.cap, styles.capRight]} />}
        <View style={[styles.tick, styles.tickUp, visual.up && styles.tickActive]} />
        <View style={[styles.tick, styles.tickDown, visual.down && styles.tickActive]} />
        <View style={[styles.tick, styles.tickLeft, visual.left && styles.tickActive]} />
        <View style={[styles.tick, styles.tickRight, visual.right && styles.tickActive]} />
        <View style={styles.centerDimple} />
        </View>
      </View>
    </ControlSlot>
  );
}

const ARM_W = BUTTON_SIZE;
const CENTER = (DPAD_SIZE - ARM_W) / 2;
const ARM_LEN = CENTER; // length of each arm outside the center square
const TICK_LEN = 16;
const TICK_THICK = 3;
const TICK_INSET = 12;

const styles = StyleSheet.create({
  dpad: {
    width: DPAD_SIZE,
    height: DPAD_SIZE,
    position: 'relative',
  },
  visual: {
    position: 'absolute',
    width: DPAD_SIZE,
    height: DPAD_SIZE,
  },
  bar: {
    position: 'absolute',
    backgroundColor: '#1F1F21',
    borderRadius: 10,
  },
  barVertical: {
    left: CENTER,
    top: 0,
    width: ARM_W,
    height: DPAD_SIZE,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.55,
    shadowRadius: 5,
    elevation: 5,
  },
  barHorizontal: {
    top: CENTER,
    left: 0,
    width: DPAD_SIZE,
    height: ARM_W,
  },
  cap: {
    position: 'absolute',
    backgroundColor: '#121214',
    borderRadius: 10,
  },
  capUp: { left: CENTER, top: 0, width: ARM_W, height: ARM_LEN },
  capDown: { left: CENTER, bottom: 0, width: ARM_W, height: ARM_LEN },
  capLeft: { top: CENTER, left: 0, width: ARM_LEN, height: ARM_W },
  capRight: { top: CENTER, right: 0, width: ARM_LEN, height: ARM_W },
  tick: {
    position: 'absolute',
    backgroundColor: '#4A4A50',
    borderRadius: TICK_THICK / 2,
  },
  tickActive: {
    backgroundColor: '#A78BFA',
  },
  tickUp: {
    top: TICK_INSET,
    left: (DPAD_SIZE - TICK_LEN) / 2,
    width: TICK_LEN,
    height: TICK_THICK,
  },
  tickDown: {
    bottom: TICK_INSET,
    left: (DPAD_SIZE - TICK_LEN) / 2,
    width: TICK_LEN,
    height: TICK_THICK,
  },
  tickLeft: {
    left: TICK_INSET,
    top: (DPAD_SIZE - TICK_LEN) / 2,
    width: TICK_THICK,
    height: TICK_LEN,
  },
  tickRight: {
    right: TICK_INSET,
    top: (DPAD_SIZE - TICK_LEN) / 2,
    width: TICK_THICK,
    height: TICK_LEN,
  },
  centerDimple: {
    position: 'absolute',
    width: 18,
    height: 18,
    borderRadius: 9,
    top: (DPAD_SIZE - 18) / 2,
    left: (DPAD_SIZE - 18) / 2,
    backgroundColor: '#191919',
  },
});
