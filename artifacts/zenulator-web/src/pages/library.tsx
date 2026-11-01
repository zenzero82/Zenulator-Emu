import { useEffect, useState, useRef, KeyboardEvent } from 'react';
import { useLibrary, type RomImportResult } from '@/hooks/useLibrary';
import { Link, useLocation } from 'wouter';
import { Upload, Play, Trash2, Clock, HardDrive, Cpu, MoreVertical, Download, ShieldCheck, FolderOpen, Unplug, ImagePlus, ImageOff } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { db, type Game } from '@/lib/db';
import type { ArtworkCandidate } from '@/lib/artwork';
import RenameGameDialog from '@/components/RenameGameDialog';
import { Pencil } from 'lucide-react';

function formatPlayTime(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export default function Library() {
  const {
    games, isLoading, importRom, deleteGame, deviceStatus,
    chooseDeviceFolder, reconnectDeviceFolder, disconnectDeviceFolder, copyToDeviceFolder,
    deviceConflicts, devicePending, useLinkedCopy, libraryNotice,
    setArtwork, setArtworkCandidate, removeArtwork, renameGame,
  } = useLibrary();
  const [isDragging, setIsDragging] = useState(false);
  const [importError, setImportError] = useState('');
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderProgress, setFolderProgress] = useState('');
  const [folderError, setFolderError] = useState('');
  const [artworkImport, setArtworkImport] = useState<RomImportResult | null>(null);
  const [artworkBusy, setArtworkBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Game | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handleInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', handleInstallPrompt);
  }, []);

  const importFile = async (file: File, companions: File[] = []) => {
    setImportError('');
    try {
      const result = await importRom(file, companions);
      if (result.warnings.length) setImportError(result.warnings.join(' '));
      if (result.artworkCandidates.length) {
        setArtworkImport(result);
        return;
      }
      setLocation(`/play/${result.game.id}`);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'The ROM could not be imported.');
    }
  };

  const [, setLocation] = useLocation();

  const importFiles = async (files: File[]) => {
    const roms = files.filter((file) => /\.(gba|zip)$/i.test(file.name));
    if (roms.length !== 1) {
      setImportError('Select one .gba or .zip game at a time, optionally with matching cover images.');
      return;
    }
    await importFile(roms[0], files.filter((file) => file !== roms[0]));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await importFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await importFiles(Array.from(e.target.files));
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const finishArtworkImport = (game: Game) => {
    setArtworkImport(null);
    setLocation(`/play/${game.id}`);
  };

  const chooseImportedArtwork = async (candidate: ArtworkCandidate | null) => {
    if (!artworkImport) return;
    setImportError('');
    setArtworkBusy(true);
    try {
      if (candidate) await setArtworkCandidate(artworkImport.game.id, candidate);
      finishArtworkImport(artworkImport.game);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'The artwork could not be saved.');
    } finally {
      setArtworkBusy(false);
    }
  };

  const uploadArtwork = async (gameId: string, file: File) => {
    setImportError('');
    try {
      await setArtwork(gameId, file);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'The artwork could not be saved.');
    }
  };

  const clearArtwork = async (gameId: string) => {
    setImportError('');
    try {
      await removeArtwork(gameId);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'The artwork could not be removed.');
    }
  };

  const selectFolder = async () => {
    setFolderError('');
    setFolderBusy(true);
    try {
      const status = await chooseDeviceFolder();
      if (status.kind === 'error' || status.kind === 'permission-needed') setFolderError(status.message);
    } finally {
      setFolderBusy(false);
    }
  };

  const copyLibrary = async (overwrite = false) => {
    setFolderError('');
    setFolderBusy(true);
    try {
      await copyToDeviceFolder(overwrite, (completed, total) => setFolderProgress(`Copying ${completed} of ${total} game${total === 1 ? '' : 's'}…`));
      setFolderProgress(games.length ? `Copied ${games.length} game${games.length === 1 ? '' : 's'} to the linked folder.` : 'Linked folder initialized. Import a ROM to get started.');
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : 'The browser library could not be copied.');
    } finally {
      setFolderBusy(false);
    }
  };

  return (
    <div 
      className="min-h-screen bg-background text-foreground flex flex-col items-center pt-16 pb-12 px-6 transition-colors duration-300 relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {renameTarget && <RenameGameDialog key={renameTarget.id} game={renameTarget} rename={renameGame} onClose={() => setRenameTarget(null)} />}
      <div className="w-full max-w-5xl flex flex-col gap-12 z-10 relative">
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div className="flex flex-col gap-2">
            <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight text-foreground drop-shadow-md flex items-center gap-4">
              <Cpu className="w-10 h-10 text-primary" /> 
              ZENULATOR
            </h1>
            <p className="text-muted-foreground text-sm font-mono tracking-widest uppercase">
              ADVANCED DESKTOP EMULATION
            </p>
          </div>
          
          <div className="flex flex-wrap items-center gap-3">
            {installPrompt && (
              <button
                type="button"
                data-testid="button-install-app"
                onClick={async () => {
                  await installPrompt.prompt();
                  await installPrompt.userChoice;
                  setInstallPrompt(null);
                }}
                className="border border-border bg-card px-4 py-3 rounded-lg flex items-center gap-2 font-semibold hover:border-primary/60 transition-colors"
              >
                <Download className="w-4 h-4" />
                INSTALL APP
              </button>
            )}
            <button 
              type="button"
              data-testid="button-import-rom"
              onClick={() => fileInputRef.current?.click()}
              className="group relative overflow-hidden bg-primary text-primary-foreground font-semibold px-6 py-3 rounded-lg flex items-center justify-center gap-3 transition-all hover:scale-105 active:scale-95 shadow-[0_0_20px_rgba(235,50,90,0.3)] hover:shadow-[0_0_30px_rgba(235,50,90,0.5)] focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background"
            >
              <Upload className="w-5 h-5 transition-transform group-hover:-translate-y-1" />
              <span>IMPORT ROM / ZIP</span>
              <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform" />
            </button>
          </div>
          <input 
            data-testid="input-rom-file"
            type="file" 
             accept=".gba,.zip,application/zip,.png,.jpg,.jpeg,.webp,.gif"
             multiple
            ref={fileInputRef} 
            onChange={handleFileChange} 
            className="hidden" 
          />
        </header>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 -mt-8 text-xs font-mono text-muted-foreground">
          <span className="flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-primary" /> ROMs and saves never leave this device</span>
          <span>Keyboard and standard gamepads supported</span>
          <span>Install from Chrome or Edge; Safari users can use File → Add to Dock</span>
        </div>

        {importError && (
          <div data-testid="status-import-error" role="alert" className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {importError}
          </div>
        )}
        {libraryNotice && (
          <div role="status" className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">{libraryNotice}</div>
        )}

        {artworkImport && (
          <section
            data-testid="artwork-import-chooser"
            role="dialog"
            aria-labelledby="artwork-import-title"
            aria-describedby="artwork-import-description"
            className="rounded-xl border border-primary/50 bg-card p-5 shadow-xl"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 id="artwork-import-title" className="font-bold flex items-center gap-2"><ImagePlus className="w-4 h-4 text-primary" /> Choose cover artwork</h2>
                <p id="artwork-import-description" className="mt-1 text-sm text-muted-foreground">
                  This ROM archive includes multiple safe image candidates. Pick one to save locally, or continue without changing the current artwork.
                </p>
              </div>
              <button
                type="button"
                onClick={() => chooseImportedArtwork(null)}
                disabled={artworkBusy}
                className="rounded-md border border-border px-3 py-2 text-xs font-semibold hover:bg-muted disabled:opacity-50"
              >
                {artworkImport.game.artwork ? 'Keep current artwork' : 'Skip artwork'}
              </button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {artworkImport.artworkCandidates.map((candidate) => (
                <ArtworkCandidateButton key={candidate.path} candidate={candidate} onChoose={() => chooseImportedArtwork(candidate)} disabled={artworkBusy} />
              ))}
            </div>
          </section>
        )}

        <section aria-labelledby="storage-settings-title" className="rounded-xl border border-border bg-card/70 p-5 flex flex-col gap-4">
          <div>
            <h2 id="storage-settings-title" className="font-bold flex items-center gap-2"><HardDrive className="w-4 h-4 text-primary" /> Storage</h2>
            <p className="mt-1 text-sm text-muted-foreground">Browser storage is always kept as a recovery copy. A linked folder is optional and stays on this computer.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-primary/40 bg-primary/5 p-4">
              <p className="font-semibold">Browser storage <span className="text-xs font-normal text-muted-foreground">(default)</span></p>
              <p className="mt-1 text-xs text-muted-foreground">Works in every browser. Use Import ROM and downloadable backups.</p>
            </div>
            <div className="rounded-lg border border-border p-4">
              <p className="font-semibold">Linked device folder</p>
              <p data-testid="status-device-folder" role="status" className="mt-1 text-xs text-muted-foreground">{deviceStatus.message}</p>
              {deviceStatus.kind === 'unsupported' ? (
                <p className="mt-3 text-xs text-muted-foreground">Chrome or Edge on desktop can link a folder. Safari and mobile can still import ROMs and download backups.</p>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  {(deviceStatus.kind === 'unlinked' || deviceStatus.kind === 'error') && (
                    <button data-testid="button-select-device-folder" type="button" onClick={selectFolder} disabled={folderBusy} className="rounded-md bg-secondary px-3 py-2 text-xs font-semibold hover:bg-secondary/80 disabled:opacity-50">
                      <FolderOpen className="mr-1 inline h-3.5 w-3.5" /> Select folder
                    </button>
                  )}
                  {deviceStatus.kind === 'permission-needed' && (
                    <>
                      <button data-testid="button-reconnect-device-folder" type="button" onClick={() => reconnectDeviceFolder().then((status) => status.kind !== 'connected' && setFolderError(status.message))} disabled={folderBusy} className="rounded-md bg-secondary px-3 py-2 text-xs font-semibold hover:bg-secondary/80 disabled:opacity-50">
                        Reconnect folder
                      </button>
                      <button data-testid="button-disconnect-device-folder" type="button" onClick={() => disconnectDeviceFolder()} disabled={folderBusy} className="rounded-md border border-border px-3 py-2 text-xs font-semibold hover:bg-muted disabled:opacity-50">
                        <Unplug className="mr-1 inline h-3.5 w-3.5" /> Disconnect
                      </button>
                    </>
                  )}
                  {deviceStatus.kind === 'connected' && (
                    <>
                      <button data-testid="button-copy-device-library" type="button" onClick={() => copyLibrary(false)} disabled={folderBusy} className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
                        Copy browser library
                      </button>
                      <button data-testid="button-disconnect-device-folder" type="button" onClick={() => disconnectDeviceFolder()} disabled={folderBusy} className="rounded-md border border-border px-3 py-2 text-xs font-semibold hover:bg-muted disabled:opacity-50">
                        <Unplug className="mr-1 inline h-3.5 w-3.5" /> Disconnect
                      </button>
                    </>
                  )}
                  {deviceStatus.kind === 'error' && (
                    <button data-testid="button-disconnect-device-folder" type="button" onClick={() => disconnectDeviceFolder()} disabled={folderBusy} className="rounded-md border border-border px-3 py-2 text-xs font-semibold hover:bg-muted disabled:opacity-50">
                      <Unplug className="mr-1 inline h-3.5 w-3.5" /> Disconnect folder
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          {folderError && (
            <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {folderError}
              {folderError.includes('already exist') && (
                <button data-testid="button-confirm-device-overwrite" type="button" onClick={() => copyLibrary(true)} className="ml-3 underline font-semibold">Overwrite linked copies</button>
              )}
            </div>
          )}
          {folderProgress && <p className="text-xs font-mono text-muted-foreground">{folderProgress}</p>}
          {deviceStatus.kind === 'connected' && <p className="text-xs text-muted-foreground">Copying is explicit consent to create or replace matching files. Deleting a browser game never deletes files from the linked folder. Folder permission and write locks are origin-specific; do not write the same folder simultaneously from another browser profile or site.</p>}
          {deviceConflicts.length > 0 && (
            <div data-testid="device-library-conflicts" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <p className="font-semibold">Recovery copies need your decision</p>
              {deviceConflicts.map((conflict) => (
                <div key={conflict.gameId} className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span>{conflict.reason}</span>
                  <button type="button" onClick={() => useLinkedCopy(conflict.gameId).catch((error) => setFolderError(error instanceof Error ? error.message : 'Could not use the linked copy.'))} className="rounded border border-border px-2 py-1 font-semibold hover:bg-muted">
                    Use linked copy
                  </button>
                </div>
              ))}
            </div>
          )}
          {devicePending.length > 0 && (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
              <p className="font-semibold">Browser recovery has unsynced changes</p>
              <p className="mt-1 text-xs">A linked-folder write failed. Your browser copy was retained; reconnect and use Copy browser library only after reviewing any conflict.</p>
            </div>
          )}
        </section>

        {isDragging && (
          <div className="absolute inset-0 z-50 bg-background/80 backdrop-blur-sm border-4 border-dashed border-primary rounded-2xl flex flex-col items-center justify-center pointer-events-none animate-in fade-in zoom-in duration-200">
            <HardDrive className="w-24 h-24 text-primary animate-bounce mb-6" />
            <h2 className="text-3xl font-bold text-primary font-mono tracking-wide">DROP TO INSTALL</h2>
          </div>
        )}

        <main className="flex-1 w-full">
          {isLoading ? (
            <div className="w-full flex items-center justify-center py-20">
              <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
            </div>
          ) : games.length === 0 ? (
            <div className="w-full bg-card border border-border rounded-xl p-12 flex flex-col items-center justify-center text-center gap-6 shadow-xl relative overflow-hidden group">
              <div className="absolute inset-0 opacity-[0.05] pointer-events-none bg-[radial-gradient(circle_at_center,hsl(var(--primary))_1px,transparent_1px)] bg-[length:18px_18px]" />
              <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center group-hover:scale-110 transition-transform duration-500">
                <Upload className="w-10 h-10 text-muted-foreground group-hover:text-primary transition-colors duration-500" />
              </div>
              <div>
                <h3 className="text-2xl font-bold mb-2">Library Empty</h3>
                <p className="text-muted-foreground max-w-md mx-auto">
                   Import a .gba file or ROM-hack .zip. Include matching cover artwork, such as Game.gba and Game.png, in the same selection or drop.
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {games.map((game, i) => (
                <GameCard 
                  key={game.id} 
                  game={game} 
                  onDelete={() => deleteGame(game.id).catch((error) => setImportError(error instanceof Error ? error.message : 'The game could not be deleted.'))}
                  onArtworkUpload={uploadArtwork}
                  onArtworkRemove={clearArtwork}
                  onRename={() => setRenameTarget(game)}
                  index={i}
                />
              ))}
            </div>
          )}
        </main>
      </div>
      
      {/* Decorative background elements */}
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/5 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-accent/10 blur-[120px] rounded-full" />
      </div>
    </div>
  );
}

function useArtworkUrl(game: Game | ArtworkCandidate): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const isCandidate = 'path' in game;
  const artwork = isCandidate ? undefined : game.artwork;
  useEffect(() => {
    let active = true;
    let created: string | null = null;
    if (isCandidate) {
      created = URL.createObjectURL(new Blob([game.data], { type: game.mimeType }));
      setUrl(created);
    } else if (artwork) {
      db.getArtwork(game.id).then((artwork) => {
        if (!active || !artwork) return;
        created = URL.createObjectURL(new Blob([artwork.data], { type: artwork.mimeType }));
        setUrl(created);
      }).catch(() => undefined);
    } else {
      setUrl(null);
    }
    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [game.id, artwork?.byteLength, artwork?.mimeType, isCandidate]);
  return url;
}

function ArtworkCandidateButton({ candidate, onChoose, disabled }: { candidate: ArtworkCandidate; onChoose: () => void; disabled: boolean }) {
  const url = useArtworkUrl(candidate);
  return (
    <button
      type="button"
      onClick={onChoose}
      disabled={disabled}
      className="group rounded-lg border border-border bg-muted/40 p-2 text-left transition hover:border-primary focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
      aria-label={`Use ${candidate.fileName} as cover artwork`}
    >
      <div className="aspect-[4/3] overflow-hidden rounded bg-background">
        {url && <img src={url} alt="" className="h-full w-full object-cover transition-transform group-hover:scale-105" />}
      </div>
      <span className="mt-2 block truncate text-xs font-semibold">{candidate.fileName}</span>
      <span className="block text-[10px] text-muted-foreground">{candidate.width} × {candidate.height}</span>
    </button>
  );
}

function GameCard({
  game,
  onDelete,
  onArtworkUpload,
  onArtworkRemove,
  onRename,
  index,
}: {
  game: Game;
  onDelete: () => void;
  onArtworkUpload: (gameId: string, file: File) => Promise<void>;
  onArtworkRemove: (gameId: string) => Promise<void>;
  onRename: () => void;
  index: number;
}) {
  const handleKeyDown = (e: KeyboardEvent, action: () => void) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      action();
    }
  };
  const artworkUrl = useArtworkUrl(game);
  const artworkInputRef = useRef<HTMLInputElement>(null);

  return (
    <div 
      className="group bg-card border border-border rounded-xl overflow-hidden hover:border-primary/50 transition-all duration-300 hover:-translate-y-1 hover:shadow-lg hover:shadow-primary/10 flex flex-col animate-in fade-in slide-in-from-bottom-4 focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2 focus-within:ring-offset-background outline-none"
      style={{ animationDelay: `${index * 50}ms`, animationFillMode: 'both' }}
    >
      <div className="h-32 bg-muted relative flex items-center justify-center overflow-hidden">
        <div className="absolute inset-0 opacity-20 bg-[linear-gradient(135deg,transparent_25%,hsl(var(--primary)/0.18)_25%,hsl(var(--primary)/0.18)_50%,transparent_50%,transparent_75%,hsl(var(--primary)/0.18)_75%)] bg-[length:20px_20px]" />
        {artworkUrl ? (
          <img src={artworkUrl} alt={`${game.name} cover artwork`} className="relative h-full w-full object-cover" />
        ) : (
          <div className="text-4xl font-black text-muted-foreground/30 tracking-tighter truncate w-full text-center px-4 mix-blend-overlay uppercase select-none">
            {game.name}
          </div>
        )}
        
        {/* Play Overlay */}
        <div className="absolute inset-0 bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center backdrop-blur-sm">
          <Link 
            data-testid={`link-play-${game.id}`}
            href={`/play/${game.id}`} 
            className="w-14 h-14 bg-primary text-primary-foreground rounded-full flex items-center justify-center hover:scale-110 active:scale-95 transition-transform focus:outline-none focus:ring-4 focus:ring-primary/50"
            aria-label={`Play ${game.name}`}
          >
            <Play className="w-6 h-6 ml-1" fill="currentColor" />
          </Link>
        </div>
      </div>
      
      <div className="p-5 flex flex-col gap-4 flex-1">
        <div className="flex justify-between items-start gap-4">
          <h3 className="font-bold text-lg leading-tight line-clamp-2" title={game.name}>
            {game.name}
          </h3>
          <DropdownMenu>
             <DropdownMenuTrigger aria-label={`Actions for ${game.name}`} className="p-1.5 -mr-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50">
              <MoreVertical className="w-5 h-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                onClick={() => artworkInputRef.current?.click()}
                className="cursor-pointer flex items-center gap-2"
              >
                <ImagePlus className="w-4 h-4" /> {game.artwork ? 'Replace cover artwork' : 'Add cover artwork'}
              </DropdownMenuItem>
              {game.artwork && (
                <DropdownMenuItem
                  onClick={() => onArtworkRemove(game.id)}
                  className="text-muted-foreground focus:text-foreground cursor-pointer flex items-center gap-2"
                >
                  <ImageOff className="w-4 h-4" /> Remove cover artwork
                </DropdownMenuItem>
              )}
              <DropdownMenuItem 
                onClick={onDelete}
                className="text-destructive focus:text-destructive focus:bg-destructive/10 cursor-pointer flex items-center gap-2"
              >
                <Trash2 className="w-4 h-4" /> Delete Game
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onRename} className="cursor-pointer flex items-center gap-2">
                <Pencil className="w-4 h-4" /> Rename game
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={artworkInputRef}
            data-testid={`input-artwork-${game.id}`}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onArtworkUpload(game.id, file);
              event.currentTarget.value = '';
            }}
          />
        </div>
        
        <div className="mt-auto grid grid-cols-2 gap-y-2 gap-x-4 text-xs font-mono text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            <span className="truncate">{game.lastPlayedAt > 0 ? formatDistanceToNow(game.lastPlayedAt, { addSuffix: true }) : 'Never played'}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Play className="w-3.5 h-3.5" />
            <span>{formatPlayTime(game.playTime)}</span>
          </div>
          <div className="flex items-center gap-1.5 col-span-2 mt-2 pt-2 border-t border-border/50">
            <HardDrive className="w-3.5 h-3.5" />
            <span className="truncate" title={game.fileName}>{game.fileName}</span>
            <span className="ml-auto opacity-60">{(game.size / (1024 * 1024)).toFixed(2)} MB</span>
          </div>
        </div>
      </div>
    </div>
  );
}
