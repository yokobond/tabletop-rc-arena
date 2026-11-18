/**
 * Arenas kept on this device: the custom arena being worked on, a library of arenas saved under
 * a name, and the pictures on their tables. Layouts are small and live in localStorage; pictures
 * are a few hundred KB each and live in IndexedDB, where a handful of them does not fill the quota.
 */
import { asCustomStage, cleanArenaName } from '../game/arenaFile';
import type { StageDefinition } from '../game/types';

const STAGE_KEY = 'rc-sumo-arena.custom.v1';
const LIBRARY_KEY = 'rc-sumo-arena.library.v1';
const TABLE_SCALE_KEY = 'rc-sumo-arena.table-scale.v1';
/** Where the one picture was kept before there was a library; still read, and written if IndexedDB fails. */
const LEGACY_IMAGE_KEY = 'rc-sumo-arena.custom-image.v1';
const DB_NAME = 'rc-sumo-arena';
const IMAGES = 'images';

export const MAX_SAVED_ARENAS = 30;

export interface SavedArena {
  id: string;
  name: string;
  /** Milliseconds since the epoch. */
  savedAt: number;
  stage: StageDefinition;
}

function read(key: string): unknown {
  try {
    const text = window.localStorage.getItem(key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Storage is full or blocked: the arena still works until the page is closed.
    return false;
  }
}

// ---------------------------------------------------------------------------
// The arena being worked on.
// ---------------------------------------------------------------------------

/** The saved arena, checked like any arena that comes from outside. */
export function loadSavedStage(): StageDefinition | null {
  return asCustomStage(read(STAGE_KEY));
}

export function saveStage(stage: StageDefinition) {
  return write(STAGE_KEY, stage);
}

/** The table size last chosen on this device (the standard table when none was): a preference, like a difficulty. */
export function loadTableScale(): number {
  const saved = read(TABLE_SCALE_KEY);
  return typeof saved === 'number' && Number.isFinite(saved) ? saved : 1;
}

export function saveTableScale(scale: number) {
  return write(TABLE_SCALE_KEY, scale);
}

// ---------------------------------------------------------------------------
// The library: arenas saved under a name, newest first.
// ---------------------------------------------------------------------------

export function loadLibrary(): SavedArena[] {
  const saved = read(LIBRARY_KEY);
  if (!Array.isArray(saved)) return [];
  const list: SavedArena[] = [];
  for (const raw of saved as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const { id, name, savedAt, stage } = raw as Record<string, unknown>;
    const checked = asCustomStage(stage);
    const clean = cleanArenaName(name);
    if (typeof id !== 'string' || !id || !clean || !checked || list.some((a) => a.id === id)) continue;
    list.push({ id, name: clean, savedAt: typeof savedAt === 'number' && Number.isFinite(savedAt) ? savedAt : 0, stage: checked });
    if (list.length === MAX_SAVED_ARENAS) break;
  }
  return list;
}

/**
 * Saves an arena under a name, replacing the one that already has that name. Returns the new
 * library, or null when it was not saved: the library is full, or the device's storage refused.
 */
export function saveToLibrary(rawName: string, stage: StageDefinition): SavedArena[] | null {
  const name = cleanArenaName(rawName);
  const checked = asCustomStage(stage);
  if (!name || !checked) return null;
  const before = loadLibrary();
  const old = before.find((a) => a.name === name);
  const entry: SavedArena = {
    id: old?.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name,
    savedAt: Date.now(),
    stage: checked,
  };
  const list = [entry, ...before.filter((a) => a !== old)];
  if (list.length > MAX_SAVED_ARENAS) return null;
  return write(LIBRARY_KEY, list) ? list : null;
}

export function removeFromLibrary(id: string): SavedArena[] {
  const list = loadLibrary().filter((a) => a.id !== id);
  write(LIBRARY_KEY, list);
  return list;
}

// ---------------------------------------------------------------------------
// Pictures, by the name a stage gives them (`local:…` or `croquet:…`).
// ---------------------------------------------------------------------------

interface StoredImage {
  type: string;
  /** Bytes rather than a Blob: every browser's IndexedDB stores those. */
  data: ArrayBuffer;
}

let database: Promise<IDBDatabase> | null = null;

function openDatabase() {
  if (!database) {
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(IMAGES);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('indexedDB could not be opened'));
      request.onblocked = () => reject(new Error('indexedDB is blocked'));
    });
    // A failure is not remembered, so a later try can succeed.
    opening.catch(() => {
      if (database === opening) database = null;
    });
    database = opening;
  }
  return database;
}

async function withImages<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(IMAGES, mode);
    const request = work(transaction.objectStore(IMAGES));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? request.error ?? new Error('indexedDB failed'));
  });
}

function legacyImage(src: string): string | null {
  const saved = read(LEGACY_IMAGE_KEY) as { src?: unknown; dataUrl?: unknown } | null;
  return saved && saved.src === src && typeof saved.dataUrl === 'string' ? saved.dataUrl : null;
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/** The picture kept on this device under `src`, if there is one. */
export async function loadSavedImage(src: string): Promise<Blob | null> {
  try {
    const stored = await withImages<StoredImage | undefined>('readonly', (store) => store.get(src));
    if (stored) return new Blob([stored.data], { type: stored.type });
  } catch (err) {
    console.error(err);
  }
  const dataUrl = legacyImage(src);
  if (!dataUrl) return null;
  try {
    return await (await fetch(dataUrl)).blob();
  } catch {
    return null;
  }
}

/** Keeps a picture on this device. False when it could not be stored anywhere. */
export async function saveImage(src: string, blob: Blob): Promise<boolean> {
  try {
    const stored: StoredImage = { type: blob.type || 'image/jpeg', data: await blob.arrayBuffer() };
    await withImages('readwrite', (store) => store.put(stored, src));
    return true;
  } catch (err) {
    console.error(err);
  }
  // No IndexedDB (some private windows): room for the one picture of the arena being worked on.
  try {
    return write(LEGACY_IMAGE_KEY, { src, dataUrl: await blobToDataUrl(blob) });
  } catch {
    return false;
  }
}

/** Drops every stored picture that no arena on this device names any more. */
export async function pruneImages(keep: ReadonlySet<string>) {
  try {
    const keys = await withImages('readonly', (store) => store.getAllKeys());
    for (const key of keys) {
      if (typeof key === 'string' && keep.has(key)) continue;
      await withImages('readwrite', (store) => store.delete(key));
    }
  } catch (err) {
    console.error(err);
  }
}
