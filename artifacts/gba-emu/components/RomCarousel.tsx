import React, { useCallback, useEffect, useRef } from 'react';
import { Platform, Pressable, StyleSheet, View, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import type { FlatList } from 'react-native';
import type { RomEntry } from '@/context/RomLibraryContext';
import { RomCover } from '@/components/RomCard';
import { library } from '@/constants/libraryTheme';
import { indexFromOffset } from '@/library/carouselSelection';

interface Props {
  roms: RomEntry[];
  selectedIndex: number;
  width: number;
  cover: number;
  onSelectIndex: (index: number) => void;
}

function Slide({ rom, index, itemW, cover, scrollX, selected, onPress }: {
  rom: RomEntry; index: number; itemW: number; cover: number;
  scrollX: SharedValue<number>; selected: boolean; onPress: () => void;
}) {
  const style = useAnimatedStyle(() => {
    const p = (scrollX.value - index * itemW) / itemW;
    return {
      opacity: interpolate(p, [-1.5, -1, 0, 1, 1.5], [0.2, 0.7, 1, 0.7, 0.2], Extrapolation.CLAMP),
      transform: [
        { perspective: 900 },
        { scale: interpolate(p, [-1, 0, 1], [0.8, 1, 0.8], Extrapolation.CLAMP) },
        { rotateY: `${interpolate(p, [-1, 0, 1], [26, 0, -26], Extrapolation.CLAMP)}deg` },
      ],
    };
  });
  return (
    <View style={{ width: itemW, height: cover + 40, alignItems: 'center', justifyContent: 'center' }}>
      <Pressable
        onPress={onPress}
        testID={`rom-cover-${rom.id}`}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={selected ? `${rom.name}, selected` : `Select ${rom.name}`}
      >
        <Animated.View style={[{ width: cover, height: cover }, style]}>
          {selected ? (
            <>
              {[44, 28, 14].map((pad, k) => (
                <View
                  key={pad}
                  pointerEvents="none"
                  style={[styles.halo, { top: -pad, left: -pad, right: -pad, bottom: -pad, borderRadius: 22 + pad, backgroundColor: library.halo[k] }]}
                />
              ))}
            </>
          ) : null}
          <View style={[styles.frame, selected && styles.frameOn]}>
            <View style={styles.inner}><RomCover rom={rom} /></View>
          </View>
        </Animated.View>
      </Pressable>
    </View>
  );
}

export default function RomCarousel({ roms, selectedIndex, width, cover, onSelectIndex }: Props) {
  const itemW = Math.round(cover * 0.78);
  const side = Math.max(0, (width - itemW) / 2);
  const listRef = useRef<FlatList<RomEntry>>(null);
  const scrollX = useSharedValue(selectedIndex * itemW);
  const dragging = useSharedValue(0);
  const draggingRef = useRef(false);
  const mounted = useRef(false);
  const onSelectRef = useRef(onSelectIndex);
  onSelectRef.current = onSelectIndex;
  const count = roms.length;
  const webSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (webSettleTimer.current) clearTimeout(webSettleTimer.current);
  }, []);
  // RN Web does not emit native begin-drag/momentum-end events. Commit when
  // DOM scrolling settles instead, including touch inertia and trackpads.
  const webScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offset = event.nativeEvent.contentOffset.x;
    scrollX.value = offset;
    draggingRef.current = true;
    if (webSettleTimer.current) clearTimeout(webSettleTimer.current);
    webSettleTimer.current = setTimeout(() => {
      webSettleTimer.current = null;
      finish(indexFromOffset(offset, itemW, count));
    }, 120);
  };

  const handler = useAnimatedScrollHandler({
    onScroll: (e) => { scrollX.value = e.contentOffset.x; },
    onBeginDrag: () => { dragging.value = 1; runOnJS(setDrag)(true); },
    onMomentumEnd: (e) => {
      dragging.value = 0;
      runOnJS(finish)(indexFromOffset(e.contentOffset.x, itemW, count));
    },
    onEndDrag: (e) => {
      // Only settle here when no momentum phase will follow.
      if (Math.abs(e.velocity?.x ?? 0) < 0.05) {
        dragging.value = 0;
        runOnJS(finish)(indexFromOffset(e.contentOffset.x, itemW, count));
      }
    },
  });
  function setDrag(v: boolean) { draggingRef.current = v; }
  function finish(idx: number) {
    draggingRef.current = false;
    onSelectRef.current(idx);
    const target = idx * itemW;
    // Commit the real snapped page; correct any residual offset.
    if (Math.abs(scrollX.value - target) > 1) {
      listRef.current?.scrollToOffset({ offset: target, animated: true });
    }
  }

  useAnimatedReaction(
    () => indexFromOffset(scrollX.value, itemW, count),
    (idx, prev) => {
      if (dragging.value === 1 && idx !== prev) runOnJS(emit)(idx);
    },
    [count, itemW],
  );
  function emit(idx: number) { onSelectRef.current(idx); }

  // Keep the selected ROM centered across removals, imports and rotation.
  useEffect(() => {
    // Never fight an active user drag/momentum.
    if (draggingRef.current) return;
    const target = selectedIndex * itemW;
    if (Math.abs(scrollX.value - target) > 1) {
      listRef.current?.scrollToOffset({ offset: target, animated: mounted.current });
    }
    mounted.current = true;
  }, [selectedIndex, itemW, count, scrollX]);

  const render = useCallback(({ item, index }: { item: RomEntry; index: number }) => (
    <Slide
      rom={item} index={index} itemW={itemW} cover={cover} scrollX={scrollX}
      selected={index === selectedIndex}
      onPress={() => onSelectRef.current(index)}
    />
  ), [itemW, cover, scrollX, selectedIndex]);

  return (
    <Animated.FlatList
      ref={listRef as never}
      testID="rom-carousel"
      data={roms}
      extraData={selectedIndex}
      keyExtractor={(r: RomEntry) => r.id}
      renderItem={render as never}
      horizontal
      showsHorizontalScrollIndicator={false}
      snapToInterval={itemW}
      decelerationRate="fast"
      disableIntervalMomentum
      contentContainerStyle={{ paddingHorizontal: side }}
      getItemLayout={(_: unknown, i: number) => ({ length: itemW, offset: itemW * i, index: i })}
      initialScrollIndex={Math.min(selectedIndex, Math.max(0, count - 1))}
      initialNumToRender={5}
      windowSize={5}
      maxToRenderPerBatch={4}
      removeClippedSubviews
      onScroll={Platform.OS === 'web' ? webScroll : handler}
      scrollEventThrottle={16}
      style={{ flexGrow: 0, flexShrink: 0, width, height: cover + 40 }}
    />
  );
}

const styles = StyleSheet.create({
  frame: {
    flex: 1, borderRadius: 22, padding: 5, backgroundColor: library.frame,
    borderWidth: 1.5, borderColor: library.frameBorder,
  },
  frameOn: {
    borderColor: library.accentBright, shadowColor: library.accent, shadowOpacity: 0.8,
    shadowRadius: 22, shadowOffset: { width: 0, height: 0 },
  },
  halo: { position: 'absolute' },
  inner: { flex: 1, borderRadius: 17, overflow: 'hidden' },
});
