import { useState, type FormEvent } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Game } from '@/lib/db';

export default function RenameGameDialog({ game, rename, onClose }: {
  game: Game;
  rename: (id: string, title: string) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(game.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try { await rename(game.id, title); onClose(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The title could not be saved.'); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <DialogTitle>Rename game</DialogTitle>
        <DialogDescription>Only the library title changes. Your ROM and saves stay linked.</DialogDescription>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <label htmlFor="game-title">Game title</label>
          <Input id="game-title" autoFocus required maxLength={120} value={title}
            disabled={busy} onChange={(event) => setTitle(event.target.value)} />
          {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button disabled={busy || !title.trim()}>{busy ? 'Saving…' : 'Save title'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
