import { useEffect, useState } from 'react';
import { Gamepad2, Keyboard, RotateCcw, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ACTION_LABELS, assignGamepadBinding, assignKeyboardBinding, clearBinding, defaultBindings,
  describeGamepadButton, describeKeyCode, INPUT_ACTIONS, type InputAction, type StoredBindings,
} from '@/lib/keyboardRouting';

type Kind = 'keyboard' | 'gamepad';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bindings: StoredBindings;
  onChange: (bindings: StoredBindings) => void;
}

export function InputMappingDialog({ open, onOpenChange, bindings, onChange }: Props) {
  const [listening, setListening] = useState<{ kind: Kind; action: InputAction } | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!open) setListening(null);
  }, [open]);

  const apply = (kind: Kind, action: InputAction, input: string | number) => {
    const result = kind === 'keyboard'
      ? assignKeyboardBinding(bindings.keyboard, action, input as string)
      : assignGamepadBinding(bindings.gamepad, action, input as number);
    if (result.rejected) {
      setNotice(result.rejected);
      return;
    }
    onChange(kind === 'keyboard'
      ? { ...bindings, keyboard: result.bindings as StoredBindings['keyboard'] }
      : { ...bindings, gamepad: result.bindings as StoredBindings['gamepad'] });
    const label = kind === 'keyboard' ? describeKeyCode(input as string) : describeGamepadButton(input as number);
    setNotice(result.displaced.length
      ? `${label} moved to ${ACTION_LABELS[action]} (removed from ${result.displaced.map((a) => ACTION_LABELS[a]).join(', ')}).`
      : `${label} now controls ${ACTION_LABELS[action]}.`);
    setListening(null);
  };

  // Keyboard capture: the next non-modifier keypress. Escape cancels and is
  // never bindable; Ctrl/Alt/Meta combos stay browser-owned.
  useEffect(() => {
    if (listening?.kind !== 'keyboard') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.code === 'Escape') { setListening(null); return; }
      apply('keyboard', listening.action, event.code);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening]);

  // Controller capture: the first button that goes from released to pressed.
  useEffect(() => {
    if (listening?.kind !== 'gamepad' || !navigator.getGamepads) return;
    let frame = 0;
    const baseline = new Map<string, boolean>();
    const poll = () => {
      for (const pad of navigator.getGamepads()) {
        if (!pad?.connected) continue;
        for (let index = 0; index < pad.buttons.length && index < 32; index += 1) {
          const id = `${pad.index}:${index}`;
          const pressed = pad.buttons[index].pressed;
          if (!baseline.has(id)) { baseline.set(id, pressed); continue; }
          if (pressed && !baseline.get(id)) { apply('gamepad', listening.action, index); return; }
          baseline.set(id, pressed);
        }
      }
      frame = requestAnimationFrame(poll);
    };
    frame = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening]);

  const list = (kind: Kind) => {
    const map = kind === 'keyboard' ? bindings.keyboard : bindings.gamepad;
    return (
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {INPUT_ACTIONS.map((action) => {
          const values = (map[action] as Array<string | number>).map((value) => (
            kind === 'keyboard' ? describeKeyCode(value as string) : describeGamepadButton(value as number)
          ));
          const isListening = listening?.kind === kind && listening.action === action;
          return (
            <div key={action} className="flex items-center gap-3 px-3 py-2">
              <span className="w-24 text-sm font-semibold">{ACTION_LABELS[action]}</span>
              <span className={`flex-1 text-xs font-mono ${values.length ? 'text-muted-foreground' : 'text-destructive'}`}>
                {isListening ? (kind === 'keyboard' ? 'Press a key… (Esc cancels)' : 'Press a controller button…') : values.join(' · ') || 'Unbound'}
              </span>
              <Button
                size="sm"
                variant={isListening ? 'default' : 'secondary'}
                data-testid={`button-rebind-${kind}-${action}`}
                aria-label={`Change ${ACTION_LABELS[action]} ${kind} binding`}
                onClick={() => { setNotice(''); setListening(isListening ? null : { kind, action }); }}
              >
                {isListening ? 'Cancel' : 'Change'}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Clear ${ACTION_LABELS[action]} ${kind} binding`}
                onClick={() => onChange(kind === 'keyboard'
                  ? { ...bindings, keyboard: clearBinding(bindings.keyboard, action) }
                  : { ...bindings, gamepad: clearBinding(bindings.gamepad, action) })}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Controls</DialogTitle>
          <DialogDescription>
            Bindings are saved in this browser. An input already in use moves to the new action. Ctrl, Alt, Cmd, Tab and Escape stay with the browser.
          </DialogDescription>
        </DialogHeader>
        {notice && <p role="status" data-testid="status-binding" className="text-xs text-primary">{notice}</p>}
        <Tabs defaultValue="keyboard" onValueChange={() => setListening(null)}>
          <TabsList className="w-full">
            <TabsTrigger value="keyboard" className="flex-1 gap-2"><Keyboard className="w-4 h-4" /> Keyboard</TabsTrigger>
            <TabsTrigger value="gamepad" className="flex-1 gap-2"><Gamepad2 className="w-4 h-4" /> Controller</TabsTrigger>
          </TabsList>
          <TabsContent value="keyboard">{list('keyboard')}</TabsContent>
          <TabsContent value="gamepad">
            <p className="text-xs text-muted-foreground mb-2">
              Uses the browser Gamepad API (standard layout). The left stick always also moves the D-pad.
            </p>
            {list('gamepad')}
          </TabsContent>
        </Tabs>
        <Button
          variant="outline"
          className="gap-2"
          data-testid="button-reset-bindings"
          onClick={() => { onChange(defaultBindings()); setNotice('All bindings restored to defaults.'); }}
        >
          <RotateCcw className="w-4 h-4" /> Reset all to defaults
        </Button>
      </DialogContent>
    </Dialog>
  );
}
