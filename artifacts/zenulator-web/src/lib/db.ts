import type { ArtworkReference, GameArtwork } from '@/lib/artwork';

export interface Game {
  id: string;
  romHash: string;
  name: string;
  fileName: string;
  size: number;
  addedAt: number;
  lastPlayedAt: number;
  playTime: number;
  artwork?: ArtworkReference;
}

// IndexedDB must only contain browser-library metadata. Device manifest paths
// are capability-specific implementation details and must never leak back into
// the browser `games` store or another selected folder.
export function plainGame(game: Game): Game {
  return {
    id: game.id,
    romHash: game.romHash,
    name: game.name,
    fileName: game.fileName,
    size: game.size,
    addedAt: game.addedAt,
    lastPlayedAt: game.lastPlayedAt,
    playTime: game.playTime,
    ...(game.artwork ? { artwork: { ...game.artwork } } : {}),
  };
}

export interface GameRom {
  id: string;
  data: ArrayBuffer;
}

export interface GameSave {
  id: string;
  data: string;
}

export interface SaveState {
  id: string; // `${gameId}_${slot}`
  gameId: string;
  slot: number;
  timestamp: number;
  data: ArrayBuffer;
  screenshot?: string;
}

export interface StoredSetting {
  key: string;
  value: unknown;
}

const DB_NAME = 'zenulator-web-db';
const DB_VERSION = 3;

export class ZenDB {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    if (this.db) return;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('games')) {
          db.createObjectStore('games', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('roms')) {
          db.createObjectStore('roms', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('saves')) {
          db.createObjectStore('saves', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('states')) {
          const statesStore = db.createObjectStore('states', { keyPath: 'id' });
          statesStore.createIndex('gameId', 'gameId', { unique: false });
        }
        // Handles are structured-cloneable, so IndexedDB is the only appropriate
        // place to remember a user-selected File System Access directory.
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('artworks')) {
          db.createObjectStore('artworks', { keyPath: 'id' });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve();
      };

      request.onerror = (event) => {
        reject((event.target as IDBOpenDBRequest).error);
      };
    });
  }

  private async getStore(name: string, mode: IDBTransactionMode = 'readonly'): Promise<IDBObjectStore> {
    await this.init();
    const transaction = this.db!.transaction(name, mode);
    return transaction.objectStore(name);
  }

  // Games
  async getGames(): Promise<Game[]> {
    const store = await this.getStore('games');
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async getGame(id: string): Promise<Game | null> {
    const store = await this.getStore('games');
    return new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async putGame(game: Game, romData?: ArrayBuffer): Promise<void> {
    await this.init();
    return new Promise((resolve, reject) => {
      const stores = romData ? ['games', 'roms'] : ['games'];
      const transaction = this.db!.transaction(stores, 'readwrite');
      transaction.objectStore('games').put(plainGame(game));
      if (romData) {
        transaction.objectStore('roms').put({ id: game.id, data: romData });
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async deleteGame(id: string): Promise<void> {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(['games', 'roms', 'saves', 'states', 'artworks'], 'readwrite');
      tx.objectStore('games').delete(id);
      tx.objectStore('roms').delete(id);
      tx.objectStore('saves').delete(id);
      tx.objectStore('artworks').delete(id);

      const statesStore = tx.objectStore('states');
      const index = statesStore.index('gameId');
      const request = index.openCursor(IDBKeyRange.only(id));
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Roms
  async getRom(id: string): Promise<GameRom | null> {
    const store = await this.getStore('roms');
    return new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async putRom(rom: GameRom): Promise<void> {
    const store = await this.getStore('roms', 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.put(rom);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // Cover artwork is stored separately from game metadata so a large image
  // cannot make ordinary library scans or linked-folder manifests unwieldy.
  async getArtwork(id: string): Promise<GameArtwork | null> {
    const store = await this.getStore('artworks');
    return new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async putArtwork(artwork: GameArtwork): Promise<void> {
    const store = await this.getStore('artworks', 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.put(artwork);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async deleteArtwork(id: string): Promise<void> {
    const store = await this.getStore('artworks', 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // Saves
  async getSave(id: string): Promise<GameSave | null> {
    const store = await this.getStore('saves');
    return new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async putSave(save: GameSave): Promise<void> {
    const store = await this.getStore('saves', 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.put(save);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async restoreBackup(gameId: string, batterySave: string | null, states: SaveState[]): Promise<void> {
    const previousStates = await this.getStatesForGame(gameId);
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(['saves', 'states'], 'readwrite');
      const savesStore = tx.objectStore('saves');
      const statesStore = tx.objectStore('states');

      if (batterySave === null) {
        savesStore.delete(gameId);
      } else {
        savesStore.put({ id: gameId, data: batterySave } satisfies GameSave);
      }
      // A restore is a complete snapshot, not an additive import.
      for (const previous of previousStates) statesStore.delete(previous.id);
      for (const state of states) statesStore.put(state);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // States
  async getStatesForGame(gameId: string): Promise<SaveState[]> {
    const store = await this.getStore('states');
    return new Promise((resolve, reject) => {
      const index = store.index('gameId');
      const request = index.getAll(IDBKeyRange.only(gameId));
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async putState(state: SaveState): Promise<void> {
    const store = await this.getStore('states', 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.put(state);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getState(gameId: string, slot: number): Promise<SaveState | null> {
    const store = await this.getStore('states');
    return new Promise((resolve, reject) => {
      const request = store.get(`${gameId}_${slot}`);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  // Settings (including a FileSystemDirectoryHandle when the browser supports it)
  async getSetting<T>(key: string): Promise<T | null> {
    const store = await this.getStore('settings');
    return new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(((request.result as StoredSetting | undefined)?.value ?? null) as T | null);
      request.onerror = () => reject(request.error);
    });
  }

  async putSetting<T>(key: string, value: T): Promise<void> {
    const store = await this.getStore('settings', 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.put({ key, value } satisfies StoredSetting);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async deleteSetting(key: string): Promise<void> {
    const store = await this.getStore('settings', 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}

export const db = new ZenDB();
