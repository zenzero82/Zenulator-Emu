import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useGameplayPreferences } from '@/hooks/useGameplayPreferences';
import { GameplayControlsProvider } from '@/components/GameplayControls';
import DPad from '@/components/DPad';
import { confirmControlReset } from '@/components/confirmControlReset';
import { ABButtons, LButton, MenuButtons, RButton } from '@/components/ActionButtons';
import {
  DEFAULT_CONTROL_LAYOUT, defaultTouchLayout, LAYOUT_LIMITS, normalizeControlLayout,
  TOUCH_CONTROL_IDS, TOUCH_CONTROL_LABELS,
  type ControlLayout, type LayoutOrientation, type TouchControlId, type TouchLayout,
} from '@/library/gameplayPreferences';
import {
  ACTION_LABELS, androidGamepadButton, androidKeyboardCode, assignGamepadBinding, assignKeyboardBinding,
  BINDABLE_GAMEPAD_BUTTONS, clearBinding, DEFAULT_GAMEPAD_BINDINGS, DEFAULT_KEYBOARD_BINDINGS,
  describeGamepadButton, describeKeyCode, INPUT_ACTIONS, parseGamepadBindings, parseKeyboardBindings,
  PICKABLE_KEY_CODES, type InputAction,
} from '@/library/inputMapping';
import {
  addNativeInputListener, isNativeInputAvailable, setNativeInputCapture,
} from '@/modules/zenulator-input';

type Tab = 'touch' | 'keyboard' | 'controller';
const noop = () => {};

// Design-space sizes of the preview decks; scaled to fit the screen.
const PREVIEW = {
  portrait: { w: 360, h: 330 },
  landscape: { w: 760, h: 340 },
};

function Preview({ orientation, layout, selected }: {
  orientation: LayoutOrientation; layout: Record<TouchControlId, ControlLayout>; selected: TouchControlId;
}) {
  const { width } = useWindowDimensions();
  const box = PREVIEW[orientation];
  const available = Math.min(width - 32, 520);
  const scale = Math.min(1, available / box.w);
  const ring = (id: TouchControlId) => (id === selected ? styles.selectedRing : undefined);
  const deck = orientation === 'portrait' ? (
    <View style={{ width: box.w, height: box.h, alignItems: 'center', paddingTop: 16, gap: 18 }}>
      <View style={styles.previewRowSpread}>
        <View style={ring('l')}><LButton onKeyChange={noop} layout={layout.l} /></View>
        <View style={ring('r')}><RButton onKeyChange={noop} layout={layout.r} /></View>
      </View>
      <View style={[styles.previewRowSpread, { paddingHorizontal: 20 }]}>
        <View style={ring('dpad')}><DPad onKeyChange={noop} layout={layout.dpad} /></View>
        <View style={ring('ab')}><ABButtons onKeyChange={noop} layout={layout.ab} /></View>
      </View>
      <View style={ring('startSelect')}><MenuButtons onKeyChange={noop} layout={layout.startSelect} /></View>
    </View>
  ) : (
    <View style={{ width: box.w, height: box.h, flexDirection: 'row' }}>
      <View style={styles.previewSide}>
        <View style={ring('l')}><LButton onKeyChange={noop} layout={layout.l} /></View>
        <View style={ring('dpad')}><DPad onKeyChange={noop} layout={layout.dpad} /></View>
      </View>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <View style={styles.previewScreen}><Text style={styles.previewScreenText}>240 × 160</Text></View>
        <View style={ring('startSelect')}><MenuButtons onKeyChange={noop} layout={layout.startSelect} /></View>
      </View>
      <View style={styles.previewSide}>
        <View style={ring('r')}><RButton onKeyChange={noop} layout={layout.r} /></View>
        <View style={ring('ab')}><ABButtons onKeyChange={noop} layout={layout.ab} /></View>
      </View>
    </View>
  );
  return (
    <View
      accessible
      accessibilityLabel={`${orientation} control layout preview, ${TOUCH_CONTROL_LABELS[selected]} selected`}
      style={[styles.previewFrame, { width: box.w * scale, height: box.h * scale }]}
    >
      <View pointerEvents="none" style={{ width: box.w, height: box.h, transform: [{ scale }], transformOrigin: 'top left' }}>
        <GameplayControlsProvider enabled={false}>{deck}</GameplayControlsProvider>
      </View>
    </View>
  );
}

function Stepper({ label, value, onDec, onInc, decLabel, incLabel, colors }: {
  label: string; value: string; onDec: () => void; onInc: () => void; decLabel: string; incLabel: string;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={[styles.stepper, { borderBottomColor: colors.border }]}>
      <Text style={[styles.stepperLabel, { color: colors.foreground }]}>{label}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={decLabel} onPress={onDec}
        style={({ pressed }) => [styles.stepBtn, { borderColor: colors.border, opacity: pressed ? 0.6 : 1 }]}>
        <Ionicons name="remove" size={18} color={colors.foreground} />
      </Pressable>
      <Text accessibilityLiveRegion="polite" style={[styles.stepValue, { color: colors.mutedForeground }]}>{value}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={incLabel} onPress={onInc}
        style={({ pressed }) => [styles.stepBtn, { borderColor: colors.border, opacity: pressed ? 0.6 : 1 }]}>
        <Ionicons name="add" size={18} color={colors.foreground} />
      </Pressable>
    </View>
  );
}

export default function ControlsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { prefs, update, error } = useGameplayPreferences();
  const [tab, setTab] = useState<Tab>('touch');
  const [orientation, setOrientation] = useState<LayoutOrientation>('portrait');
  const [selected, setSelected] = useState<TouchControlId>('dpad');
  const [rebinding, setRebinding] = useState<{ kind: 'keyboard' | 'controller'; action: InputAction } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const layout = prefs.touchLayout[orientation];
  const current = layout[selected];

  const setControl = (patch: Partial<ControlLayout>) => {
    const next: TouchLayout = {
      ...prefs.touchLayout,
      [orientation]: { ...layout, [selected]: normalizeControlLayout({ ...current, ...patch }) },
    };
    void update({ touchLayout: next });
  };

  const resetAllTouch = () => confirmControlReset('Reset touch layout?', 'Both portrait and landscape layouts return to defaults.', () => {
    void update({ touchLayout: defaultTouchLayout() });
    setNotice('Both touch layouts restored to defaults.');
  });

  const applyBinding = (kind: 'keyboard' | 'controller', action: InputAction, input: string | number) => {
    const result = kind === 'keyboard'
      ? assignKeyboardBinding(prefs.keyboard, action, input as string)
      : assignGamepadBinding(prefs.gamepad, action, input as number);
    if (result.rejected) { setNotice(result.rejected); return; }
    if (kind === 'keyboard') void update({ keyboard: result.bindings as typeof prefs.keyboard });
    else void update({ gamepad: result.bindings as typeof prefs.gamepad });
    const label = kind === 'keyboard' ? describeKeyCode(input as string) : describeGamepadButton(input as number);
    setNotice(result.displaced.length
      ? `${label} now controls ${ACTION_LABELS[action]}; removed from ${result.displaced.map((a) => ACTION_LABELS[a]).join(', ')}.`
      : `${label} now controls ${ACTION_LABELS[action]}.`);
    setRebinding(null);
  };

  // Android: listen for a real key / controller press while the rebind sheet is open.
  useEffect(() => {
    if (!rebinding || !isNativeInputAvailable) return;
    setNativeInputCapture(true);
    const sub = addNativeInputListener((event) => {
      if (event.kind !== 'button' || !event.pressed) return;
      if (rebinding.kind === 'controller' && event.gamepad) {
        const button = androidGamepadButton(event.keyCode);
        if (button !== undefined) applyBinding('controller', rebinding.action, button);
      } else if (rebinding.kind === 'keyboard' && !event.gamepad) {
        const code = androidKeyboardCode(event.keyCode);
        if (code) applyBinding('keyboard', rebinding.action, code);
      }
    });
    return () => { sub.remove(); setNativeInputCapture(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebinding]);

  // Web build of the mobile app: capture a real key press too.
  useEffect(() => {
    if (Platform.OS !== 'web' || rebinding?.kind !== 'keyboard') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      applyBinding('keyboard', rebinding.action, event.code);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebinding]);

  const listening = isNativeInputAvailable || (Platform.OS === 'web' && rebinding?.kind === 'keyboard');
  const pickOptions = useMemo(() => (rebinding?.kind === 'controller'
    ? BINDABLE_GAMEPAD_BUTTONS.map((b) => ({ id: String(b), label: describeGamepadButton(b), value: b as string | number }))
    : PICKABLE_KEY_CODES.map((c) => ({ id: c, label: describeKeyCode(c), value: c as string | number }))), [rebinding?.kind]);

  const segment = (items: Array<[string, string]>, value: string, onChange: (v: string) => void, label: string) => (
    <View accessibilityRole="tablist" accessibilityLabel={label} style={[styles.segment, { borderColor: colors.border, backgroundColor: colors.card }]}>
      {items.map(([id, text]) => {
        const active = id === value;
        return (
          <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: active }} testID={`segment-${id}`}
            onPress={() => onChange(id)} style={[styles.segmentItem, active && { backgroundColor: colors.primary }]}>
            <Text style={[styles.segmentText, { color: active ? colors.primaryForeground : colors.mutedForeground }]}>{text}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  const bindingList = (kind: 'keyboard' | 'controller') => {
    const bindings = kind === 'keyboard' ? prefs.keyboard : prefs.gamepad;
    return (
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {INPUT_ACTIONS.map((action) => {
          const values = (bindings[action] as Array<string | number>).map((v) => (kind === 'keyboard' ? describeKeyCode(v as string) : describeGamepadButton(v as number)));
          return (
            <View key={action} style={[styles.bindRow, { borderBottomColor: colors.border }]}>
              <Text style={[styles.bindAction, { color: colors.foreground }]}>{ACTION_LABELS[action]}</Text>
              <Text numberOfLines={2} style={[styles.bindValue, { color: values.length ? colors.mutedForeground : colors.destructive }]}>
                {values.length ? values.join('  ·  ') : 'Unbound'}
              </Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`Change ${ACTION_LABELS[action]} ${kind} binding`}
                testID={`rebind-${kind}-${action}`} onPress={() => { setNotice(null); setRebinding({ kind, action }); }}
                style={({ pressed }) => [styles.smallBtn, { borderColor: colors.primary, opacity: pressed ? 0.6 : 1 }]}>
                <Text style={[styles.smallBtnText, { color: colors.primary }]}>Change</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`Clear ${ACTION_LABELS[action]} ${kind} binding`}
                onPress={() => {
                  if (kind === 'keyboard') void update({ keyboard: clearBinding(prefs.keyboard, action) });
                  else void update({ gamepad: clearBinding(prefs.gamepad, action) });
                }}
                style={({ pressed }) => [styles.iconBtn, { opacity: pressed ? 0.6 : 1 }]}>
                <Ionicons name="close-circle-outline" size={20} color={colors.mutedForeground} />
              </Pressable>
            </View>
          );
        })}
        <Pressable accessibilityRole="button" accessibilityLabel={`Reset ${kind} bindings to defaults`}
          onPress={() => confirmControlReset('Reset bindings?', `Restore the default ${kind} bindings.`, () => {
              if (kind === 'keyboard') void update({ keyboard: parseKeyboardBindings(DEFAULT_KEYBOARD_BINDINGS) });
              else void update({ gamepad: parseGamepadBindings(DEFAULT_GAMEPAD_BINDINGS) });
              setNotice(`${kind === 'keyboard' ? 'Keyboard' : 'Controller'} bindings restored to defaults.`);
          })}
          style={({ pressed }) => [styles.resetRow, { opacity: pressed ? 0.6 : 1 }]}>
          <Ionicons name="refresh-outline" size={16} color={colors.destructive} />
          <Text style={{ color: colors.destructive, fontWeight: '600' }}>Reset to defaults</Text>
        </Pressable>
      </View>
    );
  };

  const support = Platform.OS === 'android'
    ? (isNativeInputAvailable
      ? 'Android hardware keyboards and controllers are routed natively into the game.'
      : 'This build does not include the native input module. Install an updated build for controller support; a keyboard works only while the game screen has focus.')
    : Platform.OS === 'ios'
      ? 'iOS uses the game screen for MFi / Bluetooth controllers and hardware keyboards.'
      : 'Browser keyboards and controllers are read from the game screen.';

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 32 }]}>
        {segment([['touch', 'Touch'], ['keyboard', 'Keyboard'], ['controller', 'Controller']], tab, (v) => setTab(v as Tab), 'Control type')}
        {error ? <Text accessibilityRole="alert" style={[styles.note, { color: colors.destructive }]}>{error}</Text> : null}
        {notice ? <Text accessibilityLiveRegion="polite" style={[styles.note, { color: colors.accent }]}>{notice}</Text> : null}

        {tab === 'touch' ? (
          <>
            {segment([['portrait', 'Portrait'], ['landscape', 'Landscape']], orientation, (v) => setOrientation(v as LayoutOrientation), 'Layout orientation')}
            <View style={{ alignItems: 'center' }}>
              <Preview orientation={orientation} layout={layout} selected={selected} />
            </View>
            <View style={styles.chips}>
              {TOUCH_CONTROL_IDS.map((id) => (
                <Pressable key={id} accessibilityRole="button" accessibilityState={{ selected: id === selected }}
                  accessibilityLabel={`Edit ${TOUCH_CONTROL_LABELS[id]}`} testID={`touch-control-${id}`}
                  onPress={() => setSelected(id)}
                  style={[styles.chip, { borderColor: id === selected ? colors.primary : colors.border, backgroundColor: id === selected ? colors.primary + '22' : colors.card }]}>
                  <Text style={{ color: id === selected ? colors.primary : colors.foreground, fontWeight: '600', fontSize: 13 }}>{TOUCH_CONTROL_LABELS[id]}</Text>
                </Pressable>
              ))}
            </View>
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Stepper colors={colors} label="Horizontal" value={`${current.x > 0 ? '+' : ''}${current.x}`}
                decLabel="Move left" incLabel="Move right" onDec={() => setControl({ x: current.x - 4 })} onInc={() => setControl({ x: current.x + 4 })} />
              <Stepper colors={colors} label="Vertical" value={`${current.y > 0 ? '+' : ''}${current.y}`}
                decLabel="Move up" incLabel="Move down" onDec={() => setControl({ y: current.y - 4 })} onInc={() => setControl({ y: current.y + 4 })} />
              <Stepper colors={colors} label="Size" value={`${Math.round(current.scale * 100)}%`}
                decLabel="Smaller" incLabel="Larger" onDec={() => setControl({ scale: current.scale - 0.05 })} onInc={() => setControl({ scale: current.scale + 0.05 })} />
              <Stepper colors={colors} label="Opacity" value={`${Math.round(current.opacity * 100)}%`}
                decLabel="More transparent" incLabel="More opaque" onDec={() => setControl({ opacity: current.opacity - 0.1 })} onInc={() => setControl({ opacity: current.opacity + 0.1 })} />
              <Pressable accessibilityRole="button" accessibilityLabel={`Reset ${TOUCH_CONTROL_LABELS[selected]}`}
                onPress={() => setControl({ ...DEFAULT_CONTROL_LAYOUT })} style={styles.resetRow}>
                <Ionicons name="refresh-outline" size={16} color={colors.primary} />
                <Text style={{ color: colors.primary, fontWeight: '600' }}>Reset {TOUCH_CONTROL_LABELS[selected]}</Text>
              </Pressable>
            </View>
            <Text style={[styles.note, { color: colors.mutedForeground }]}>
              Offsets are limited to {LAYOUT_LIMITS.offset} px and sizes to {Math.round(LAYOUT_LIMITS.scaleMin * 100)}–{Math.round(LAYOUT_LIMITS.scaleMax * 100)}% so every control stays reachable. Portrait and landscape are saved separately.
            </Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Reset all touch layouts" onPress={resetAllTouch}
              style={[styles.wideBtn, { borderColor: colors.destructive }]}>
              <Text style={{ color: colors.destructive, fontWeight: '600' }}>Reset all touch layouts</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={[styles.note, { color: colors.mutedForeground }]}>{support} Ctrl, Alt and system keys are never captured.</Text>
            {bindingList(tab)}
          </>
        )}
      </ScrollView>

      {rebinding ? <Modal visible transparent animationType={Platform.OS === 'web' ? 'none' : 'fade'} onRequestClose={() => setRebinding(null)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border, paddingBottom: insets.bottom + 16 }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              {rebinding ? `Bind ${ACTION_LABELS[rebinding.action]}` : ''}
            </Text>
            <Text style={[styles.note, { color: colors.mutedForeground, paddingHorizontal: 0 }]}>
              {listening ? `Press a ${rebinding?.kind === 'controller' ? 'controller button' : 'key'} now, or choose one below.` : 'Choose an input below.'}
              {' '}An input already in use moves to this action.
            </Text>
            <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={styles.pickGrid}>
              {pickOptions.map((option) => (
                <Pressable key={option.id} accessibilityRole="button" accessibilityLabel={`Use ${option.label}`}
                  onPress={() => rebinding && applyBinding(rebinding.kind, rebinding.action, option.value)}
                  style={({ pressed }) => [styles.pick, { borderColor: colors.border, opacity: pressed ? 0.6 : 1 }]}>
                  <Text style={{ color: colors.foreground, fontSize: 13 }}>{option.label}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel rebinding" onPress={() => setRebinding(null)}
              style={[styles.wideBtn, { borderColor: colors.border }]}>
              <Text style={{ color: colors.foreground, fontWeight: '600' }}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 16, gap: 14 },
  segment: { flexDirection: 'row', borderWidth: 1, borderRadius: 12, padding: 3, gap: 3 },
  segmentItem: { flex: 1, minHeight: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  segmentText: { fontSize: 14, fontWeight: '600' },
  previewFrame: { backgroundColor: '#1A1A1E', borderRadius: 16, overflow: 'hidden' },
  previewRowSpread: { flexDirection: 'row', justifyContent: 'space-between', width: '100%', alignItems: 'center', paddingHorizontal: 12 },
  previewSide: { width: 180, alignItems: 'center', justifyContent: 'space-evenly', backgroundColor: '#141418' },
  previewScreen: { width: 300, height: 200, backgroundColor: '#000', borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  previewScreenText: { color: '#4A4A50', fontSize: 14, letterSpacing: 2 },
  selectedRing: { borderWidth: 2, borderColor: '#A78BFA', borderRadius: 18, borderStyle: 'dashed', padding: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, minHeight: 36, borderRadius: 18, borderWidth: 1, justifyContent: 'center' },
  card: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  stepper: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  stepperLabel: { flex: 1, fontSize: 14, fontWeight: '500' },
  stepBtn: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  stepValue: { width: 54, textAlign: 'center', fontSize: 14, fontVariant: ['tabular-nums'] },
  resetRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 48 },
  wideBtn: { minHeight: 46, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  note: { fontSize: 12, lineHeight: 18, paddingHorizontal: 4 },
  bindRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, minHeight: 52, borderBottomWidth: StyleSheet.hairlineWidth },
  bindAction: { width: 90, fontSize: 14, fontWeight: '600' },
  bindValue: { flex: 1, fontSize: 12 },
  smallBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, minHeight: 34, justifyContent: 'center' },
  smallBtnText: { fontSize: 12, fontWeight: '700' },
  iconBtn: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(8,6,16,0.7)', justifyContent: 'flex-end' },
  modalCard: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, padding: 16, gap: 12 },
  modalTitle: { fontSize: 18, fontWeight: '700' },
  pickGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pick: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, minHeight: 40, justifyContent: 'center' },
});
