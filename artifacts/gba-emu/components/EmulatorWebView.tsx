import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import * as FileSystem from 'expo-file-system/legacy';
import { GBA_EMULATOR_HTML } from '@/emulator/html';

export type DataSource = { uri: string; saveUri?: string } | { base64: string; save?: string };
export type StateSource = { uri: string } | { json: string };

export interface EmulatorRef {
  sendKey: (key: string, pressed: boolean) => void;
  /**
   * Load a ROM. Prefer `{ uri }` (a local file:// path) on native — the
   * WebView fetches the bytes itself with no data crossing the RN bridge.
   * `{ base64 }` is a web-only fallback (no native bridge there).
   */
  loadROM: (source: DataSource) => void;
  saveState: () => void;
  /** Load a saved state. Prefer `{ uri }` on native, `{ json }` on web. */
  loadState: (source: StateSource) => void;
  reset: () => void;
  /** Force an immediate battery-save flush (posted back as a batterySave message). */
  flushSave: (requestId?: string) => void;
  /** Emulation speed: frames per render tick (1 = normal, 3 = fast-forward). */
  setFastForward: (factor: number) => void;
  requestGpuReport: () => void;
  requestPerformanceReport: () => void;
  /** Saved keyboard/controller bindings for in-page keyboard + Gamepad API (see library/inputMapping). */
  setInputMap: (message: { type: 'setInputMap'; keyboard: Record<string, string>; gamepad: Record<string, string>; keyboardInCore: boolean }) => void;
  /** Release every key held by any source inside the core (menu open, blur). */
  releaseAllKeys: () => void;
  /** Suppress in-core keyboard/Gamepad API input (menus, modals). */
  setInputEnabled: (enabled: boolean) => void;
  /** Configure the virtual GBA cable after a private room connects. */
  setLinkSession: (connected: boolean, playerId: number) => void;
  receiveLinkStart: (id: number) => void;
  receiveLinkComplete: (id: number, words: number[]) => void;
  abortLinkTransfer: () => void;
}

interface Props {
  onMessage?: (type: string, payload: Record<string, unknown>) => void;
  /** Called once the WebView has finished loading and signalled readiness. */
  onReady?: () => void;
}

const CHUNK_CHARS = 524288; // 512 KB of base64 text per chunk — web-only fallback path
const WEB_EMULATOR_HTML = GBA_EMULATOR_HTML.replace(
  '<script>',
  `<script>
window.ReactNativeWebView = {
  postMessage: function (data) { window.parent.postMessage(data, '*'); }
};`,
);

// On iOS, WKWebView only grants a loaded file:// document read access to
// its OWN containing directory (and that directory's subtree) by default —
// it does NOT automatically extend that to sibling directories elsewhere in
// the sandbox. Imported ROMs live under documentDirectory (Documents/
// gba_roms/) and save-state temp files are also written under
// documentDirectory, so the emulator HTML must be written into
// documentDirectory too (not cacheDirectory) — that way everything the
// WebView will ever `fetch()` shares one directory tree and is covered by
// WKWebView's default same-directory grant, with no dependency on React
// Native's prop-application order for `allowingReadAccessToURL` (which is
// NOT guaranteed to apply before `source`, and previously caused a
// generic, undebuggable WebKit "Load failed" for cross-directory fetches).
// `allowingReadAccessToURL` is still passed below as a defense-in-depth
// widening to the whole sandbox container, but the directory-colocation is
// the fix that doesn't depend on native prop ordering.
const EMULATOR_HTML_URI = FileSystem.documentDirectory + 'gba_emulator.html';
const IOS_CONTAINER_ROOT = FileSystem.documentDirectory?.replace(/Documents\/?$/, '') ?? undefined;

// On iOS/Android, both react-native-webview's postMessage() and a hand-rolled
// injectJavaScript() ultimately push the payload into the WebView via a
// native evaluateJavaScript-style call routed through a TurboModule method
// invocation. Pushing a multi-MB string through that channel has caused a
// real native crash (an NSException thrown mid-invocation, then a second
// crash while React Native tried to convert it into a JS Error). Fix: never
// push bulk data through the bridge. Instead write it to a local file and
// have the WebView fetch it itself. For that fetch to succeed same-origin
// (no CORS block), the WebView's own document must also be loaded from a
// local file:// URI rather than an inline HTML string.
async function ensureEmulatorHtmlFile(): Promise<string> {
  await FileSystem.writeAsStringAsync(EMULATOR_HTML_URI, GBA_EMULATOR_HTML);
  return EMULATOR_HTML_URI;
}

const EmulatorWebView = forwardRef<EmulatorRef, Props>(({ onMessage, onReady }, ref) => {
  const webviewRef = useRef<WebView>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const pendingRom = useRef<DataSource | null>(null);
  // Fast-forward taps made before the WebView signals readiness would
  // silently vanish (the UI would show 3x while the core runs 1x) — queue
  // the latest requested factor and replay it once ready.
  const pendingFastForward = useRef<number | null>(null);
  const pendingInputMap = useRef<Parameters<EmulatorRef['setInputMap']>[0] | null>(null);
  const [htmlUri, setHtmlUri] = useState<string | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const readyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const romTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearLoadTimers() {
    if (readyTimer.current) clearTimeout(readyTimer.current);
    if (romTimer.current) clearTimeout(romTimer.current);
    readyTimer.current = null;
    romTimer.current = null;
  }

  function reportLoadError(message: string, stage: string) {
    clearLoadTimers();
    onMessageRef.current?.('romError', { message, stage });
  }

  useEffect(() => () => clearLoadTimers(), []);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    let cancelled = false;
    readyTimer.current = setTimeout(() => {
      if (!cancelled && !readyRef.current) {
        reportLoadError('The emulator did not finish starting. Return to the Library and try again.', 'webview-ready');
      }
    }, 20_000);
    ensureEmulatorHtmlFile().then((uri) => {
      if (!cancelled) setHtmlUri(uri);
    }).catch((error: unknown) => {
      if (!cancelled) reportLoadError(`Could not prepare the emulator: ${String(error)}`, 'html-write');
    });
    return () => { cancelled = true; clearLoadTimers(); };
  }, []);

  function postMsg(data: object) {
    if (Platform.OS === 'web') {
      iframeRef.current?.contentWindow?.postMessage(JSON.stringify(data), '*');
      return;
    }
    webviewRef.current?.postMessage(JSON.stringify(data));
  }

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (!readyRef.current) return;
      postMsg({ type: 'nativeAudioState', active: state === 'active', silentPlayback: Platform.OS === 'ios' });
      if (state !== 'active') postMsg({ type: 'flushSave' });
    });
    return () => subscription.remove();
  }, []);

  // Web-only fallback: no native bridge exists there (WebView is a plain
  // iframe), so chunked postMessage is safe for large payloads.
  function sendRomChunked(base64: string) {
    const total = Math.ceil(base64.length / CHUNK_CHARS);
    postMsg({ type: 'romStart', total });
    let i = 0;
    function sendNext() {
      if (i >= total) return;
      postMsg({ type: 'romChunk', index: i, data: base64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS), total });
      i++;
      // Tiny yield so the JS thread can breathe between chunks
      setTimeout(sendNext, 0);
    }
    sendNext();
  }

  function doLoadROM(source: DataSource) {
    if (romTimer.current) clearTimeout(romTimer.current);
    romTimer.current = setTimeout(() => {
      reportLoadError('ROM loading timed out. Return to the Library and try again.', 'rom-load-timeout');
    }, 75_000);
    if ('uri' in source) {
      // saveUri points at the persisted battery-save file (if any); the
      // WebView fetches and applies it itself right after the ROM boots.
      postMsg({ type: 'loadRomFile', uri: source.uri, saveUri: source.saveUri });
    } else {
      sendRomChunked(source.base64);
      // Web fallback: battery save is small enough to send inline.
      if (source.save) postMsg({ type: 'loadSave', save: source.save });
    }
  }

  useImperativeHandle(ref, () => ({
    sendKey(key, pressed) {
      postMsg({ type: pressed ? 'keydown' : 'keyup', key });
    },
    loadROM(source) {
      if (!readyRef.current) {
        // Emulator not ready yet — queue it; onMessage handler will drain
        pendingRom.current = source;
        return;
      }
      doLoadROM(source);
    },
    saveState() { postMsg({ type: 'saveState' }); },
    loadState(source) {
      if ('uri' in source) postMsg({ type: 'loadStateFile', uri: source.uri });
      else postMsg({ type: 'loadState', state: source.json });
    },
    reset() { postMsg({ type: 'reset' }); },
    flushSave(requestId) { postMsg({ type: 'flushSave', requestId }); },
    requestGpuReport() { postMsg({ type: 'readGpu' }); },
    requestPerformanceReport() { postMsg({ type: 'getPerformance' }); },
    setInputMap(message) {
      if (!readyRef.current) { pendingInputMap.current = message; return; }
      postMsg(message);
    },
    releaseAllKeys() { postMsg({ type: 'releaseAllKeys' }); },
    setInputEnabled(enabled) { postMsg({ type: 'setInputEnabled', enabled }); },
    setFastForward(factor) {
      if (!readyRef.current) { pendingFastForward.current = factor; return; }
      postMsg({ type: 'setFastForward', factor });
    },
    setLinkSession(connected, playerId) {
      postMsg({ type: 'setLinkSession', connected, playerId });
    },
    receiveLinkStart(id) {
      postMsg({ type: 'linkRemoteStart', id });
    },
    receiveLinkComplete(id, words) {
      postMsg({ type: 'linkRemoteComplete', id, words });
    },
    abortLinkTransfer() {
      postMsg({ type: 'linkRemoteAbort' });
    },
  }));

  function handleRawMessage(raw: string) {
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      const type = data.type as string;

      if (type === 'ready') {
        if (readyTimer.current) clearTimeout(readyTimer.current);
        readyTimer.current = null;
        readyRef.current = true;
        // Android FF can continue bounded outstanding work between display
        // ticks. Keep this native-only policy out of browser/iOS scheduling.
        postMsg({ type: 'setHostPlatform', platform: Platform.OS });
        if (Platform.OS !== 'web') {
          postMsg({
            type: 'nativeAudioState',
            active: AppState.currentState == null || AppState.currentState === 'active',
            silentPlayback: Platform.OS === 'ios',
          });
        }
        onReady?.();
        // Drain any queued ROM
        if (pendingRom.current) {
          const rom = pendingRom.current;
          pendingRom.current = null;
          doLoadROM(rom);
        }
        if (pendingInputMap.current) {
          postMsg(pendingInputMap.current);
          pendingInputMap.current = null;
        }
        if (pendingFastForward.current !== null) {
          postMsg({ type: 'setFastForward', factor: pendingFastForward.current });
          pendingFastForward.current = null;
        }
        return;
      }

      if (type === 'romLoaded' || type === 'romError') clearLoadTimers();
      onMessageRef.current?.(type, data);
    } catch {}
  }

  function handleMessage(e: WebViewMessageEvent) {
    handleRawMessage(e.nativeEvent.data);
  }

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handleWindowMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || typeof event.data !== 'string') {
        return;
      }
      handleRawMessage(event.data);
    };
    window.addEventListener('message', handleWindowMessage);
    return () => window.removeEventListener('message', handleWindowMessage);
  });

  // On native, wait for the local HTML file to be written before mounting
  // the WebView so its `source.uri` is ready — the document must load from
  // a file:// origin for same-origin ROM/state fetches to succeed. Web has
  // no such local-file model, so it mounts immediately with inline HTML.
  if (Platform.OS !== 'web' && !htmlUri) {
    return <View style={styles.container} />;
  }

  if (Platform.OS === 'web') {
    return (
      <View style={styles.container}>
        {React.createElement('iframe', {
          ref: iframeRef,
          srcDoc: WEB_EMULATOR_HTML,
          // The emulator HTML is trusted static app code. Keeping its srcDoc
          // same-origin preserves the HTTPS secure context required by
          // crypto.subtle for the exact-ROM Link Play compatibility hash.
          sandbox: 'allow-scripts allow-same-origin',
          allow: 'autoplay; gamepad',
          title: 'GBA emulator screen',
          style: {
            width: '100%',
            height: '100%',
            border: 0,
            display: 'block',
            backgroundColor: '#000',
          },
        })}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <WebView
        ref={webviewRef}
        source={{ uri: htmlUri! }}
        style={styles.webview}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        onMessage={handleMessage}
        onError={(event) => reportLoadError(event.nativeEvent.description, 'webview-load')}
        onHttpError={(event) => reportLoadError(`Emulator page returned HTTP ${event.nativeEvent.statusCode}.`, 'webview-http')}
        onRenderProcessGone={() => {
          readyRef.current = false;
          reportLoadError('Android stopped the emulator WebView. Return to the Library and try again.', 'webview-process');
        }}
        onContentProcessDidTerminate={() => {
          readyRef.current = false;
          reportLoadError('The emulator WebView stopped. Return to the Library and try again.', 'webview-process');
        }}
        javaScriptEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        originWhitelist={['*']}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        allowingReadAccessToURL={Platform.OS === 'ios' ? IOS_CONTAINER_ROOT : undefined}
        domStorageEnabled
      />
    </View>
  );
});

EmulatorWebView.displayName = 'EmulatorWebView';
export default EmulatorWebView;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  webview: { flex: 1, backgroundColor: '#000' },
});
