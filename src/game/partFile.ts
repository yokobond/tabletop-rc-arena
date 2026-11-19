/**
 * Made-up parts as a file: what "書き出す" writes and "読み込む" reads, so parts can be carried to
 * another device or given to a friend. A part made from an STL file takes its look along, so the
 * file is all that is needed. Parts made of parts (assemblies) go in the same file, with the looks
 * of their pieces. Reading trusts nothing: every part is checked like one from storage, and a look
 * is only taken when it is one and is named by what it holds.
 */
import { readMadePart, type MadePart } from './bodyParts';
import { readAssembly, type Assembly } from './assembly';
import { decodeMesh, meshIdOf } from './stlMesh';

const FORMAT = 'rc-sumo-parts';
const VERSION = 1;
/** As many as the tray holds. */
export const MAX_FILE_PARTS = 24;
/** Far above any look (1500 triangles), and still quick to check. */
const MAX_MESH_CHARS = 200_000;
const BASE64 = /^[A-Za-z0-9+/]+=*$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A part and the bytes of its look (null for a plain box, tube or ball). */
export interface PartFileEntry {
  part: MadePart;
  mesh: Uint8Array | null;
}

/** A part made of parts and the bytes of the looks its pieces name. */
export interface AssemblyFileEntry {
  assembly: Assembly;
  meshes: Uint8Array[];
}

export interface PartFile {
  parts: PartFileEntry[];
  assemblies: AssemblyFileEntry[];
}

/** The bytes of a look as written, if they are one. */
function readMeshText(v: unknown): Uint8Array | null {
  if (typeof v !== 'string' || v.length > MAX_MESH_CHARS || !BASE64.test(v)) return null;
  try {
    const decoded = fromBase64(v);
    return decodeMesh(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

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

/** A file name the person will recognise, without the characters file systems refuse. */
export function partFileName(name: string) {
  // eslint-disable-next-line no-control-regex
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return `${safe || 'part'}.parts.json`;
}

/**
 * The file's text. A made-up part's look id is left out: the reader names it again from its
 * bytes. An assembly's pieces keep theirs, and its looks go along beside it.
 */
export function writePartFile(entries: PartFileEntry[], assemblies: AssemblyFileEntry[] = []): string {
  const parts = entries.map(({ part, mesh }) => {
    const { mesh: _id, ...plain } = part;
    return mesh ? { part: plain, mesh: toBase64(mesh) } : { part: plain };
  });
  const data: Record<string, unknown> = { format: FORMAT, version: VERSION, parts };
  if (assemblies.length) data.assemblies = assemblies.map(({ assembly, meshes }) => ({ assembly, meshes: meshes.map(toBase64) }));
  return JSON.stringify(data);
}

/**
 * The parts a file holds, each checked, or null when it is not a parts file. A part whose look is
 * missing or broken comes in as its plain shape (a piece of an assembly too); a part that is no
 * part is left out.
 */
export function readPartFile(text: string): PartFile | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.format !== FORMAT || data.version !== VERSION || !Array.isArray(data.parts)) return null;
  const parts: PartFileEntry[] = [];
  for (const item of data.parts.slice(0, MAX_FILE_PARTS)) {
    if (!isRecord(item) || !isRecord(item.part)) continue;
    const { mesh: _id, lying, turn, ...plain } = item.part;
    const bytes = readMeshText(item.mesh);
    // Without its look, a lying tube or a tilted box is just the plain shape.
    const part = readMadePart(bytes ? { ...plain, mesh: meshIdOf(bytes), lying, turn } : plain);
    if (part) parts.push({ part, mesh: bytes });
  }
  const assemblies: AssemblyFileEntry[] = [];
  const listed = Array.isArray(data.assemblies) ? data.assemblies.slice(0, MAX_FILE_PARTS) : [];
  for (const item of listed) {
    if (!isRecord(item) || !isRecord(item.assembly)) continue;
    const looks = new Map<string, Uint8Array>();
    for (const text of Array.isArray(item.meshes) ? item.meshes.slice(0, MAX_FILE_PARTS) : []) {
      const bytes = readMeshText(text);
      if (bytes) looks.set(meshIdOf(bytes), bytes);
    }
    const raw = item.assembly;
    const pieces = Array.isArray(raw.pieces)
      ? raw.pieces.map((p: unknown) => {
          if (!isRecord(p) || !isRecord(p.made) || typeof p.made.mesh !== 'string' || looks.has(p.made.mesh)) return p;
          const { mesh: _gone, lying: _lying, turn: _turn, ...plain } = p.made;
          return { ...p, made: plain };
        })
      : raw.pieces;
    const assembly = readAssembly({ ...raw, pieces });
    if (!assembly) continue;
    const used = new Set(assembly.pieces.map((p) => p.made?.mesh).filter((id): id is string => !!id));
    assemblies.push({ assembly, meshes: [...looks].filter(([id]) => used.has(id)).map(([, bytes]) => bytes) });
  }
  return { parts, assemblies };
}
