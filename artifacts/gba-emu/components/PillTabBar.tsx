import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { library, PILL_HEIGHT } from '@/constants/libraryTheme';

export interface BarProps {
  state: { index: number; routes: { key: string; name: string }[] };
  descriptors: Record<string, { options: { title?: string } }>;
  navigation: {
    emit: (e: { type: 'tabPress'; target: string; canPreventDefault: true }) => { defaultPrevented: boolean };
    navigate: (name: string) => void;
  };
}

const ICONS: Record<string, [keyof typeof Ionicons.glyphMap, keyof typeof Ionicons.glyphMap]> = {
  index: ['game-controller-outline', 'game-controller'],
  settings: ['settings-outline', 'settings'],
};

export default function PillTabBar({ state, descriptors, navigation }: BarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      testID="pill-tab-wrap"
      style={[styles.wrap, {
        paddingBottom: Math.max(insets.bottom, 12) + 6,
        paddingLeft: Math.max(insets.left, 20),
        paddingRight: Math.max(insets.right, 20),
      }]}
    >
      <View style={styles.pill} accessibilityRole="tablist">
        {state.routes.map((route, i) => {
          const focused = state.index === i;
          const icons = ICONS[route.name] ?? ICONS.index;
          const label = descriptors[route.key]?.options.title ?? route.name;
          const tint = focused ? library.tabOn : library.tabOff;
          return (
            <Pressable
              key={route.key}
              testID={`tab-${route.name}`}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={label}
              onPress={() => {
                const ev = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                if (!focused && !ev.defaultPrevented) navigation.navigate(route.name);
              }}
              style={[styles.item, focused && styles.itemOn]}
            >
              <Ionicons name={focused ? icons[1] : icons[0]} size={26} color={tint} />
              <Text style={[styles.label, { color: tint }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center' },
  pill: {
    flexDirection: 'row', width: '100%', maxWidth: 420, height: PILL_HEIGHT, padding: 6, borderRadius: 36,
    backgroundColor: library.pill, borderWidth: 1, borderColor: library.pillBorder,
    shadowColor: library.shadow, shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  item: { flex: 1, borderRadius: 30, alignItems: 'center', justifyContent: 'center', gap: 2 },
  itemOn: { backgroundColor: library.pillActive },
  label: { fontSize: 12, fontWeight: '600' },
});
