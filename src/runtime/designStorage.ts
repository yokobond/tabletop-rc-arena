/** The garage bodies kept on this device: one per car (1P, and 2P or the CPU). */
import { IDENTITY, readMadePart, sameOrientation, sanitizeDesign, turnOrientation, type CarDesign, type MadePart, type Quat } from '../game/bodyParts';
import { readAssembly, type Assembly } from '../game/assembly';
import { cleanCarName } from '../game/carFile';
import type { PlayerId } from '../game/types';

const DESIGNS_KEY = 'rc-sumo-arena.designs.v2';
/** Before pieces turned in 45° steps: `rot` was one of the 24 quarter turns, `seat` a face index. */
const OLD_KEY = 'rc-sumo-arena.designs.v1';

export type DesignSlots = Record<PlayerId, CarDesign | null>;

/** The 24 quarter turns in the order the old format numbered them. */
const QUARTER_TURNS: Quat[] = (() => {
  const list: Quat[] = [IDENTITY];
  for (let i = 0; i < list.length; i++) {
    for (const axis of ['x', 'y'] as const) {
      const q = turnOrientation(list[i], axis, 2);
      if (!list.some((o) => sameOrientation(o, q))) list.push(q);
    }
  }
  return list;
})();

function fromOld(raw: unknown) {
  const d = raw as { pieces?: { rot?: unknown; seat?: unknown }[] } | null;
  if (!d || !Array.isArray(d.pieces)) return raw;
  return {
    ...d,
    pieces: d.pieces.map((p) => {
      const rot = typeof p?.rot === 'number' ? QUARTER_TURNS[p.rot] : p?.rot;
      let seat: unknown;
      if (typeof p?.seat === 'number' && p.seat >= 0 && p.seat < 6) {
        // The old seat was the piece's face on the surface; now it is the surface's direction.
        const n = [0, 0, 0];
        n[p.seat >> 1] = p.seat & 1 ? -1 : 1;
        seat = n;
      }
      return { ...p, rot, seat };
    }),
  };
}

export function loadDesigns(): DesignSlots {
  try {
    const stored = window.localStorage.getItem(DESIGNS_KEY);
    const old = stored === null;
    const raw = JSON.parse(stored ?? window.localStorage.getItem(OLD_KEY) ?? 'null') as Partial<Record<PlayerId, unknown>> | null;
    const read = (v: unknown) => (v ? sanitizeDesign(old ? fromOld(v) : v) : null);
    return { p1: read(raw?.p1), p2: read(raw?.p2) };
  } catch {
    return { p1: null, p2: null };
  }
}

/** False when the device would not keep it (storage full or blocked); the car still works until the page closes. */
export function saveDesigns(designs: DesignSlots) {
  try {
    window.localStorage.setItem(DESIGNS_KEY, JSON.stringify(designs));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The parts the player made up, kept for the tray. A piece on a car carries its own copy, so
// changing or throwing one away here leaves the cars built with it as they are.
// ---------------------------------------------------------------------------
const PARTS_KEY = 'rc-sumo-arena.parts.v1';
export const MAX_MADE_PARTS = 24;

export interface SavedPart {
  id: string;
  part: MadePart;
}

export function loadMadeParts(): SavedPart[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PARTS_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    const out: SavedPart[] = [];
    for (const item of raw.slice(0, MAX_MADE_PARTS)) {
      const id = (item as { id?: unknown })?.id;
      const part = readMadePart((item as { part?: unknown })?.part);
      if (typeof id === 'string' && id && part && !out.some((p) => p.id === id)) out.push({ id, part });
    }
    return out;
  } catch {
    return [];
  }
}

/** False when the device would not keep them; they still work until the page closes. */
export function saveMadeParts(parts: SavedPart[]) {
  try {
    window.localStorage.setItem(PARTS_KEY, JSON.stringify(parts));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Parts made of parts, kept for the tray like the made-up ones.
// ---------------------------------------------------------------------------
const ASSEMBLIES_KEY = 'rc-sumo-arena.assemblies.v1';
export const MAX_ASSEMBLIES = 12;

export interface SavedAssembly {
  id: string;
  assembly: Assembly;
}

export function loadAssemblies(): SavedAssembly[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(ASSEMBLIES_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    const out: SavedAssembly[] = [];
    for (const item of raw.slice(0, MAX_ASSEMBLIES)) {
      const id = (item as { id?: unknown })?.id;
      const assembly = readAssembly((item as { assembly?: unknown })?.assembly);
      if (typeof id === 'string' && id && assembly && !out.some((a) => a.id === id)) out.push({ id, assembly });
    }
    return out;
  } catch {
    return [];
  }
}

/** False when the device would not keep them; they still work until the page closes. */
export function saveAssemblies(list: SavedAssembly[]) {
  try {
    window.localStorage.setItem(ASSEMBLIES_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** The made-up parts the pieces of the kept assemblies are, for keeping their looks. */
export const assemblyParts = (list: SavedAssembly[]) => list.flatMap((a) => a.assembly.pieces.map((p) => p.made).filter((m): m is MadePart => !!m));

// ---------------------------------------------------------------------------
// Named car bodies saved on this device, newest first.
// ---------------------------------------------------------------------------
const SAVED_CARS_KEY = 'rc-sumo-arena.saved-cars.v1';
export const MAX_SAVED_CARS = 30;

export interface SavedCar {
  id: string;
  name: string;
  /** Milliseconds since the epoch. */
  savedAt: number;
  design: CarDesign;
}

export function loadSavedCars(): SavedCar[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(SAVED_CARS_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    const list: SavedCar[] = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const { id, name, savedAt, design } = item as Record<string, unknown>;
      const clean = cleanCarName(name);
      const checked = design ? sanitizeDesign(design) : null;
      if (typeof id !== 'string' || !id || !clean || !checked || list.some((c) => c.id === id)) continue;
      list.push({
        id,
        name: clean,
        savedAt: typeof savedAt === 'number' && Number.isFinite(savedAt) ? savedAt : 0,
        design: checked,
      });
      if (list.length === MAX_SAVED_CARS) break;
    }
    return list;
  } catch {
    return [];
  }
}

/**
 * Saves a car body under a name, replacing one that already has that name. Returns the new list,
 * or null when it was not saved: invalid input, the library is full, or device storage refused.
 */
export function saveCarToLibrary(rawName: string, design: CarDesign): SavedCar[] | null {
  const name = cleanCarName(rawName);
  const checked = sanitizeDesign(design);
  if (!name || !checked) return null;
  const before = loadSavedCars();
  const old = before.find((c) => c.name === name);
  const entry: SavedCar = {
    id: old?.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name,
    savedAt: Date.now(),
    design: checked,
  };
  const list = [entry, ...before.filter((c) => c !== old)];
  if (list.length > MAX_SAVED_CARS) return null;
  try {
    window.localStorage.setItem(SAVED_CARS_KEY, JSON.stringify(list));
    return list;
  } catch {
    return null;
  }
}

export function removeSavedCar(id: string): SavedCar[] {
  const list = loadSavedCars().filter((c) => c.id !== id);
  try {
    window.localStorage.setItem(SAVED_CARS_KEY, JSON.stringify(list));
  } catch {
    // Storage is blocked: nothing could be written.
  }
  return list;
}

function writeSavedCars(list: SavedCar[]) {
  try {
    window.localStorage.setItem(SAVED_CARS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/**
 * Gives a saved car a new name, keeping its id and place in the list. Returns the new list,
 * `'taken'` when another saved car already has that name, or null when it could not be changed.
 */
export function renameSavedCar(id: string, rawName: string): SavedCar[] | 'taken' | null {
  const name = cleanCarName(rawName);
  if (!name) return null;
  const before = loadSavedCars();
  const target = before.find((c) => c.id === id);
  if (!target) return null;
  if (before.some((c) => c.id !== id && c.name === name)) return 'taken';
  const list = before.map((c) => (c.id === id ? { ...c, name } : c));
  return writeSavedCars(list) ? list : null;
}

/** Puts a new body into a saved car, keeping its id and name; it moves to the front as the newest. */
export function overwriteSavedCar(id: string, design: CarDesign): SavedCar[] | null {
  const checked = sanitizeDesign(design);
  if (!checked) return null;
  const before = loadSavedCars();
  const target = before.find((c) => c.id === id);
  if (!target) return null;
  const list = [{ ...target, design: checked, savedAt: Date.now() }, ...before.filter((c) => c.id !== id)];
  return writeSavedCars(list) ? list : null;
}

// ---------------------------------------------------------------------------
// Which saved car each garage car is (1P, and 2P or the CPU), so its name stays shown.
// ---------------------------------------------------------------------------
const CAR_LINKS_KEY = 'rc-sumo-arena.car-links.v1';

export type CarLinks = Record<PlayerId, string | null>;

export function loadCarLinks(): CarLinks {
  try {
    const raw = JSON.parse(window.localStorage.getItem(CAR_LINKS_KEY) ?? 'null') as Partial<Record<PlayerId, unknown>> | null;
    const read = (v: unknown) => (typeof v === 'string' && v ? v : null);
    return { p1: read(raw?.p1), p2: read(raw?.p2) };
  } catch {
    return { p1: null, p2: null };
  }
}

export function saveCarLink(slot: PlayerId, id: string | null) {
  const links = { ...loadCarLinks(), [slot]: id };
  try {
    window.localStorage.setItem(CAR_LINKS_KEY, JSON.stringify(links));
    return true;
  } catch {
    return false;
  }
}
