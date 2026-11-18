/**
 * The looks of parts made from STL files. A part only names its look (`m…`); the bytes are kept
 * here: in memory, in this device's storage, or on the session's file server. They are too big
 * to ride along in a design message (Croquet sends at most 16 KB at a time), so online each look
 * is put on the file server once and the model only keeps where it is (`meshRefs`).
 */
import type { CarDesign, MadePart } from '../game/bodyParts';
import { decodeMesh, meshIdOf, type PartMesh } from '../game/stlMesh';
import { currentView, fetchData, storeData } from '../net/session';

const PREFIX = 'rc-sumo-arena.mesh.';

const bytesById = new Map<string, Uint8Array>();
const looks = new Map<string, PartMesh>();
const fetching = new Set<string>();
/** `<session>|<id>` of the looks this page put on a session's file server. */
const uploaded = new Set<string>();
let version = 0;

/** Goes up whenever a look arrives: what was drawn without it can be drawn again. */
export const meshVersion = () => version;

function toBase64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Takes in a look made on this device; returns its id. Nothing is stored yet: see `keepMesh`. */
export function addMesh(bytes: Uint8Array) {
  const id = meshIdOf(bytes);
  if (!bytesById.has(id)) bytesById.set(id, bytes);
  return id;
}

/** Keeps a look on this device. False when the device would not take it. */
export function keepMesh(id: string) {
  const bytes = meshBytes(id);
  if (!bytes) return false;
  try {
    if (window.localStorage.getItem(PREFIX + id) === null) window.localStorage.setItem(PREFIX + id, toBase64(bytes));
    return true;
  } catch {
    return false;
  }
}

/** The bytes of a look, from memory or this device's storage; null when they are not here. */
export function meshBytes(id: string): Uint8Array | null {
  const known = bytesById.get(id);
  if (known) return known;
  try {
    const saved = window.localStorage.getItem(PREFIX + id);
    if (saved === null) return null;
    const bytes = fromBase64(saved);
    if (meshIdOf(bytes) !== id) return null;
    bytesById.set(id, bytes);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * A look, ready to draw, or null while it is not here. Online, one that another player brought
 * is fetched from the file server; `meshVersion` goes up when it arrives.
 */
export function meshFor(id: string): PartMesh | null {
  const known = looks.get(id);
  if (known) return known;
  const bytes = meshBytes(id);
  const look = bytes && decodeMesh(bytes);
  if (look) {
    looks.set(id, look);
    return look;
  }
  if (!bytes) fetchShared(id);
  return null;
}

function fetchShared(id: string) {
  const ref = currentView()?.model.meshRefs?.[id];
  if (!ref || fetching.has(id)) return;
  fetching.add(id);
  fetchData(ref)
    .then((data) => {
      const bytes = new Uint8Array(data);
      // Only the look the name was made from: anything else is somebody's mistake.
      if (meshIdOf(bytes) !== id || !decodeMesh(bytes)) throw new Error(`mesh ${id} does not match`);
      bytesById.set(id, bytes);
      version++;
    })
    .catch((err: unknown) => console.error(err))
    .finally(() => fetching.delete(id));
}

const meshesOf = (design: CarDesign | null) => (design?.pieces ?? []).map((p) => p.made?.mesh).filter((id): id is string => !!id);

/** Puts the looks of this design that the session does not have yet on its file server. */
export function shareMeshes(design: CarDesign | null) {
  const view = currentView();
  if (!view) return;
  for (const id of new Set(meshesOf(design))) {
    const key = `${view.model.sessionId}|${id}`;
    if (view.model.meshRefs?.[id] || uploaded.has(key)) continue;
    const bytes = meshBytes(id);
    if (!bytes) continue;
    uploaded.add(key);
    storeData(bytes.slice().buffer)
      .then((ref) => currentView()?.sendMeshRef(id, ref))
      .catch((err: unknown) => {
        console.error(err);
        uploaded.delete(key);
      });
  }
}

/** Forgets the looks on this device that no saved part or car uses any more. */
export function pruneMeshes(parts: MadePart[], designs: (CarDesign | null)[]) {
  const keep = new Set([...parts.map((p) => p.mesh), ...designs.flatMap(meshesOf)]);
  try {
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(PREFIX) && !keep.has(key.slice(PREFIX.length))) stale.push(key);
    }
    for (const key of stale) window.localStorage.removeItem(key);
  } catch {
    // Storage is blocked: nothing was kept either.
  }
}
