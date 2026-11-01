import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  BackHandler,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from '@/hooks/useHapticFeedback';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useRomLibrary } from '@/context/RomLibraryContext';
import EmulatorWebView, { type EmulatorRef } from '@/components/EmulatorWebView';
import {
  persistBatterySave as persistStoredBatterySave,
  readBatterySave,
  resolveBatterySaveUri,
} from '@/library/batterySaveStorage';
import DPad from '@/components/DPad';
import { GameplayControlsProvider } from '@/components/GameplayControls';
import {
  ABButtons,
  HomeButton,
  LButton,
  MenuButtons,
  MenuToggleButton,
  RButton,
  ShoulderButtons,
} from '@/components/ActionButtons';
import LinkPlayPanel from '@/components/LinkPlayPanel';
import * as ScreenOrientation from 'expo-screen-orientation';
import { SpeedButton } from '@/components/ActionButtons';
import { confirmControlReset } from '@/components/confirmControlReset';
import { loadGameplayPreferences, useGameplayPreferences } from '@/hooks/useGameplayPreferences';
import { useNativeControllerInput } from '@/hooks/useNativeControllerInput';
import { nextSpeed, type SpeedFactor } from '@/library/gameplayPreferences';
import {
  coreInputMapMessage, createKeyAggregator, isGbaKey, type InputAction,
} from '@/library/inputMapping';
import { useLinkPlay } from '@/hooks/useLinkPlay';

export default function EmulatorScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  // Landscape when the device is rotated sideways. We derive this from
  // window dimensions instead of a runtime orientation API so we never
  // make ScreenOrientation.lockAsync calls during navigation transitions
  // (which hard-crash iOS — see comment below).
  const isLandscape = winWidth > winHeight;
  const router = useRouter();
  const { romId } = useLocalSearchParams<{ romId: string }>();
  const { roms, updateLastPlayed, saveState, loadState, getSaveStates } = useRomLibrary();
  const emulatorRef = useRef<EmulatorRef>(null);
  const [loaded, setLoaded] = useState(false);
  const [statusText, setStatusText] = useState(romId === '__layout_preview' ? '' : 'Loading ROM…');
  const [showMenu, setShowMenu] = useState(false);
  const [fps, setFps] = useState<number | null>(null);
  const latestFpsRef = useRef<number | null>(null);
  const menuVisibleRef = useRef(showMenu);
  menuVisibleRef.current = showMenu;
  const { prefs } = useGameplayPreferences();
  // FF is a gameplay toggle, not a global setting or remembered boot speed.
  const [speed, setSpeed] = useState<SpeedFactor>(1);
  const speedRef = useRef<SpeedFactor>(1);
  const layoutSet = prefs.touchLayout[isLandscape ? 'landscape' : 'portrait'];
  // Full crash report from the core's cpuStuck message. Previously this
  // message was silently dropped, leaving only the terse in-WebView
  // "STUCK: ..." overlay — which made real-ROM crashes undebuggable.
  const [crashReport, setCrashReport] = useState<Record<string, unknown> | null>(null);
  const [showCrashDetail, setShowCrashDetail] = useState(false);
  const [romHash, setRomHash] = useState<string | null>(null);
  const [showLinkPlay, setShowLinkPlay] = useState(false);
  const linkPlay = useLinkPlay({ romHash, emulatorRef });

  const rom = roms.find((r) => r.id === romId);
  // Dev-only layout preview: renders the full console UI without a ROM so
  // the design can be checked in a browser. Unreachable in release builds.
  const isLayoutPreview = __DEV__ && romId === '__layout_preview';

  // A flush is asynchronous: the core posts a batterySave message only
  // after it has built a snapshot. Keep the pending waiter separate from
  // React state so Exit can wait for the final write without racing unmount.
  const flushWaitRef = useRef<{
    requestId: string;
    resolve: () => void;
    reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const flushRequestIdRef = useRef(0);
  const handledFlushRequestIdsRef = useRef(new Set<string>());
  const exitInProgressRef = useRef(false);

  // Surface save-path failures in the same crash-report overlay as core
  // crashes — a save that silently fails to persist is data loss.
  const reportSaveError = useCallback((detail: string, stage: string) => {
    setCrashReport((prev) => prev ?? { category: 'save-error', stage, detail });
  }, []);

  // Orientation is unlocked declaratively via app.json + the expo-screen-
  // orientation plugin (initialOrientation: DEFAULT), baked into Info.plist /
  // AndroidManifest at build time. The emulator screen responds to rotation
  // via useWindowDimensions; other tabs (library, settings) may also rotate
  // until per-route locking is added (tracked separately).
  //
  // There is intentionally NO runtime ScreenOrientation.lockAsync() call here.
  // A runtime lock made during a navigation transition can throw a native
  // UIApplicationInvalidInterfaceOrientationException on iOS that JS
  // try/catch cannot intercept — a hard crash we hit repeatedly before
  // moving to build-time config.

  // Load ROM once WebView signals readiness.
  // On native, the ROM file already lives on disk — hand the WebView its
  // file:// URI directly so it fetches the bytes itself, never routing the
  // (potentially 40MB+ base64) payload through the RN bridge. On web there
  // is no filesystem, so the ROM is stored as base64 in AsyncStorage and
  // sent via the (bridge-free, iframe-based) postMessage fallback.
  const handleReady = useCallback(async () => {
    if (!rom) return;
    if (isLayoutPreview) return;
    setStatusText('Reading ROM…');
    try {
      if (Platform.OS === 'web') {
        const base64 = await AsyncStorage.getItem(`@gba_rom_data_${rom.id}`);
        if (!base64) { setStatusText('ROM data not found — re-import the file'); return; }
        const save = await readBatterySave(rom.id);
        emulatorRef.current?.loadROM({ base64, save: save ?? undefined });
      } else {
        if (!rom.filePath) { setStatusText('ROM file path missing'); return; }
        // Re-anchor the stored path to the CURRENT documentDirectory: iOS
        // rotates the app-container UUID on every app update, so an
        // absolute path recorded before an update no longer exists even
        // though the file itself was carried over into the new container.
        const fileName = rom.filePath.split('/').pop()!;
        const currentPath = `${FileSystem.documentDirectory}gba_roms/${fileName}`;
        let romUri = rom.filePath;
        const info = await FileSystem.getInfoAsync(romUri);
        if (!info.exists) {
          const relocated = await FileSystem.getInfoAsync(currentPath);
          if (!relocated.exists) { setStatusText('ROM file missing — re-import the file'); return; }
          romUri = currentPath;
        }
        // Attach the battery save (if one exists) so the core restores it
        // as part of booting the ROM.
        const saveUri = await resolveBatterySaveUri(rom.id);
        emulatorRef.current?.loadROM({ uri: romUri, saveUri });
      }

      updateLastPlayed(rom.id);
    } catch (e) {
      setStatusText('Failed to load ROM: ' + String(e));
      console.error(e);
    }
  }, [rom, updateLastPlayed]);

  const persistBatterySave = useCallback(async (saveJson: string, requestId?: string) => {
    try {
      if (!romId) return;
      await persistStoredBatterySave(romId, saveJson);
      if (requestId && flushWaitRef.current?.requestId === requestId) {
        flushWaitRef.current.resolve();
      }
    } catch (e) {
      reportSaveError('Failed to write save file: ' + String(e), 'persist');
      if (requestId && flushWaitRef.current?.requestId === requestId) {
        flushWaitRef.current.reject(e);
      }
    }
  }, [romId, reportSaveError]);

  // Touch and native hardware input share one aggregator so a key held by
  // both stays pressed until the last source lets go.
  const aggregatorRef = useRef(createKeyAggregator((key, pressed) => {
    emulatorRef.current?.sendKey(key, pressed);
  }));
  const handleKey = useCallback((key: string, pressed: boolean) => {
    if (isGbaKey(key)) aggregatorRef.current.set('touch', key, pressed);
  }, []);

  // Advance the ref synchronously so rapid taps cannot collapse into one step.
  // Menu/pause preserves the active session; a new game starts at Normal.
  const applySpeed = useCallback((next: SpeedFactor) => {
    speedRef.current = next;
    setSpeed(next);
    emulatorRef.current?.setFastForward(next);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  }, []);
  const cycleSpeed = useCallback(() => applySpeed(nextSpeed(speedRef.current)), [applySpeed]);

  useEffect(() => {
    speedRef.current = 1;
    setSpeed(1);
    // Queued until ready. Never restore a stale persisted FF setting.
    emulatorRef.current?.setFastForward(1);
  }, [romId]);

  // Saved bindings for the in-page keyboard listener (iOS/web hardware
  // keyboards) and the Gamepad API (iOS WKWebView, desktop browsers).
  useEffect(() => {
    emulatorRef.current?.setInputMap(coreInputMapMessage(prefs.keyboard, prefs.gamepad, true));
  }, [prefs.keyboard, prefs.gamepad]);

  const gameplayInputEnabled = !showMenu && !showLinkPlay && !showCrashDetail;
  useEffect(() => {
    // Held for the whole time a menu/modal is open, not a one-shot release:
    // the core ignores keyboard and Gamepad API input until re-enabled.
    emulatorRef.current?.setInputEnabled(gameplayInputEnabled);
    if (gameplayInputEnabled) return;
    aggregatorRef.current.releaseAll();
    emulatorRef.current?.releaseAllKeys();
  }, [gameplayInputEnabled]);

  // Android: hardware keyboard/controller via the local ZenulatorInput module
  // (Android WebView has no Gamepad API). Capture is only on while playing.
  const handleNativeAction = useCallback((action: InputAction, pressed: boolean, source: string) => {
    if (action === 'speed') { if (pressed) cycleSpeed(); return; }
    aggregatorRef.current.set(source, action, pressed);
  }, [cycleSpeed]);
  const handleNativeRelease = useCallback((source: string) => {
    aggregatorRef.current.releaseSource(source);
  }, []);
  useNativeControllerInput({
    enabled: Platform.OS === 'android' && gameplayInputEnabled,
    keyboard: prefs.keyboard,
    gamepad: prefs.gamepad,
    onAction: handleNativeAction,
    onReleaseSource: handleNativeRelease,
  });

  // Android-only "Start games in landscape". The previous lock is captured
  // and restored on exit. iOS NEVER reaches a runtime orientation call: a
  // lock during a navigation transition raised an uncatchable native crash.
  // Rotation does not remount the WebView (single-tree layout below).
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let cancelled = false;
    let previous: ScreenOrientation.OrientationLock | null = null;
    let locked = false;
    const restoreLock = () => {
      const restore = previous && previous !== ScreenOrientation.OrientationLock.UNKNOWN
        ? previous : ScreenOrientation.OrientationLock.DEFAULT;
      void ScreenOrientation.lockAsync(restore).catch((error) => {
        console.warn('Could not restore the previous orientation lock', error);
      });
    };
    void (async () => {
      const loadedPrefs = await loadGameplayPreferences();
      if (cancelled || !loadedPrefs.startInLandscape) return;
      try {
        previous = await ScreenOrientation.getOrientationLockAsync();
        if (cancelled) return;
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
        locked = true;
        // Exiting while the native promise is pending must not leave the
        // Library locked in landscape after this effect has cleaned up.
        if (cancelled) restoreLock();
      } catch (error) {
        console.warn('Landscape lock unavailable', error);
      }
    })();
    return () => {
      cancelled = true;
      if (!locked) return;
      restoreLock();
    };
  }, []);

  const handleMessage = useCallback((type: string, payload: Record<string, unknown>) => {
    if (type === 'gameplayInterrupted') {
      aggregatorRef.current.releaseAll();
      applySpeed(1);
      return;
    }
    if (type === 'debugStats' && typeof payload.emuFps === 'number') {
      const measured = Math.round(payload.emuFps * 10) / 10;
      latestFpsRef.current = measured;
      // No gameplay-tree rerender for telemetry that is not currently visible.
      if (menuVisibleRef.current) setFps(measured);
    }
    if (type === 'romError') {
      setLoaded(false);
      setStatusText('Could not load ROM — return to Library and try again.');
      setCrashReport({
        category: 'ROM load error',
        stage: String(payload.stage ?? 'rom-read'),
        detail: String(payload.message ?? 'Unknown ROM loading error'),
        platform: Platform.OS,
      });
      return;
    }
    if (type === 'requestSpeedCycle') {
      cycleSpeed();
      return;
    }
    if (type === 'romLoaded') {
      setLoaded(true);
      const mb = payload.sizeMB as string;
      const is64 = payload.is64MB as boolean;
      // Transient toast only — technical info shouldn't live permanently on
      // the console face.
      setStatusText(`${mb}MB${is64 ? ' · 64MB Mode' : ''}`);
      setTimeout(() => setStatusText(''), 2000);
    }
    if (type === 'romHash') {
      const sha256 = String(payload.sha256 ?? '');
      if (/^[a-f0-9]{64}$/.test(sha256)) setRomHash(sha256);
    }
    if (type === 'linkSerialStart') {
      const id = Number(payload.id);
      const data = Number(payload.data);
      if (Number.isInteger(id) && Number.isInteger(data)) {
        linkPlay.sendSerialStart(id, data);
      }
    }
    if (type === 'linkSerialReply') {
      const id = Number(payload.id);
      const data = Number(payload.data);
      if (Number.isInteger(id) && Number.isInteger(data)) {
        linkPlay.sendSerialReply(id, data);
      }
    }
    if (type === 'batterySave') {
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : undefined;
      // A request id is an acknowledgement, not merely metadata. Ignore
      // acknowledgements for an old/timed-out request (and duplicate posts)
      // so a late snapshot cannot resolve a newer exit or overwrite a newer
      // autosave.
      if (requestId) {
        const pending = flushWaitRef.current;
        if (!pending || pending.requestId !== requestId || handledFlushRequestIdsRef.current.has(requestId)) {
          return;
        }
        handledFlushRequestIdsRef.current.add(requestId);
      }
      void persistBatterySave(payload.save as string, requestId);
    }
    if (type === 'saveError') {
      reportSaveError(String(payload.message ?? 'unknown save error'), String(payload.stage ?? 'core'));
    }
    if (type === 'cpuStuck') {
      // Keep only the first report per session — later ones describe the
      // same wedged state and would overwrite the original evidence.
      setCrashReport((prev) => prev ?? payload);
    }
    if (type === 'gpuReport' || type === 'performanceReport') {
      // On-demand diagnostic snapshot — reuse the crash-report overlay to
      // display/share it (user screenshots it for rendering-diff debugging).
      setCrashReport(payload);
      setShowCrashDetail(true);
    }
    if (type === 'saveState') {
      const stateJson = payload.state as string;
      if (romId) {
        saveState(romId, 1, stateJson);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setStatusText('State saved');
        setTimeout(() => setStatusText(''), 1500);
      }
    }
  }, [
    applySpeed,
    cycleSpeed,
    linkPlay.sendSerialReply,
    linkPlay.sendSerialStart,
    persistBatterySave,
    reportSaveError,
    romId,
    saveState,
  ]);

  const handleSaveState = useCallback(() => {
    emulatorRef.current?.saveState();
    setShowMenu(false);
  }, []);

  const handleLoadState = useCallback(async () => {
    if (!romId) return;
    const state = await loadState(romId, 1);
    if (!state) {
      Alert.alert('No Save', 'No save state found for this game.');
      return;
    }
    if (Platform.OS === 'web') {
      emulatorRef.current?.loadState({ json: state.data });
    } else {
      // Write the state to a temp file rather than pushing the ~500KB+
      // JSON string through the WebView bridge directly (see EmulatorWebView
      // for why bulk native->WebView pushes are avoided). This must live
      // under documentDirectory, the same tree as the emulator HTML and ROM
      // files — see EmulatorWebView's EMULATOR_HTML_URI comment for why.
      const uri = `${FileSystem.documentDirectory}gba_state_load.json`;
      await FileSystem.writeAsStringAsync(uri, state.data);
      emulatorRef.current?.loadState({ uri });
    }
    setShowMenu(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setStatusText('State loaded');
    setTimeout(() => setStatusText(''), 1500);
  }, [romId, loadState]);

  const handleReset = useCallback(() => {
    confirmControlReset('Reset Game', 'Reset to the beginning?', () => {
      emulatorRef.current?.reset(); setShowMenu(false);
    });
  }, []);

  const handleGpuDebug = useCallback(() => {
    emulatorRef.current?.requestGpuReport();
    setShowMenu(false);
  }, []);

  /**
   * Leave only after the save carrying this request id has made it through
   * storage. Android hardware back is routed here too; iOS's interactive
   * gesture is disabled for this route because Expo Router does not expose
   * React Navigation's usePreventRemove hook.
   */
  const exitAfterSave = useCallback(async (navigate: () => void) => {
    if (!romId) {
      navigate();
      return;
    }
    // A screen that never finished booting has no dirty cartridge state to
    // flush. Do not make a failed/blank load wait for a core acknowledgement.
    if (!loaded) {
      navigate();
      return;
    }
    if (exitInProgressRef.current) return;
    exitInProgressRef.current = true;

    const requestId = `${romId}:${++flushRequestIdRef.current}`;
    const waitForFlush = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        flushWaitRef.current = null;
        reject(new Error('Timed out waiting for the final battery-save flush.'));
      }, 2000);
      flushWaitRef.current = {
        requestId,
        timer,
        resolve: () => {
          clearTimeout(timer);
          flushWaitRef.current = null;
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          flushWaitRef.current = null;
          reject(error);
        },
      };
    });

    emulatorRef.current?.flushSave(requestId);
    try {
      await waitForFlush;
      navigate();
    } catch (error) {
      exitInProgressRef.current = false;
      Alert.alert(
        'Save not written',
        `The game was not closed so your latest save is safe to retry. ${String(error)}`,
      );
    }
  }, [loaded, romId]);

  const handleExit = useCallback(() => {
    void exitAfterSave(() => router.back());
  }, [exitAfterSave, router]);

  // Native-stack's interactive iOS gesture cannot be paused and replayed
  // after an asynchronous save. The route disables that gesture statically;
  // Android hardware back is cancelable through BackHandler and therefore
  // can use the same correlated flush as the explicit Home buttons.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      void exitAfterSave(() => router.back());
      return true;
    });
    return () => subscription.remove();
  }, [exitAfterSave, router]);

  const handleShareCrashReport = useCallback(() => {
    if (!crashReport) return;
    const text = JSON.stringify(crashReport, null, 2);
    Share.share({ message: text }).catch(() => {});
  }, [crashReport]);


  const toggleMenu = useCallback(() => {
    setFps(latestFpsRef.current);
    setShowMenu((prev) => !prev);
  }, []);

  if (!rom && !isLayoutPreview) {
    return (
      <View style={[styles.errorContainer, { backgroundColor: colors.background }]}>
        <Text style={[styles.errorText, { color: colors.foreground }]}>ROM not found</Text>
        <Pressable onPress={handleExit} style={[styles.errorBtn, { backgroundColor: colors.primary }]}>
          <Text style={{ color: '#fff', fontWeight: '600' }}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  const topInset = Platform.OS === 'web' ? 20 : insets.top;
  const bottomInset = Platform.OS === 'web' ? 24 : insets.bottom;
  const leftInset = Platform.OS === 'web' ? 0 : insets.left;
  const rightInset = Platform.OS === 'web' ? 0 : insets.right;

  // Landscape sizing — explicit pixel dimensions so the GBA screen fits
  // on all phones, including notch/Dynamic-Island devices where one side
  // carries a significant safe-area inset (~59 px on modern iPhones).
  //
  // Key principle: each side column's total width = fixed CONTENT area +
  // its respective inset, so the DPad always has LS_CONTENT px of usable
  // space regardless of notch depth. The screen-width calculation uses
  // the same dynamic side widths for consistency.
  const GBA_ASPECT = 240 / 160; // 3 : 2
  const LS_CONTENT = 160; // guaranteed control content width (DPad is 150 px)
  const lsLeftW = LS_CONTENT + Math.max(leftInset, 12);
  const lsRightW = LS_CONTENT + Math.max(rightInset, 12);
  // Bottom bar: paddingTop(4) + tallest element MenuButton(44 px) + paddingBottom
  const lsBottomH = 4 + 44 + Math.max(bottomInset, 6);
  const lsAvailH = winHeight - lsBottomH;
  const lsAvailCenterW = winWidth - lsLeftW - lsRightW;
  const lsByWidth = { w: lsAvailCenterW, h: lsAvailCenterW / GBA_ASPECT };
  const lsByHeight = { w: lsAvailH * GBA_ASPECT, h: lsAvailH };
  // Largest 3:2 rectangle fitting both width and height constraints:
  const lsScreen = lsByWidth.h <= lsAvailH ? lsByWidth : lsByHeight;

  // These overlays are limited to transient status/debug information. Game
  // controls live below the screen so they never intercept gameplay touches.
  const screenOverlays = (
    <>
      {statusText ? (
        <View style={styles.statusBadge} pointerEvents="none">
          <Text style={styles.statusText}>{statusText}</Text>
        </View>
      ) : null}

      {crashReport && !showCrashDetail ? (
        <Pressable onPress={() => setShowCrashDetail(true)} style={styles.crashBadge}>
          <Ionicons name="warning-outline" size={13} color="#FCA5A5" />
          <Text style={styles.crashBadgeText}>
            {String(crashReport.category ?? 'cpu stuck')} · tap for details
          </Text>
        </Pressable>
      ) : null}

      {crashReport && showCrashDetail ? (
        <View style={styles.crashOverlay}>
          <View style={styles.crashHeader}>
            <Text style={styles.crashTitle}>
              {crashReport?.type === 'performanceReport' ? 'Performance report'
                : crashReport?.type === 'gpuReport' ? 'Graphics report' : 'Emulator crash report'}
            </Text>
            <View style={styles.crashHeaderBtns}>
              <Pressable onPress={handleShareCrashReport} style={styles.crashHeaderBtn}>
                <Ionicons name="share-outline" size={16} color="#fff" />
              </Pressable>
              <Pressable onPress={() => setShowCrashDetail(false)} style={styles.crashHeaderBtn}>
                <Ionicons name="close" size={16} color="#fff" />
              </Pressable>
            </View>
          </View>
          <ScrollView style={styles.crashBody}>
            <Text selectable style={styles.crashText}>
              {JSON.stringify(crashReport, null, 2)}
            </Text>
          </ScrollView>
        </View>
      ) : null}
    </>
  );

  // The menu is anchored to the utility buttons rather than the game surface.
  // A bounded ScrollView keeps the full action list reachable on short screens.
  const menuPanel = showMenu ? (
    <Modal transparent visible animationType="none" onRequestClose={() => setShowMenu(false)}>
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center',
        paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8,
        paddingLeft: insets.left + 8, paddingRight: insets.right + 8 }}>
        <Pressable accessibilityLabel="Close game menu" style={StyleSheet.absoluteFill} onPress={() => setShowMenu(false)} />
        <View style={{ width: Math.min(280, winWidth - insets.left - insets.right - 16),
          maxHeight: Math.max(80, winHeight - insets.top - insets.bottom - 16),
          backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 14, overflow: 'hidden' }}>
      <ScrollView
        style={{ flexShrink: 1 }}
        contentContainerStyle={styles.floatingMenuContent}
        showsVerticalScrollIndicator
        nestedScrollEnabled
      >
        <Text numberOfLines={2} style={[styles.menuItemText, { color: colors.mutedForeground, fontSize: 12, paddingHorizontal: 16, paddingVertical: 10 }]}>
          {speed === 1 ? 'Normal: 1×' : `Fast-forward: ${speed}× target`}
          {' · '}{fps === null ? 'Measuring…' : `${(fps / 59.7275).toFixed(2)}× actual · ${fps.toFixed(1)} FPS`}
        </Text>
        <View style={[styles.menuDivider, { backgroundColor: colors.border }]} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save state"
          onPress={handleSaveState}
          style={styles.floatingMenuItem}
        >
          <Ionicons name="save-outline" size={16} color={colors.primary} />
          <Text style={[styles.menuItemText, { color: colors.foreground }]}>Save State</Text>
        </Pressable>
        <View style={[styles.menuDivider, { backgroundColor: colors.border }]} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Load state"
          onPress={handleLoadState}
          style={styles.floatingMenuItem}
        >
          <Ionicons name="cloud-download-outline" size={16} color={colors.accent} />
          <Text style={[styles.menuItemText, { color: colors.foreground }]}>Load State</Text>
        </Pressable>
        <View style={[styles.menuDivider, { backgroundColor: colors.border }]} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset game"
          onPress={handleReset}
          style={styles.floatingMenuItem}
        >
          <Ionicons name="refresh-outline" size={16} color={colors.mutedForeground} />
          <Text style={[styles.menuItemText, { color: colors.foreground }]}>Reset</Text>
        </Pressable>
        <View style={[styles.menuDivider, { backgroundColor: colors.border }]} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open Link Play"
          onPress={() => {
            setShowMenu(false);
            setShowLinkPlay(true);
          }}
          style={styles.floatingMenuItem}
        >
          <Ionicons name="git-network-outline" size={16} color={colors.accent} />
          <Text style={[styles.menuItemText, { color: colors.foreground }]}>Link Play</Text>
        </Pressable>
        <View style={[styles.menuDivider, { backgroundColor: colors.border }]} />
        <Pressable accessibilityRole="button" accessibilityLabel="Open performance diagnostics"
          onPress={() => { emulatorRef.current?.requestPerformanceReport(); setShowMenu(false); }}
          style={styles.floatingMenuItem}>
          <Ionicons name="speedometer-outline" size={16} color={colors.mutedForeground} />
          <Text style={[styles.menuItemText, { color: colors.foreground }]}>Performance</Text>
        </Pressable>
        <View style={[styles.menuDivider, { backgroundColor: colors.border }]} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open GPU debug"
          onPress={handleGpuDebug}
          style={styles.floatingMenuItem}
        >
          <Ionicons name="bug-outline" size={16} color={colors.mutedForeground} />
          <Text style={[styles.menuItemText, { color: colors.foreground }]}>GPU Debug</Text>
        </Pressable>
        <View style={[styles.menuDivider, { backgroundColor: colors.border }]} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Exit game"
          onPress={handleExit}
          style={styles.floatingMenuItem}
        >
          <Ionicons name="arrow-back-outline" size={16} color={colors.destructive} />
          <Text style={[styles.menuItemText, { color: colors.destructive }]}>Exit</Text>
        </Pressable>
      </ScrollView>
        </View>
      </View>
    </Modal>
  ) : null;

  // ── UNIFIED single-tree layout ─────────────────────────────────────────────
  // Portrait and landscape share one JSX tree so <EmulatorWebView> is never
  // unmounted on rotation — it is always the same component-tree node (the
  // key="screen" wrapper tells React to preserve it even when sibling elements
  // appear/disappear around it as isLandscape changes).
  //
  // Structure:
  //   root
  //     [portrait] brand footer
  //     mainRow  (flexDirection: row in landscape, column in portrait)
  //       [landscape] lsSideCol — L button + D-pad
  //       centerCol   — holds the WebView + all portrait controls / ls bottom bar
  //         key="screen" wrapper ← WebView always lives HERE, never moves
  //         [portrait] utility row (home + menu), shoulders, D-pad + A/B,
  //                    fast-forward + select/start
  //         [landscape] fast-forward + select/start + home/menu bottom bar
  //       [landscape] lsSideCol — R button + A/B
  return (
    <GameplayControlsProvider enabled={gameplayInputEnabled}>
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {!isLandscape && (
        <Text
          style={[styles.brandFooter, { bottom: Math.max(bottomInset - 14, 4) }]}
          pointerEvents="none"
        >
          Zenulator
        </Text>
      )}

      {/* Main row — switches flex direction on rotation */}
      <View
        style={[
          styles.mainRow,
          isLandscape
            ? { flexDirection: 'row', backgroundColor: '#0B0B0F' }
            : {
                flexDirection: 'column',
                alignItems: 'center',
                marginTop: topInset + 6,
                marginBottom: bottomInset + 8,
              },
        ]}
      >
        {/* LEFT COLUMN — landscape only: L button + D-pad.
            Width = LS_CONTENT + left safe-area inset so DPad always has
            LS_CONTENT px of usable space on notched devices. */}
        {isLandscape && (
          <View key="ls-left" style={[styles.lsSideCol, { width: lsLeftW, paddingLeft: Math.max(leftInset, 12) }]}>
            <LButton onKeyChange={handleKey} layout={layoutSet.l} />
            <DPad onKeyChange={handleKey} layout={layoutSet.dpad} />
          </View>
        )}

        {/* CENTER COLUMN — always present; contains the WebView.
            key="center" is the critical guarantee: React reconciles this
            element by key, not by position index, so it is never unmounted
            when the landscape side columns appear/disappear around it.
            key="screen" on the inner wrapper is a belt-and-suspenders guard. */}
        <View key="center" style={isLandscape ? styles.lsCenterCol : styles.portraitBody}>

          {/* Game screen — always the FIRST child of this column.
              Landscape: explicit pixel dimensions so the screen fits both
              the center column width and the available height on all phone
              sizes (flex:1+aspectRatio would overflow narrow phones). */}
          <View
            key="screen"
            style={
              isLandscape
                ? {
                    width: Math.round(lsScreen.w),
                    height: Math.round(lsScreen.h),
                    position: 'relative',
                    backgroundColor: '#000',
                    overflow: 'hidden',
                  }
                : styles.screenWrap
            }
          >
            <EmulatorWebView ref={emulatorRef} onMessage={handleMessage} onReady={handleReady} />
            {screenOverlays}
          </View>

          {/* Portrait only: control deck below the screen. Utility actions are
              centered immediately below the game, above the shoulders. */}
          {!isLandscape && (
            <View style={styles.shell}>
              <View style={styles.utilityAnchor}>
                <View style={styles.utilityRow}>
                  <View style={styles.utilityRowSpacer} />
                  <View style={styles.utilityPair}>
                    <HomeButton onPress={handleExit} />
                    <MenuToggleButton open={showMenu} onPress={toggleMenu} />
                  </View>
                  <View style={styles.utilityRowSpacer} />
                </View>
                {menuPanel}
              </View>
              <View style={styles.shoulderRow}>
                <ShoulderButtons onKeyChange={handleKey} lLayout={layoutSet.l} rLayout={layoutSet.r} />
              </View>
              <View style={styles.controlRow}>
                <DPad onKeyChange={handleKey} layout={layoutSet.dpad} />
                <ABButtons onKeyChange={handleKey} layout={layoutSet.ab} />
              </View>
              <View style={styles.bottomRow}>
                <SpeedButton speed={speed} onPress={cycleSpeed} />
                <MenuButtons onKeyChange={handleKey} layout={layoutSet.startSelect} />
                <View style={{ width: 44 }} pointerEvents="none" />
              </View>
            </View>
          )}

          {/* Landscape only: all utility actions stay in the centered bottom
              bar, outside the game screen and clear of the side controls. */}
          {isLandscape && (
            <View style={[styles.lsBottomBar, { paddingBottom: Math.max(bottomInset, 6) }]}>
              <SpeedButton speed={speed} onPress={cycleSpeed} />
              <MenuButtons onKeyChange={handleKey} layout={layoutSet.startSelect} />
              <View style={styles.utilityAnchor}>
                <View style={styles.utilityPair}>
                  <HomeButton onPress={handleExit} />
                  <MenuToggleButton open={showMenu} onPress={toggleMenu} />
                </View>
                {menuPanel}
              </View>
            </View>
          )}
        </View>

        {/* RIGHT COLUMN — landscape only: R button + A/B.
            Width = LS_CONTENT + right safe-area inset. */}
        {isLandscape && (
          <View key="ls-right" style={[styles.lsSideCol, { width: lsRightW, paddingRight: Math.max(rightInset, 12) }]}>
            <RButton onKeyChange={handleKey} layout={layoutSet.r} />
            <ABButtons onKeyChange={handleKey} layout={layoutSet.ab} />
          </View>
        )}
      </View>

      <LinkPlayPanel
        visible={showLinkPlay}
        status={linkPlay.status}
        roomCode={linkPlay.roomCode}
        role={linkPlay.role}
        message={linkPlay.message}
        romReady={!!romHash && loaded}
        onClose={() => setShowLinkPlay(false)}
        onCreate={linkPlay.createRoom}
        onJoin={linkPlay.joinRoom}
        onLeave={linkPlay.leaveRoom}
      />
    </View>
    </GameplayControlsProvider>
  );
}

const styles = StyleSheet.create({
  // ── Shared / structural ───────────────────────────────────────────────────
  mainRow: {
    flex: 1,
  },

  // ── Landscape (Delta-style) styles ────────────────────────────────────────
  lsSideCol: {
    // width is passed inline as lsLeftW / lsRightW (= LS_CONTENT + safe inset)
    // so DPad always has LS_CONTENT px of usable space on notched devices.
    flexDirection: 'column',
    justifyContent: 'space-evenly',
    alignItems: 'center',
    paddingVertical: 10,
    backgroundColor: '#1A1A1E',
  },
  lsCenterCol: {
    // In landscape the center column flexes to fill space between side panels.
    // The screen View inside uses explicit pixel dimensions (not flex:1+aspectRatio)
    // so it never overflows the column's constrained width on small phones.
    flex: 1,
    flexDirection: 'column',
    alignItems: 'center',   // centre screen horizontally
    justifyContent: 'center', // centre screen vertically above bottom bar
    backgroundColor: '#000',
  },
  lsBottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingTop: 4,
    backgroundColor: '#1A1A1E',
    overflow: 'visible',
  },

  // ── Portrait styles ───────────────────────────────────────────────────────
  // Centre column in portrait: same dark-gray console body with rounded
  // corners that the original layout had.
  portraitBody: {
    width: '100%',
    flex: 1,
    backgroundColor: '#2C2C2E',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.6,
    shadowRadius: 12,
    elevation: 10,
  },
  brandFooter: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    color: 'rgba(255,255,255,0.28)',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 3,
    textTransform: 'uppercase',
  },
  screenWrap: {
    width: '100%',
    aspectRatio: 240 / 160,
    position: 'relative',
    backgroundColor: '#000',
    borderBottomLeftRadius: 14,
    borderBottomRightRadius: 14,
    overflow: 'hidden',
  },
  shell: {
    flex: 1,
    backgroundColor: '#2C2C2E',
    paddingTop: 16,
    paddingBottom: 14,
    justifyContent: 'space-evenly',
  },
  shoulderRow: {
    zIndex: 10,
  },
  utilityAnchor: {
    position: 'relative',
    alignItems: 'center',
    zIndex: 30,
  },
  utilityRow: {
    width: '100%',
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  utilityPair: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  utilityRowSpacer: {
    flex: 1,
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 18,
    paddingHorizontal: 22,
  },
  statusBadge: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  statusText: {
    color: '#A78BFA',
    fontSize: 11,
    fontWeight: '500',
  },
  crashBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(127,29,29,0.85)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    zIndex: 25,
  },
  crashBadgeText: {
    color: '#FCA5A5',
    fontSize: 11,
    fontWeight: '600',
  },
  crashOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.92)',
    zIndex: 40,
  },
  crashHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.2)',
  },
  crashTitle: {
    color: '#FCA5A5',
    fontSize: 13,
    fontWeight: '700',
  },
  crashHeaderBtns: {
    flexDirection: 'row',
    gap: 8,
  },
  crashHeaderBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  crashBody: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  crashText: {
    color: '#E5E7EB',
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  floatingMenu: {
    position: 'absolute',
    top: 50,
    alignSelf: 'center',
    width: 224,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
    zIndex: 30,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 8,
  },
  floatingMenuAbove: {
    top: undefined,
    bottom: 48,
  },
  floatingMenuContent: {
    paddingVertical: 2,
  },
  floatingMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  menuItemText: {
    fontSize: 14,
    fontWeight: '500',
  },
  menuDivider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 12,
  },
  controlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 30,
  },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  errorText: {
    fontSize: 18,
    fontWeight: '600',
  },
  errorBtn: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
  },
});
