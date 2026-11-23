/**
 * A car body as a file: what "ファイルに書き出す" writes and "ファイルから読み込む" reads, so
 * a built car can be carried to another device or shared with a friend. STL part looks travel
 * inside the same file. Reading trusts nothing: every piece and joint goes through `sanitizeDesign`,
 * and every look is re-hashed from its decoded bytes.
 */
import { MAX_PIECES, sanitizeDesign, type CarDesign } from './bodyParts';
import { decodeMesh, meshIdOf } from './stlMesh';

export const CAR_NAME_LIMIT = 24;
const FORMAT = 'rc-sumo-car';
const VERSION = 1;
/** Far above any look (1500 triangles), and still quick to check. */
const MAX_MESH_CHARS = 200_000;
const MAX_FILE_MESHES = MAX_PIECES;
const BASE64 = /^[A-Za-z0-9+/]+=*$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A name as it is shown and stored: one line, no padding, not too long. */
export function cleanCarName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return [...name.replace(/\s+/g, ' ').trim()].slice(0, CAR_NAME_LIMIT).join('').trim();
}

/** A file name the person will recognise, without the characters file systems refuse. */
export function carFileName(name: string) {
  // eslint-disable-next-line no-control-regex
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return `${safe || 'car'}.car.json`;
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

export interface CarFileContent {
  name: string;
  design: CarDesign;
  /** Validated STL looks used by `design`, ready for the mesh store. */
  meshes: Uint8Array[];
  /** True when at least one STL piece lost its look and fell back to its plain shape. */
  missingLooks: boolean;
}

/**
 * The file's text. Only meshes actually named by `design` are written, once per look id.
 */
export function writeCarFile(name: string, design: CarDesign, meshes: Uint8Array[] = []): string {
  const used = new Set(design.pieces.map((p) => p.made?.mesh).filter((id): id is string => !!id));
  const encoded: string[] = [];
  const seen = new Set<string>();
  for (const bytes of meshes) {
    const id = meshIdOf(bytes);
    if (!used.has(id) || seen.has(id)) continue;
    seen.add(id);
    encoded.push(toBase64(bytes));
  }
  const data: Record<string, unknown> = {
    format: FORMAT,
    version: VERSION,
    name: cleanCarName(name),
    design,
  };
  if (encoded.length) data.meshes = encoded;
  return JSON.stringify(data);
}

function withoutMissingLooks(rawPieces: unknown, hasMesh: (id: string) => boolean) {
  let missingLooks = false;
  const pieces = Array.isArray(rawPieces)
    ? rawPieces.map((p: unknown) => {
        if (!isRecord(p) || !isRecord(p.made) || typeof p.made.mesh !== 'string' || hasMesh(p.made.mesh)) return p;
        missingLooks = true;
        const { mesh: _gone, lying: _lying, turn: _turn, ...plain } = p.made;
        return { ...p, made: plain };
      })
    : rawPieces;
  return { pieces, missingLooks };
}

/**
 * The car body a file holds, checked and cleaned, or null when it is not a valid car file.
 * Any STL piece whose look is missing, broken, or mismatched falls back to its plain shape.
 */
export function readCarFile(text: string): CarFileContent | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.format !== FORMAT || data.version !== VERSION || !isRecord(data.design)) return null;

  const looks = new Map<string, Uint8Array>();
  for (const item of Array.isArray(data.meshes) ? data.meshes.slice(0, MAX_FILE_MESHES) : []) {
    const bytes = readMeshText(item);
    if (bytes) looks.set(meshIdOf(bytes), bytes);
  }

  const rawDesign = data.design;
  const { pieces, missingLooks } = withoutMissingLooks(rawDesign.pieces, (id) => looks.has(id));

  const design = sanitizeDesign({ ...rawDesign, pieces });
  if (!design) return null;

  const used = new Set(design.pieces.map((p) => p.made?.mesh).filter((id): id is string => !!id));
  const meshes = [...looks].filter(([id]) => used.has(id)).map(([, bytes]) => bytes);
  return { name: cleanCarName(data.name), design, meshes, missingLooks };
}

/**
 * Returns a copy of `design` where any STL piece whose look is unavailable (`!hasMesh(id)`)
 * falls back to its plain collision shape.
 */
export function stripMissingMeshes(design: CarDesign, hasMesh: (id: string) => boolean): { design: CarDesign; lookLost: boolean } {
  const { pieces, missingLooks } = withoutMissingLooks(design.pieces, hasMesh);
  const checked = sanitizeDesign({ ...design, pieces });
  return { design: checked ?? design, lookLost: missingLooks };
}
