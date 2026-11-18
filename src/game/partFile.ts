/**
 * Made-up parts as a file: what "書き出す" writes and "読み込む" reads, so parts can be carried to
 * another device or given to a friend. A part made from an STL file takes its look along, so the
 * file is all that is needed. Reading trusts nothing: every part is checked like one from storage,
 * and a look is only taken when it is one and is named by what it holds.
 */
import { readMadePart, type MadePart } from './bodyParts';
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

/** The file's text. A look's id is left out: the reader names it again from its bytes. */
export function writePartFile(entries: PartFileEntry[]): string {
  const parts = entries.map(({ part, mesh }) => {
    const { mesh: _id, ...plain } = part;
    return mesh ? { part: plain, mesh: toBase64(mesh) } : { part: plain };
  });
  return JSON.stringify({ format: FORMAT, version: VERSION, parts });
}

/**
 * The parts a file holds, each checked, or null when it is not a parts file. A part whose look is
 * missing or broken comes in as its plain shape; a part that is no part is left out.
 */
export function readPartFile(text: string): PartFileEntry[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.format !== FORMAT || data.version !== VERSION || !Array.isArray(data.parts)) return null;
  const out: PartFileEntry[] = [];
  for (const item of data.parts.slice(0, MAX_FILE_PARTS)) {
    if (!isRecord(item) || !isRecord(item.part)) continue;
    const { mesh: _id, lying, turn, ...plain } = item.part;
    let bytes: Uint8Array | null = null;
    if (typeof item.mesh === 'string' && item.mesh.length <= MAX_MESH_CHARS && BASE64.test(item.mesh)) {
      try {
        const decoded = fromBase64(item.mesh);
        if (decodeMesh(decoded)) bytes = decoded;
      } catch {
        bytes = null;
      }
    }
    // Without its look, a lying tube or a tilted box is just the plain shape.
    const part = readMadePart(bytes ? { ...plain, mesh: meshIdOf(bytes), lying, turn } : plain);
    if (part) out.push({ part, mesh: bytes });
  }
  return out;
}
