import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import {
  ArrowLeft,
  Cable,
  Download,
  Keyboard,
  Maximize,
  Monitor,
  RotateCcw,
  Save,
  Upload,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useLinkPlay } from '@/hooks/useLinkPlay';
import { db, type Game, type SaveState } from '@/lib/db';
import { deviceLibrary, reconcileGameMetadata } from '@/lib/deviceLibrary';
import { GBA_EMULATOR_HTML } from '@/lib/emulatorHtml';
import {
  actionForCode,
  isGameKey,
  loadBindings,
  saveBindings,
  coreInputMapMessage,
  type StoredBindings,
} from '@/lib/keyboardRouting';
import { InputMappingDialog } from '@/components/InputMappingDialog';

const SPEED_STORAGE_KEY = 'zenulator-web:speed:v1';
type Speed = 1 | 2 | 3;
function loadSpeed(): Speed {
  try {
    const value = Number(localStorage.getItem(SPEED_STORAGE_KEY));
    return value === 2 || value === 3 ? value : 1;
  } catch {
    return 1;
  }
}
import { validateBatterySave, validateSaveState } from '@/lib/saveValidation';
import { chooseStateRecovery } from '@/lib/recoveryChoice';

interface RomSource {
  romUrl: string;
  saveUrl?: string;
}

interface BackupFile {
  app: 'zenulator-web';
  version: 1;
  romHash: string;
  gameName: string;
  exportedAt: number;
  batterySave: string | null;
  states: Array<{ slot: number; timestamp: number; data: string }>;
}

const MAX_BACKUP_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_STATES = 10;
const MAX_BACKUP_SAVE_CHARS = 2 * 1024 * 1024;
const MAX_BACKUP_STATE_CHARS = 16 * 1024 * 1024;

function isEditableControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'a[href], button, input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="menuitem"], [role="option"]',
    ),
  );
}

function sameBuffer(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.every((value, index) => value === b[index]);
}

function parseBackup(value: unknown, expectedRomHash: string): BackupFile {
  if (!value || typeof value !== 'object') {
    throw new Error('This file is not a Zenulator backup.');
  }
  const backup = value as Partial<BackupFile>;
  if (
    backup.app !== 'zenulator-web' ||
    backup.version !== 1 ||
    backup.romHash !== expectedRomHash ||
    typeof backup.gameName !== 'string' ||
    backup.gameName.length > 512 ||
    !Number.isInteger(backup.exportedAt) ||
    Number(backup.exportedAt) < 0 ||
    !Array.isArray(backup.states) ||
    (backup.batterySave !== null && typeof backup.batterySave !== 'string')
  ) {
    throw new Error('This backup belongs to a different ROM or is not a Zenulator backup.');
  }
  if (typeof backup.batterySave === 'string' && backup.batterySave.length > MAX_BACKUP_SAVE_CHARS) {
    throw new Error('The battery save in this backup is too large.');
  }
  if (typeof backup.batterySave === 'string') validateBatterySave(backup.batterySave);
  if (backup.states.length > MAX_BACKUP_STATES) {
    throw new Error(`A backup can contain at most ${MAX_BACKUP_STATES} save states.`);
  }

  const slots = new Set<number>();
  for (const state of backup.states) {
    if (
      !state ||
      typeof state !== 'object' ||
      !Number.isInteger(state.slot) ||
      state.slot < 1 ||
      state.slot > MAX_BACKUP_STATES ||
      slots.has(state.slot) ||
      !Number.isFinite(state.timestamp) ||
      state.timestamp < 0 ||
      typeof state.data !== 'string' ||
      state.data.length === 0 ||
      state.data.length > MAX_BACKUP_STATE_CHARS
    ) {
      throw new Error('This backup contains an invalid save state.');
    }
    slots.add(state.slot);
    validateSaveState(state.data);
  }
  return backup as BackupFile;
}

function downloadText(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function PlayRoute() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const pressedKeysRef = useRef(new Set<string>());
  const linkPlayDialogOpenRef = useRef(false);
  const sessionStartedRef = useRef(0);

  const [game, setGame] = useState<Game | null>(null);
  const [error, setError] = useState('');
  const [statusNotice, setStatusNotice] = useState({
    text: 'Preparing emulator…',
    autoDismiss: false,
  });
  const [statusFading, setStatusFading] = useState(false);
  const statusText = statusNotice.text;
  const setStatusText = useCallback((text: string, autoDismiss = false) => {
    setStatusFading(false);
    setStatusNotice({ text, autoDismiss });
  }, []);
  useEffect(() => {
    if (!statusNotice.text || !statusNotice.autoDismiss) return;
    const fadeTimer = window.setTimeout(() => setStatusFading(true), 10_000);
    const clearTimer = window.setTimeout(() => {
      setStatusNotice({ text: '', autoDismiss: false });
    }, 10_400);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(clearTimer);
    };
  }, [statusNotice]);
  const [isReady, setIsReady] = useState(false);
  const [romSource, setRomSource] = useState<RomSource | null>(null);
  const [coreRomHash, setCoreRomHash] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [speed, setSpeedState] = useState<Speed>(loadSpeed);
  const speedRef = useRef(speed);
  const [bindings, setBindingsState] = useState<StoredBindings>(() => loadBindings());
  const bindingsRef = useRef(bindings);
  const keyCodeHeldRef = useRef(new Map<string, string>());
  const [controlsDialogOpen, setControlsDialogOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [recoveryPrompt, setRecoveryPrompt] = useState('');
  const [useBrowserRecovery, setUseBrowserRecovery] = useState(false);
  const [folderWriteError, setFolderWriteError] = useState('');
  const [linkPlayDialogOpen, setLinkPlayDialogOpen] = useState(false);

  const postToCore = useCallback((message: object) => {
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify(message), '*');
  }, []);

  const releaseAllKeys = useCallback(() => {
    for (const key of pressedKeysRef.current) {
      postToCore({ type: 'keyup', key });
    }
    pressedKeysRef.current.clear();
    keyCodeHeldRef.current.clear();
    postToCore({ type: 'releaseAllKeys' });
  }, [postToCore]);

  // Real pacing factor in the shared core, persisted across sessions.
  const setSpeed = useCallback((next: Speed) => {
    speedRef.current = next;
    setSpeedState(next);
    postToCore({ type: 'setFastForward', factor: next });
    try { localStorage.setItem(SPEED_STORAGE_KEY, String(next)); } catch { /* private mode */ }
  }, [postToCore]);
  const cycleSpeed = useCallback(() => {
    const current = speedRef.current;
    setSpeed(current === 1 ? 2 : current === 2 ? 3 : 1);
  }, [setSpeed]);

  const setBindings = useCallback((next: StoredBindings) => {
    bindingsRef.current = next;
    setBindingsState(next);
    try { saveBindings(next); } catch { /* storage full or blocked */ }
    postToCore(coreInputMapMessage(next.keyboard, next.gamepad, false));
  }, [postToCore]);

  const focusGame = useCallback(() => {
    // A toolbar action can finish after the user has opened Link Play again.
    // Never steal focus from the dialog's focus trap or its text input.
    if (linkPlayDialogOpenRef.current) return;
    requestAnimationFrame(() => {
      if (linkPlayDialogOpenRef.current) return;
      iframeRef.current?.focus({ preventScroll: true });
    });
  }, []);

  const linkPlay = useLinkPlay({ romHash: coreRomHash, iframeRef });
  const linkPlayRef = useRef(linkPlay);
  useEffect(() => {
    linkPlayRef.current = linkPlay;
  }, [linkPlay]);

  useEffect(() => {
    let active = true;
    let localRomUrl: string | undefined;
    let localSaveUrl: string | undefined;

    async function loadGame() {
      try {
        if (!id) throw new Error('No game ID was provided.');
        const storedGame = await db.getGame(id);
        const browserSave = storedGame ? await db.getSave(id) : null;
        const browserStates = storedGame ? await db.getStatesForGame(id) : [];
        let linked: Awaited<ReturnType<typeof deviceLibrary.readForPlay>> = null;
        if (!useBrowserRecovery) {
          try {
            linked = await deviceLibrary.readForPlay(id);
          } catch (folderError) {
            if (!storedGame) throw folderError;
            const message = `The linked folder could not be read: ${folderError instanceof Error ? folderError.message : 'unknown error'}. Browser recovery data is available.`;
            await deviceLibrary.markBrowserRecoveryConflict(id, message);
            setRecoveryPrompt(message);
            setStatusText(message);
            return;
          }
        }
        if (!storedGame && !linked) throw new Error('This game is not in the local library.');
        if (!useBrowserRecovery && linked && browserSave?.data && linked.save !== browserSave.data) {
          const message = 'The linked battery save differs from browser recovery data. Choose which copy to use before playing.';
          await deviceLibrary.markBrowserRecoveryConflict(id, message);
          setRecoveryPrompt(message);
          setStatusText(message);
          return;
        }
        if (!useBrowserRecovery && linked && linked.save === null && browserSave?.data) {
          const message = 'The linked folder has no battery save, but browser recovery data exists. Use browser recovery to avoid discarding unsynced progress.';
          await deviceLibrary.markBrowserRecoveryConflict(id, message);
          setRecoveryPrompt(message);
          setStatusText(message);
          return;
        }
        if (!useBrowserRecovery && linked && (
          browserStates.length !== linked.states.length ||
          browserStates.some((state) => {
            const diskState = linked.states.find((candidate) => candidate.slot === state.slot);
            return !diskState || !sameBuffer(state.data, diskState.data);
          })
        )) {
          const message = 'Linked save states differ from browser recovery data. Choose which copy to use before playing.';
          await deviceLibrary.markBrowserRecoveryConflict(id, message);
          setRecoveryPrompt(message);
          setStatusText(message);
          return;
        }
        // Linked media may be selected for this launch, but folder metadata is
        // not allowed to roll back browser recovery history or its chosen name.
        const sourceGame = linked && storedGame ? reconcileGameMetadata(storedGame, linked.game) : linked?.game ?? storedGame!;
        const storedRom = linked ? await db.getRom(id) : await db.getRom(id);
        const rom = linked ? { data: linked.rom } : storedRom ?? await db.getRom(id);
        if (!rom) throw new Error('The local ROM data is missing. Import the game again.');

        const updatedGame = { ...sourceGame, lastPlayedAt: Date.now() };
        await db.putGame(updatedGame, linked && !storedRom ? linked.rom : undefined);
        try {
          await deviceLibrary.mirrorGame(updatedGame);
        } catch (deviceError) {
          // Playing remains possible from the committed browser recovery copy,
          // but status makes the portable metadata failure explicit.
          if (active) setStatusText(`Browser metadata updated, but linked folder was not: ${deviceError instanceof Error ? deviceError.message : 'write failed'}`);
          if (active) setFolderWriteError(`Linked folder write error: ${deviceError instanceof Error ? deviceError.message : 'write failed'}`);
        }
        const save = linked ? (linked.save === null ? null : { data: linked.save }) : browserSave;
        if (save?.data) validateBatterySave(save.data);

        localRomUrl = URL.createObjectURL(new Blob([rom.data], { type: 'application/octet-stream' }));
        if (save?.data) {
          localSaveUrl = URL.createObjectURL(new Blob([save.data], { type: 'application/json' }));
        }

        if (!active) return;
        setGame(updatedGame);
        setRomSource({ romUrl: localRomUrl, saveUrl: localSaveUrl });
        if (!save?.data) setStatusText('No saved progress found for this game. Starting a new game.', true);
        sessionStartedRef.current = Date.now();
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : 'The game could not be loaded.');
        }
      }
    }

    loadGame();
    return () => {
      active = false;
      if (localRomUrl) URL.revokeObjectURL(localRomUrl);
      if (localSaveUrl) URL.revokeObjectURL(localSaveUrl);
      if (id && sessionStartedRef.current) {
        const elapsed = Math.max(0, Math.round((Date.now() - sessionStartedRef.current) / 1000));
        db.getGame(id)
          .then(async (current) => {
            if (!current) return;
            const updated = { ...current, playTime: current.playTime + elapsed };
            await db.putGame(updated);
            await deviceLibrary.mirrorGame(updated);
          })
          .catch((writeError) => console.error('Could not persist play history:', writeError));
      }
    };
  }, [id, useBrowserRecovery]);

  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || typeof event.data !== 'string') return;
      try {
        const data = JSON.parse(event.data) as Record<string, unknown>;
        const type = String(data.type ?? '');
        if (type === 'keydown' && isGameKey(data.key)) {
          pressedKeysRef.current.add(data.key);
          postToCore({ type: 'keydown', key: data.key });
        } else if (type === 'keyup' && isGameKey(data.key)) {
          if (!pressedKeysRef.current.has(data.key)) return;
          pressedKeysRef.current.delete(data.key);
          postToCore({ type: 'keyup', key: data.key });
        } else if (type === 'releaseAllKeys') {
          releaseAllKeys();
        } else if (type === 'gameplayInterrupted') {
          releaseAllKeys();
          setSpeed(1);
        } else if (type === 'requestSpeedCycle' || type === 'toggleFastForward') {
          cycleSpeed();
        } else if (type === 'ready') {
          setIsReady(true);
          postToCore({ type: 'setFastForward', factor: speedRef.current });
          postToCore(coreInputMapMessage(bindingsRef.current.keyboard, bindingsRef.current.gamepad, false));
          setStatusText('Loading game…');
        } else if (type === 'romLoaded') {
          setStatusText('');
        } else if (type === 'romHash') {
          const hash = String(data.sha256 ?? '');
          if (/^[a-f0-9]{64}$/.test(hash)) setCoreRomHash(hash);
        } else if (type === 'batterySave' && id && typeof data.save === 'string') {
          try {
            validateBatterySave(data.save);
            await db.putSave({ id, data: data.save });
            await deviceLibrary.mirrorSave(id, data.save);
            setStatusText('Battery save committed to browser recovery storage and the active linked folder, if selected.', true);
          } catch (saveError) {
            setStatusText(`Battery save was not fully written: ${saveError instanceof Error ? saveError.message : 'unknown error'}`);
            setFolderWriteError(`Linked folder write error: ${saveError instanceof Error ? saveError.message : 'unknown error'}`);
          }
        } else if (type === 'saveState' && id && typeof data.state === 'string') {
          try {
            validateSaveState(data.state);
            const state: SaveState = {
              id: `${id}_1`,
              gameId: id,
              slot: 1,
              timestamp: Date.now(),
              data: new TextEncoder().encode(data.state).buffer,
            };
            await db.putState(state);
            await deviceLibrary.mirrorState(state);
            setStatusText('Save state stored in slot 1 (and committed to the active linked folder, if selected).', true);
          } catch (stateError) {
            setStatusText(`Save state was not fully written: ${stateError instanceof Error ? stateError.message : 'unknown error'}`);
            setFolderWriteError(`Linked folder write error: ${stateError instanceof Error ? stateError.message : 'unknown error'}`);
          }
        } else if (type === 'saveError') {
          setStatusText(`Save error: ${String(data.message ?? 'unknown error')}`);
        } else if (type === 'romError') {
          setError(String(data.message ?? 'The emulator could not load this ROM.'));
        } else if (type === 'linkSerialStart') {
          linkPlayRef.current.sendSerialStart(Number(data.id), Number(data.data));
        } else if (type === 'linkSerialReply') {
          linkPlayRef.current.sendSerialReply(Number(data.id), Number(data.data));
        }
      } catch {
        // Ignore non-Zenulator window messages.
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [cycleSpeed, id, postToCore, releaseAllKeys, setSpeed]);

  useEffect(() => {
    if (!isReady || !romSource) return;
    postToCore({
      type: 'loadRomFile',
      uri: romSource.romUrl,
      saveUri: romSource.saveUrl,
    });
  }, [isReady, postToCore, romSource]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableControl(event.target)) return;
      const action = actionForCode(event.code, event, bindingsRef.current.keyboard);
      if (!action) return;
      event.preventDefault();
      if (action === 'speed') {
        if (!event.repeat) cycleSpeed();
        return;
      }
      const mapped = action;
      keyCodeHeldRef.current.set(event.code, mapped);
      pressedKeysRef.current.add(mapped);
      postToCore({ type: 'keydown', key: mapped });
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      // Release exactly what this physical key pressed, even after a rebind
      // and even when focus has moved into a dialog/input.
      const mapped = keyCodeHeldRef.current.get(event.code);
      keyCodeHeldRef.current.delete(event.code);
      if (!mapped || !pressedKeysRef.current.has(mapped)) return;
      event.preventDefault();
      // Another physical alias (e.g. the other Shift for Select) still holds it.
      if ([...keyCodeHeldRef.current.values()].includes(mapped)) return;
      pressedKeysRef.current.delete(mapped);
      postToCore({ type: 'keyup', key: mapped });
    };

    const handlePointerDown = (event: PointerEvent) => {
      // Toolbar clicks move focus away from the iframe. Release before that
      // happens so a held game key cannot remain latched during an action.
      if (isEditableControl(event.target)) releaseAllKeys();
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') releaseAllKeys();
    };
    const flushSave = () => postToCore({ type: 'flushSave' });

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('keyup', handleKeyUp, { capture: true });
    window.addEventListener('pointerdown', handlePointerDown, { capture: true });
    window.addEventListener('blur', releaseAllKeys);
    window.addEventListener('pagehide', flushSave);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      flushSave();
      releaseAllKeys();
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('keyup', handleKeyUp, { capture: true });
      window.removeEventListener('pointerdown', handlePointerDown, { capture: true });
      window.removeEventListener('blur', releaseAllKeys);
      window.removeEventListener('pagehide', flushSave);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [cycleSpeed, postToCore, releaseAllKeys]);

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleFullscreen = async () => {
    releaseAllKeys();
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await stageRef.current?.requestFullscreen();
      }
    } catch {
      setStatusText('Fullscreen is unavailable in this browser window.', true);
    } finally {
      focusGame();
    }
  };

  const saveState = () => {
    releaseAllKeys();
    setStatusText('Saving state…');
    postToCore({ type: 'saveState' });
    focusGame();
  };

  const loadState = async () => {
    if (!id) return;
    releaseAllKeys();
    try {
      const browserState = await db.getState(id, 1);
      let linked: Awaited<ReturnType<typeof deviceLibrary.readForPlay>> = null;
      if (!useBrowserRecovery) {
        try {
          linked = await deviceLibrary.readForPlay(id);
        } catch (folderError) {
          if (!browserState) throw folderError;
          const message = `The linked folder could not be read, but browser recovery state is available. Choose Use browser recovery before loading: ${folderError instanceof Error ? folderError.message : 'unknown error'}`;
          await deviceLibrary.markBrowserRecoveryConflict(id, message);
          setRecoveryPrompt(message);
          setStatusText(message);
          return;
        }
      }
      const choice = chooseStateRecovery(
        browserState,
        linked?.states.find((item) => item.slot === 1) ?? null,
        true,
        useBrowserRecovery,
      );
      if (choice.kind === 'prompt') {
        const message = 'Slot 1 differs between the linked folder and browser recovery. Choose which copy to use before loading.';
        await deviceLibrary.markBrowserRecoveryConflict(id, message);
        setRecoveryPrompt(message);
        setStatusText(message);
        return;
      }
      const state = choice.kind === 'browser' || choice.kind === 'linked' ? choice.state : null;
      if (!state) {
        setStatusText('Slot 1 is empty.', true);
        return;
      }
      const serialized = new TextDecoder().decode(state.data);
      validateSaveState(serialized);
      postToCore({ type: 'loadState', state: serialized });
      setStatusText('Loaded save state from slot 1.', true);
    } catch (loadError) {
      setStatusText(`Save state could not be loaded: ${loadError instanceof Error ? loadError.message : 'unknown error'}`);
    } finally {
      focusGame();
    }
  };

  const exportBackup = async () => {
    if (!id || !game) return;
    releaseAllKeys();
    try {
      const [save, states] = await Promise.all([db.getSave(id), db.getStatesForGame(id)]);
      if (!save && states.length === 0) {
        setStatusText('There are no saves to back up yet.', true);
        return;
      }
      const backup: BackupFile = {
        app: 'zenulator-web',
        version: 1,
        romHash: game.romHash,
        gameName: game.name,
        exportedAt: Date.now(),
        batterySave: save?.data ?? null,
        states: states.map((state) => ({
          slot: state.slot,
          timestamp: state.timestamp,
          data: new TextDecoder().decode(state.data),
        })),
      };
      downloadText(`${game.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.zenbackup.json`, JSON.stringify(backup));
      setStatusText('Save backup downloaded.', true);
    } finally {
      focusGame();
    }
  };

  const importBackup = async (file: File) => {
    if (!id || !game) return;
    releaseAllKeys();
    try {
      if (file.size > MAX_BACKUP_FILE_BYTES) {
        throw new Error('This backup file is too large.');
      }
      const backup = parseBackup(JSON.parse(await file.text()), game.romHash);
      const states = backup.states.map((state) => ({
        id: `${id}_${state.slot}`,
        gameId: id,
        slot: state.slot,
        timestamp: state.timestamp,
        data: new TextEncoder().encode(state.data).buffer,
      }));
      await db.restoreBackup(id, backup.batterySave, states);
      // Update the live core as soon as the validated browser recovery
      // transaction commits. A subsequent optional folder failure must not
      // leave the emulator running the old battery data.
      if (typeof backup.batterySave === 'string') {
        postToCore({ type: 'loadSave', save: backup.batterySave });
      } else {
        postToCore({ type: 'clearSave' });
      }
      try {
        await deviceLibrary.mirrorBackup(id, backup.batterySave, states);
      } catch (deviceError) {
        setStatusText(`Save backup restored in browser recovery and applied to the emulator, but not to the linked folder: ${deviceError instanceof Error ? deviceError.message : 'unknown error'}`);
        setFolderWriteError(`Linked folder write error: ${deviceError instanceof Error ? deviceError.message : 'unknown error'}`);
        return;
      }
      setStatusText('Save backup restored.', true);
    } catch (backupError) {
      setStatusText(backupError instanceof Error ? backupError.message : 'The backup could not be restored.');
    } finally {
      if (backupInputRef.current) backupInputRef.current.value = '';
      focusGame();
    }
  };

  const chooseSpeed = (next: Speed) => {
    releaseAllKeys();
    setSpeed(next);
    focusGame();
  };

  const handleControlsDialogChange = (open: boolean) => {
    // Same focus contract as Link Play: never steal focus from the dialog.
    linkPlayDialogOpenRef.current = open;
    setControlsDialogOpen(open);
    releaseAllKeys();
    if (!open) focusGame();
  };

  const resetGame = () => {
    releaseAllKeys();
    postToCore({ type: 'reset' });
    focusGame();
  };

  const openBackupPicker = () => {
    releaseAllKeys();
    backupInputRef.current?.click();
    // A cancelled native picker does not fire input/change, so return focus
    // when the picker hands control back to this document as well.
    window.setTimeout(focusGame, 0);
  };

  const handleLinkPlayDialogChange = (open: boolean) => {
    linkPlayDialogOpenRef.current = open;
    setLinkPlayDialogOpen(open);
    if (!open) {
      releaseAllKeys();
      focusGame();
    }
  };

  if (error) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
        <div className="bg-card p-8 rounded-xl border border-destructive/50 max-w-md w-full text-center">
          <div className="w-16 h-16 bg-destructive/20 text-destructive rounded-full flex items-center justify-center mx-auto mb-4">
            <span className="text-2xl font-bold">!</span>
          </div>
          <h2 className="text-xl font-bold mb-2">Failed to load game</h2>
          <p data-testid="status-game-error" className="text-muted-foreground mb-6">{error}</p>
          <Button data-testid="button-return-library" onClick={() => setLocation('/')} variant="outline" className="w-full">
            Return to Library
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-foreground flex flex-col h-screen overflow-hidden">
      <header className="min-h-16 bg-card/90 border-b border-border backdrop-blur-md flex flex-wrap items-center justify-between gap-3 px-4 py-2 z-10 shrink-0">
        <div className="flex items-center gap-4 min-w-0">
          <Link data-testid="link-library" href="/" className="p-2 -ml-2 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors group">
            <ArrowLeft className="w-5 h-5 group-hover:-translate-x-1 transition-transform" />
          </Link>
          <div className="flex flex-col min-w-0">
            <h1 data-testid="text-game-title" className="font-bold leading-tight truncate">
              {game?.name || 'Loading…'}
            </h1>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-mono flex items-center gap-3">
              <span className="flex items-center gap-1"><Monitor className="w-3 h-3" /> Browser session</span>
              {linkPlay.status === 'connected' && (
                <span className="flex items-center gap-1 text-emerald-400"><Cable className="w-3 h-3" /> Link connected</span>
              )}
            </div>
          </div>
        </div>
        {recoveryPrompt && (
          <div data-testid="device-recovery-prompt" role="alert" className="order-last basis-full rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs flex flex-wrap items-center gap-3">
            <span>{recoveryPrompt}</span>
             <Button
               size="sm"
               variant="secondary"
               onClick={() => {
                 releaseAllKeys();
                 setRecoveryPrompt('');
                 setUseBrowserRecovery(true);
                 focusGame();
               }}
             >
              Use browser recovery
            </Button>
            <Link href="/" className="underline font-semibold">Return to library</Link>
          </div>
        )}
        {folderWriteError && (
          <div data-testid="status-folder-write-error" role="alert" className="order-last basis-full rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {folderWriteError}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Dialog open={linkPlayDialogOpen} onOpenChange={handleLinkPlayDialogChange}>
            <DialogTrigger asChild>
              <Button data-testid="button-link-play" variant={linkPlay.status === 'connected' ? 'default' : 'secondary'} size="sm" className="gap-2">
                <Cable className="w-4 h-4" />
                {linkPlay.status === 'idle' ? 'Link Play' : linkPlay.status === 'connected' ? 'Linked' : 'Linking…'}
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Link Play</DialogTitle>
                <DialogDescription>
                  Connect two Zenulator players using the exact same ROM. Only cable words leave this device.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-6 py-4">
                <div data-testid="status-link-play" className="text-sm p-3 rounded bg-muted/50 font-mono flex items-center justify-between gap-3">
                  <span>{linkPlay.message || (coreRomHash ? 'Ready to connect.' : 'Checking ROM compatibility…')}</span>
                  {linkPlay.roomCode && <strong className="text-primary tracking-widest">{linkPlay.roomCode}</strong>}
                </div>
                {linkPlay.status === 'idle' || linkPlay.status === 'error' ? (
                  <div className="flex flex-col gap-4">
                    <Button data-testid="button-create-link-room" onClick={linkPlay.createRoom} disabled={!coreRomHash}>
                      Host a New Game
                    </Button>
                    <div className="flex gap-2">
                      <Input
                        data-testid="input-link-code"
                        aria-label="Link Play room code"
                        placeholder="Room code"
                        value={joinCode}
                        onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                        maxLength={6}
                        className="font-mono text-center"
                      />
                      <Button data-testid="button-join-link-room" onClick={() => linkPlay.joinRoom(joinCode)} disabled={!coreRomHash || joinCode.trim().length !== 6}>
                        Join
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button data-testid="button-leave-link-room" variant="destructive" onClick={linkPlay.leaveRoom}>
                    Disconnect
                  </Button>
                )}
              </div>
            </DialogContent>
          </Dialog>

          <Button data-testid="button-save-state" onClick={saveState} variant="secondary" size="sm" className="gap-2">
            <Save className="w-4 h-4" /> Save
          </Button>
          <Button data-testid="button-load-state" onClick={loadState} variant="secondary" size="sm">
            Load
          </Button>
          <div role="radiogroup" aria-label="Target game speed" title="Target speed; achieved speed depends on this computer" className="flex items-center rounded-md border border-border bg-secondary/60 p-0.5">
            {([1, 2, 3] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={speed === option}
                data-testid={`button-speed-${option}`}
                onClick={() => chooseSpeed(option)}
                className={`h-7 min-w-9 px-2 rounded text-xs font-mono font-semibold transition-colors ${speed === option ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {option}×
              </button>
            ))}
          </div>
          <Button
            data-testid="button-controls"
            onClick={() => handleControlsDialogChange(true)}
            variant="secondary"
            size="icon"
            aria-label="Keyboard and controller mapping"
            title="Keyboard and controller mapping"
          >
            <Keyboard className="w-4 h-4" />
          </Button>
          <InputMappingDialog
            open={controlsDialogOpen}
            onOpenChange={handleControlsDialogChange}
            bindings={bindings}
            onChange={setBindings}
          />
          <Button data-testid="button-reset" onClick={resetGame} variant="secondary" size="icon" aria-label="Reset game" title="Reset game">
            <RotateCcw className="w-4 h-4" />
          </Button>
          <Button data-testid="button-export-backup" onClick={exportBackup} variant="secondary" size="icon" aria-label="Download save backup" title="Download save backup">
            <Download className="w-4 h-4" />
          </Button>
          <Button
            data-testid="button-import-backup"
            onClick={openBackupPicker}
            variant="secondary"
            size="icon"
            aria-label="Restore save backup"
            title="Restore save backup"
          >
            <Upload className="w-4 h-4" />
          </Button>
          <input
            ref={backupInputRef}
            data-testid="input-backup-file"
            className="hidden"
            type="file"
            accept=".json,.zenbackup"
            onChange={(event) => event.target.files?.[0] && importBackup(event.target.files[0])}
          />
          <Button data-testid="button-fullscreen" onClick={toggleFullscreen} variant="secondary" size="icon" aria-label="Toggle fullscreen" title="Fullscreen">
            <Maximize className="w-4 h-4" />
          </Button>
        </div>
      </header>

      <main className="flex-1 relative flex items-center justify-center bg-black overflow-hidden">
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-20">
          <div className="w-[80vw] h-[80vh] bg-primary/20 blur-[100px] rounded-full" />
        </div>
        <div
          ref={stageRef}
          data-testid="emulator-stage"
          className={`relative w-full max-w-[1200px] aspect-[3/2] max-h-full flex items-center justify-center shadow-2xl bg-black ${isFullscreen ? 'max-w-none h-screen' : ''}`}
        >
          <iframe
            ref={iframeRef}
            srcDoc={GBA_EMULATOR_HTML}
            onBlur={releaseAllKeys}
            className="w-full h-full border-0 bg-black z-10"
            sandbox="allow-scripts allow-same-origin"
            allow="autoplay; gamepad"
            title="Zenulator GBA screen"
          />
          {statusText && (
            <div data-testid="status-emulator" role="status" className={`absolute top-4 left-1/2 -translate-x-1/2 bg-card/95 border border-border px-4 py-2 rounded-lg text-xs font-mono z-20 shadow-xl pointer-events-none transition-opacity duration-[400ms] motion-reduce:transition-none ${statusFading ? 'opacity-0' : 'opacity-100'}`}>
              {statusText}
            </div>
          )}
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2 bg-card/90 border border-border px-5 py-2 rounded-full hidden lg:flex gap-5 text-xs font-mono opacity-0 hover:opacity-100 transition-opacity pointer-events-none shadow-xl z-20">
            {(['b', 'a', 'l', 'r', 'start', 'select', 'speed'] as const).map((action) => (
              <span key={action}>
                <strong className="text-primary">{bindings.keyboard[action].map((code) => code.replace(/^Key|^Digit/, '').replace('Shift', 'Shift ')).join('/') || '-'}</strong>{' '}
                {action === 'speed' ? 'Speed' : action.toUpperCase()}
              </span>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}