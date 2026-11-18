/**
 * STL files made into garage parts. The file is read (binary or text), thinned to a light mesh
 * that can travel with a car, and wrapped in the plain shape that fits it closest: a box, a tube or
 * a ball. That shape is what the part bumps and sticks with; the mesh is only how it looks.
 */
import { LYING, MADE_LIMITS, rotationMatrix, turnMatrix, type Mat3, type PieceShape, type Vec3 } from './bodyParts';

/** Bigger files are refused rather than hanging the page. */
export const MAX_STL_TRIANGLES = 3_000_000;
/** What a part's look may have, so that it stays a few KB. */
export const MAX_MESH_TRIANGLES = 1500;

/** A mesh as vertices (xyz, Y up) and triangles (three vertex numbers each). */
export interface SourceMesh {
  pos: Float32Array;
  idx: Uint32Array;
}

export type StlProblem = 'empty' | 'too-big' | 'unreadable';

export class StlError extends Error {
  constructor(readonly problem: StlProblem) {
    super(`stl: ${problem}`);
  }
}

// ---------------------------------------------------------------------------
// Reading.
// ---------------------------------------------------------------------------

/**
 * The triangles of an STL file, welded into a mesh, in the file's units (millimeters, almost
 * always). STL files stand on Z; here Y is up, as in the game.
 */
export function readStl(buf: ArrayBuffer): SourceMesh {
  const soup = isBinary(buf) ? readBinary(buf) : readText(buf);
  if (soup.length < 9) throw new StlError('empty');
  return cluster(soup, null, WELD_CELLS);
}

function isBinary(buf: ArrayBuffer) {
  if (buf.byteLength < 84) return false;
  const n = new DataView(buf).getUint32(80, true);
  if (84 + n * 50 === buf.byteLength) return true;
  // Text files start with "solid"; some binary ones do too, so only the size settles it.
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 512)));
  return !/^\s*solid[\s\S]*facet/.test(head) && n > 0 && 84 + n * 50 <= buf.byteLength;
}

/** Z up in the file becomes Y up here: (x, y, z) → (x, z, −y). */
function pushUp(out: number[] | Float32Array, at: number, x: number, y: number, z: number) {
  out[at] = x;
  out[at + 1] = z;
  out[at + 2] = -y;
}

function readBinary(buf: ArrayBuffer): Float32Array {
  const view = new DataView(buf);
  const n = view.getUint32(80, true);
  if (n > MAX_STL_TRIANGLES) throw new StlError('too-big');
  const out = new Float32Array(n * 9);
  let k = 0;
  for (let t = 0; t < n; t++) {
    const at = 84 + t * 50 + 12;
    let finite = true;
    for (let v = 0; v < 9; v++) if (!Number.isFinite(view.getFloat32(at + v * 4, true))) finite = false;
    if (!finite) continue;
    for (let v = 0; v < 3; v++) {
      const p = at + v * 12;
      pushUp(out, k, view.getFloat32(p, true), view.getFloat32(p + 4, true), view.getFloat32(p + 8, true));
      k += 3;
    }
  }
  return out.subarray(0, k);
}

function readText(buf: ArrayBuffer): Float32Array {
  const text = new TextDecoder().decode(buf);
  if (!/facet/.test(text)) throw new StlError('unreadable');
  const out: number[] = [];
  const vertex = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  let corner: number[] = [];
  for (let m = vertex.exec(text); m; m = vertex.exec(text)) {
    corner.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (corner.length < 9) continue;
    if (corner.every(Number.isFinite)) for (let v = 0; v < 9; v += 3) pushUp(out, out.length, corner[v], corner[v + 1], corner[v + 2]);
    corner = [];
    if (out.length / 9 > MAX_STL_TRIANGLES) throw new StlError('too-big');
  }
  return new Float32Array(out);
}

// ---------------------------------------------------------------------------
// Thinning: vertices in the same little cube become one (vertex clustering).
// ---------------------------------------------------------------------------
const WELD_CELLS = 131071;

function bounds(pos: Float32Array) {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/**
 * Merges the vertices that fall in the same cell of a grid `cells` cells across the mesh's longest
 * side (each becomes their average) and drops the triangles that collapse or repeat. `idx` null
 * reads `pos` as loose triangles.
 */
function cluster(pos: Float32Array, idx: Uint32Array | null, cells: number): SourceMesh {
  const { min, max } = bounds(pos);
  const longest = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (!(longest > 0)) throw new StlError('empty');
  const cell = longest / cells;
  const span = [0, 1, 2].map((k) => Math.floor((max[k] - min[k]) / cell) + 1);
  const ids = new Map<number, number>();
  const sums: number[] = [];
  const counts: number[] = [];
  const nv = pos.length / 3;
  const remap = new Uint32Array(nv);
  for (let v = 0; v < nv; v++) {
    const x = pos[v * 3];
    const y = pos[v * 3 + 1];
    const z = pos[v * 3 + 2];
    const ix = Math.min(span[0] - 1, Math.floor((x - min[0]) / cell));
    const iy = Math.min(span[1] - 1, Math.floor((y - min[1]) / cell));
    const iz = Math.min(span[2] - 1, Math.floor((z - min[2]) / cell));
    const key = (ix * span[1] + iy) * span[2] + iz;
    let id = ids.get(key);
    if (id === undefined) {
      id = counts.length;
      ids.set(key, id);
      sums.push(0, 0, 0);
      counts.push(0);
    }
    sums[id * 3] += x;
    sums[id * 3 + 1] += y;
    sums[id * 3 + 2] += z;
    counts[id]++;
    remap[v] = id;
  }
  const out = new Float32Array(sums.length);
  for (let i = 0; i < counts.length; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = sums[i * 3 + k] / counts[i];
  const nt = idx ? idx.length / 3 : nv / 3;
  const tris: number[] = [];
  const seen = new Set<string>();
  for (let t = 0; t < nt; t++) {
    const a = remap[idx ? idx[t * 3] : t * 3];
    const b = remap[idx ? idx[t * 3 + 1] : t * 3 + 1];
    const c = remap[idx ? idx[t * 3 + 2] : t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    const key = [a, b, c].sort((p, q) => p - q).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    tris.push(a, b, c);
  }
  // Vertices whose triangles all collapsed are dropped.
  const used = new Int32Array(counts.length).fill(-1);
  const kept: number[] = [];
  const idxOut = new Uint32Array(tris.length);
  for (let i = 0; i < tris.length; i++) {
    const v = tris[i];
    if (used[v] < 0) {
      used[v] = kept.length / 3;
      kept.push(out[v * 3], out[v * 3 + 1], out[v * 3 + 2]);
    }
    idxOut[i] = used[v];
  }
  return { pos: new Float32Array(kept), idx: idxOut };
}

/** The mesh with at most `limit` triangles: coarser grids until it fits. */
export function thinMesh(mesh: SourceMesh, limit = MAX_MESH_TRIANGLES): SourceMesh {
  let tris = mesh.idx.length / 3;
  if (tris <= limit) return mesh;
  let cells = 128;
  for (let tries = 0; tries < 24; tries++) {
    const thin = cluster(mesh.pos, mesh.idx, cells);
    tris = thin.idx.length / 3;
    if (tris <= limit || cells <= 2) return thin;
    // Triangles go with the square of the grid.
    cells = Math.max(2, Math.min(cells - 1, Math.floor(cells * Math.sqrt(limit / tris) * 0.95)));
  }
  return cluster(mesh.pos, mesh.idx, 2);
}

// ---------------------------------------------------------------------------
// The shape it bumps with: the biggest box, tube or ball that fits inside the mesh, so that
// nothing bumps or sticks where the look has no body (a fin, a nose cone, a hollow).
// ---------------------------------------------------------------------------

/**
 * The grid the inside is found in: at most this many cells along the longest side and in all.
 * Long thin things get small cells, so their thickness is still many cells across.
 */
const MAX_SPAN = 128;
const MAX_CELLS = 300_000;
/** The mesh is thinned to this before it is cut into cells: enough to find its inside. */
const VOXEL_TRIANGLES = 20000;

/** A plain shape inside the mesh, in the mesh's units. */
interface Inner {
  center: Vec3;
  /** Box: its sides. */
  size?: Vec3;
  /** Tube or ball. */
  r?: number;
  /** Tube: its length. */
  h?: number;
}

/** What fitting needs to know about a mesh, in its own units. */
export interface MeshMeasure {
  /** The middle of its bounding box. */
  mid: Vec3;
  size: Vec3;
  /** What it holds (0 for a mesh that is not closed). */
  volume: number;
  /** The biggest of each shape found inside it; a tube along x, y and z. */
  box: Inner;
  cylinder: [Inner, Inner, Inner];
  ball: Inner;
}

/** A grid of cells around the mesh, one empty cell wider on every side; `solid` is 1 inside. */
interface Voxels {
  dims: [number, number, number];
  cell: number;
  /** Where cell (0, 0, 0) starts. */
  origin: Vec3;
  solid: Uint8Array;
}

/**
 * Which cells the mesh fills: the cells its surface passes through, and every cell the outside
 * cannot reach without crossing them. A mesh with a hole bigger than a cell is only its skin.
 */
function voxelize(mesh: SourceMesh, min: Vec3, size: Vec3): Voxels {
  const cell = Math.max(Math.max(...size) / MAX_SPAN, Math.cbrt((size[0] * size[1] * size[2]) / MAX_CELLS));
  const n = size.map((s) => Math.max(1, Math.ceil(s / cell - 1e-9)));
  const dims = n.map((v) => v + 2) as [number, number, number];
  const [, Y, Z] = dims;
  const origin = min.map((m) => m - cell) as Vec3;
  const total = dims[0] * Y * Z;
  const wall = new Uint8Array(total);
  const p = mesh.pos;
  const at = (v: number, k: number) => Math.min(n[k], Math.max(1, Math.floor((v - origin[k]) / cell)));
  for (let t = 0; t < mesh.idx.length; t += 3) {
    const a = mesh.idx[t] * 3;
    const b = mesh.idx[t + 1] * 3;
    const c = mesh.idx[t + 2] * 3;
    const edge = Math.max(Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]), Math.hypot(p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]), Math.hypot(p[c] - p[b], p[c + 1] - p[b + 1], p[c + 2] - p[b + 2]));
    // Points on the triangle closer together than half a cell touch every cell it passes through.
    const k = Math.min(400, Math.ceil(edge / (cell * 0.5)) + 1);
    for (let i = 0; i <= k; i++)
      for (let j = 0; i + j <= k; j++) {
        const u = i / k;
        const w = j / k;
        const x = p[a] + (p[b] - p[a]) * u + (p[c] - p[a]) * w;
        const y = p[a + 1] + (p[b + 1] - p[a + 1]) * u + (p[c + 1] - p[a + 1]) * w;
        const z = p[a + 2] + (p[b + 2] - p[a + 2]) * u + (p[c + 2] - p[a + 2]) * w;
        wall[(at(x, 0) * Y + at(y, 1)) * Z + at(z, 2)] = 1;
      }
  }
  // Flood the outside from a corner; whatever it does not reach is inside.
  const outside = new Uint8Array(total);
  const stack = new Int32Array(total);
  let top = 0;
  stack[top++] = 0;
  outside[0] = 1;
  const steps = [Y * Z, -Y * Z, Z, -Z, 1, -1];
  while (top > 0) {
    const i = stack[--top];
    const x = Math.floor(i / (Y * Z));
    const y = Math.floor(i / Z) % Y;
    const z = i % Z;
    const next = [x + 1 < dims[0], x > 0, y + 1 < Y, y > 0, z + 1 < Z, z > 0];
    for (let s = 0; s < 6; s++) {
      if (!next[s]) continue;
      const j = i + steps[s];
      if (outside[j] || wall[j]) continue;
      outside[j] = 1;
      stack[top++] = j;
    }
  }
  const solid = new Uint8Array(total);
  for (let i = 0; i < total; i++) solid[i] = outside[i] ? 0 : 1;
  return { dims, cell, origin, solid };
}

const FAR = 1e9;

/** Squared distance (in cells) from each cell to the nearest empty one, along the given axes only. */
function emptyDistance(g: Voxels, axes: number[]) {
  const [X, Y, Z] = g.dims;
  const stride = [Y * Z, Z, 1];
  const d = new Float64Array(g.solid.length);
  for (let i = 0; i < d.length; i++) d[i] = g.solid[i] ? FAR : 0;
  const longest = Math.max(X, Y, Z);
  const f = new Float64Array(longest);
  const out = new Float64Array(longest);
  const v = new Int32Array(longest);
  const zs = new Float64Array(longest + 1);
  for (const axis of axes) {
    const len = g.dims[axis];
    const [o1, o2] = [0, 1, 2].filter((k) => k !== axis);
    for (let a = 0; a < g.dims[o1]; a++)
      for (let b = 0; b < g.dims[o2]; b++) {
        const base = a * stride[o1] + b * stride[o2];
        for (let q = 0; q < len; q++) f[q] = d[base + q * stride[axis]];
        // Felzenszwalb & Huttenlocher: the lower envelope of parabolas.
        let k = 0;
        v[0] = 0;
        zs[0] = -Infinity;
        zs[1] = Infinity;
        for (let q = 1; q < len; q++) {
          let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
          while (s <= zs[k]) {
            k--;
            s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
          }
          k++;
          v[k] = q;
          zs[k] = s;
          zs[k + 1] = Infinity;
        }
        k = 0;
        for (let q = 0; q < len; q++) {
          while (zs[k + 1] < q) k++;
          out[q] = (q - v[k]) ** 2 + f[v[k]];
        }
        for (let q = 0; q < len; q++) d[base + q * stride[axis]] = out[q];
      }
  }
  return d;
}

/**
 * The biggest shapes inside the filled cells. A cell the surface passes through counts as
 * filled though part of it is outside, so every shape gives up one cell: half a cell at each
 * side of a box, and a cell of a radius.
 */
function innerShapes(g: Voxels): Pick<MeshMeasure, 'box' | 'cylinder' | 'ball'> {
  const [X, Y, Z] = g.dims;
  const { cell, origin } = g;
  const centerOf = (x: number, y: number, z: number): Vec3 => [origin[0] + (x + 0.5) * cell, origin[1] + (y + 0.5) * cell, origin[2] + (z + 0.5) * cell];
  const coords = (i: number): Vec3 => [Math.floor(i / (Y * Z)), Math.floor(i / Z) % Y, i % Z];

  // Ball: around the cell farthest from the outside.
  const d3 = emptyDistance(g, [0, 1, 2]);
  let deepest = 0;
  for (let i = 1; i < d3.length; i++) if (d3[i] > d3[deepest]) deepest = i;
  const ball: Inner = { center: centerOf(...coords(deepest)), r: Math.max(0, Math.sqrt(d3[deepest]) - 1) * cell };

  // Tube along each axis: for every line of cells, the run of slices whose discs around it are
  // all inside that holds the most (radius² × length).
  const cylinder = ([0, 1, 2] as const).map((axis): Inner => {
    const [o1, o2] = [0, 1, 2].filter((k) => k !== axis);
    const d2 = emptyDistance(g, [o1, o2]);
    const stride = [Y * Z, Z, 1];
    const len = g.dims[axis];
    let best = { volume: -1, a: 1, b: 1, s: 1, e: 1, r: 0 };
    for (let a = 1; a < g.dims[o1] - 1; a++)
      for (let b = 1; b < g.dims[o2] - 1; b++) {
        const base = a * stride[o1] + b * stride[o2];
        for (let s = 1; s < len - 1; s++) {
          let r = Infinity;
          for (let e = s; e < len - 1; e++) {
            r = Math.min(r, Math.sqrt(d2[base + e * stride[axis]]) - 1);
            if (r <= 0) break;
            const volume = r * r * (e - s);
            if (volume > best.volume) best = { volume, a, b, s, e, r };
          }
        }
      }
    const at: Vec3 = [0, 0, 0];
    at[o1] = best.a;
    at[o2] = best.b;
    at[axis] = (best.s + best.e) / 2;
    return { center: centerOf(...at), r: best.r * cell, h: (best.e - best.s) * cell };
  });

  // Box: grown a cell at a time on each side from the deepest cells while it stays inside.
  const P = new Int32Array((X + 1) * (Y + 1) * (Z + 1));
  const pi = (x: number, y: number, z: number) => (x * (Y + 1) + y) * (Z + 1) + z;
  for (let x = 0; x < X; x++)
    for (let y = 0; y < Y; y++)
      for (let z = 0; z < Z; z++)
        P[pi(x + 1, y + 1, z + 1)] =
          g.solid[(x * Y + y) * Z + z] +
          P[pi(x, y + 1, z + 1)] + P[pi(x + 1, y, z + 1)] + P[pi(x + 1, y + 1, z)] -
          P[pi(x, y, z + 1)] - P[pi(x, y + 1, z)] - P[pi(x + 1, y, z)] +
          P[pi(x, y, z)];
  const full = (lo: number[], hi: number[]) => {
    const [x0, y0, z0] = lo;
    const [x1, y1, z1] = hi.map((v) => v + 1);
    const sum = P[pi(x1, y1, z1)] - P[pi(x0, y1, z1)] - P[pi(x1, y0, z1)] - P[pi(x1, y1, z0)] + P[pi(x0, y0, z1)] + P[pi(x0, y1, z0)] + P[pi(x1, y0, z0)] - P[pi(x0, y0, z0)];
    return sum === (x1 - x0) * (y1 - y0) * (z1 - z0);
  };
  const seeds = Array.from(d3.keys())
    .filter((i) => d3[i] > 0)
    .sort((p, q) => d3[q] - d3[p])
    .slice(0, 24);
  let box: Inner = { center: ball.center, size: [0, 0, 0] };
  let boxVolume = -1;
  for (const seed of seeds) {
    const lo = coords(seed);
    const hi = coords(seed);
    for (let grew = true; grew; ) {
      grew = false;
      for (let k = 0; k < 3; k++) {
        const up = [...hi];
        up[k]++;
        if (full([...lo.slice(0, k), up[k], ...lo.slice(k + 1)], up)) {
          hi[k]++;
          grew = true;
        }
        const down = [...lo];
        down[k]--;
        if (full(down, [...hi.slice(0, k), down[k], ...hi.slice(k + 1)])) {
          lo[k]--;
          grew = true;
        }
      }
    }
    const size = [0, 1, 2].map((k) => (hi[k] - lo[k]) * cell) as Vec3;
    const volume = size[0] * size[1] * size[2];
    if (volume > boxVolume) {
      boxVolume = volume;
      box = { center: centerOf((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2), size };
    }
  }
  return { box, cylinder: cylinder as [Inner, Inner, Inner], ball };
}

export function measureMesh(mesh: SourceMesh): MeshMeasure {
  const { min, max } = bounds(mesh.pos);
  const size: Vec3 = [0, 1, 2].map((k) => max[k] - min[k]) as Vec3;
  // Signed volume of the tetrahedra to a point: right for a closed mesh, whichever way it faces.
  let volume = 0;
  const p = mesh.pos;
  const q = mesh.idx;
  for (let t = 0; t < q.length; t += 3) {
    const a = q[t] * 3;
    const b = q[t + 1] * 3;
    const c = q[t + 2] * 3;
    const ax = p[a] - min[0], ay = p[a + 1] - min[1], az = p[a + 2] - min[2];
    const bx = p[b] - min[0], by = p[b + 1] - min[1], bz = p[b + 2] - min[2];
    const cx = p[c] - min[0], cy = p[c + 1] - min[1], cz = p[c + 2] - min[2];
    volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  volume = Math.abs(volume) / 6;
  // An open mesh gives nonsense: no more than its box can hold.
  if (volume > size[0] * size[1] * size[2]) volume = 0;
  const mid = [0, 1, 2].map((k) => (min[k] + max[k]) / 2) as Vec3;
  return { mid, size, volume, ...innerShapes(voxelize(thinMesh(mesh, VOXEL_TRIANGLES), min, size)) };
}

export type FitKind = 'box' | 'cylinder' | 'ball';

export interface ShapeFit {
  shape: PieceShape;
  /** Where its middle is in the mesh (the mesh's units): the part's center. */
  center: Vec3;
  /** A tube's axis in the mesh: 0 x, 1 y (standing), 2 z. */
  axis: 0 | 1 | 2;
  /** How much of the mesh it holds, for choosing among the shapes. */
  volume: number;
}

/** Down to 0.1 mm, so that rounding never takes it outside the look. */
const floorTenthMm = (v: number) => Math.floor(v * 10000 + 0.01) / 10000;
/** Within what a made-up part may be. Something thinner than a part may be has to stick out a little. */
const limit = (v: number, [lo, hi]: readonly [number, number]) => Math.max(lo, Math.min(hi, floorTenthMm(v)));

/**
 * The shapes inside the mesh at `scale` (its units to meters). Bigger than a made-up part may be,
 * a shape is made smaller, so it stays inside; thinner than one may be, it has to stick out.
 */
export function fitShapes(m: MeshMeasure, scale: number): Record<FitKind, ShapeFit | null> {
  const { side, radius } = MADE_LIMITS;
  const fits: Record<FitKind, ShapeFit | null> = { box: null, cylinder: null, ball: null };
  // What a shape holds is counted as far as it is inside the mesh.
  const held = (v: number, [, hi]: readonly [number, number]) => Math.min(v, hi);
  const sz = m.box.size!.map((v) => v * scale);
  fits.box = {
    shape: { kind: 'box', size: sz.map((v) => limit(v, side)) as Vec3 },
    center: m.box.center,
    axis: 1,
    volume: sz.reduce((p, v) => p * held(v, side), 1),
  };
  // Standing up wins a tie, then lying along the car.
  for (const axis of [1, 2, 0] as const) {
    const c = m.cylinder[axis];
    const r = c.r! * scale;
    const h = c.h! * scale;
    const volume = Math.PI * held(r, radius) ** 2 * held(h, side);
    if (fits.cylinder && volume <= fits.cylinder.volume * 1.001) continue;
    fits.cylinder = { shape: { kind: 'cylinder', r: limit(r, radius), h: limit(h, side) }, center: c.center, axis, volume };
  }
  const r = m.ball.r! * scale;
  fits.ball = { shape: { kind: 'ball', r: limit(r, radius) }, center: m.ball.center, axis: 1, volume: (4 / 3) * Math.PI * held(r, radius) ** 3 };
  return fits;
}

/** The one of the fits that holds the most of the mesh. */
export function bestFit(fits: Record<FitKind, ShapeFit | null>): FitKind | null {
  let best: FitKind | null = null;
  for (const kind of ['box', 'cylinder', 'ball'] as const) {
    const f = fits[kind];
    if (f && (!best || f.volume > fits[best]!.volume * 1.001)) best = kind;
  }
  return best;
}

// ---------------------------------------------------------------------------
// The look as bytes: what a part carries (by id) and what goes to other browsers.
// ---------------------------------------------------------------------------
const MESH_VERSION = 1;
const HEADER = 8;
/** Vertices are kept to 0.1 mm. */
const UNIT = 10000;

const R_Y90: Mat3 = [0, 0, 1, 0, 1, 0, -1, 0, 0];
const mulMat = (a: Mat3, b: Mat3): Mat3 =>
  [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]));
const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/**
 * The mesh at `scale`, centered on its shape and turned into the part's own frame, as bytes. A tube that
 * lies (its axis along x or z) is turned so that its axis is the part's Y and comes out lying:
 * the look ends up the way the player saw it, at most turned a quarter around. A box tilted by
 * `tilt` (degrees, see `turnMatrix`) turns the look back by as much instead.
 */
export function bakeMesh(mesh: SourceMesh, scale: number, fit: ShapeFit, tilt?: Vec3): { bytes: Uint8Array; lying: boolean } {
  const lying = fit.shape.kind === 'cylinder' && fit.axis !== 1;
  const unlie = transpose(rotationMatrix(LYING));
  // A tilted box: the look is turned back by as much, so the box is square with the part again.
  const tilted = fit.shape.kind === 'box' && tilt?.some((v) => v !== 0);
  const turn: Mat3 | null = tilted ? transpose(turnMatrix(tilt!)) : !lying ? null : fit.axis === 2 ? unlie : mulMat(unlie, R_Y90);
  const nv = mesh.pos.length / 3;
  const nt = mesh.idx.length / 3;
  const bytes = new Uint8Array(HEADER + nv * 6 + nt * 6);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, MESH_VERSION);
  view.setUint16(2, nv, true);
  view.setUint32(4, nt, true);
  const q = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * UNIT)));
  for (let v = 0; v < nv; v++) {
    let x = (mesh.pos[v * 3] - fit.center[0]) * scale;
    let y = (mesh.pos[v * 3 + 1] - fit.center[1]) * scale;
    let z = (mesh.pos[v * 3 + 2] - fit.center[2]) * scale;
    if (turn) [x, y, z] = [0, 3, 6].map((r) => turn[r] * x + turn[r + 1] * y + turn[r + 2] * z);
    view.setInt16(HEADER + v * 6, q(x), true);
    view.setInt16(HEADER + v * 6 + 2, q(y), true);
    view.setInt16(HEADER + v * 6 + 4, q(z), true);
  }
  const at = HEADER + nv * 6;
  for (let i = 0; i < nt * 3; i++) view.setUint16(at + i * 2, mesh.idx[i], true);
  return { bytes, lying };
}

/** A part's look: vertices in meters in the part's frame, and triangles. */
export interface PartMesh {
  pos: Float32Array;
  idx: Uint16Array;
}

/** The look a part's bytes hold, or null when they are not one. */
export function decodeMesh(bytes: Uint8Array): PartMesh | null {
  if (bytes.length < HEADER) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== MESH_VERSION) return null;
  const nv = view.getUint16(2, true);
  const nt = view.getUint32(4, true);
  if (nv < 3 || nt < 1 || nt > MAX_MESH_TRIANGLES || bytes.length !== HEADER + nv * 6 + nt * 6) return null;
  const pos = new Float32Array(nv * 3);
  for (let i = 0; i < nv * 3; i++) pos[i] = view.getInt16(HEADER + i * 2, true) / UNIT;
  const idx = new Uint16Array(nt * 3);
  const at = HEADER + nv * 6;
  for (let i = 0; i < nt * 3; i++) {
    const v = view.getUint16(at + i * 2, true);
    if (v >= nv) return null;
    idx[i] = v;
  }
  return { pos, idx };
}

/**
 * A part's look back as a mesh to make it again (bigger, smaller, another shape), in meters and
 * the way it stood in the maker: a lying tube's look is turned back up.
 */
export function unbakeMesh(look: PartMesh, lying: boolean, tilt?: Vec3): SourceMesh {
  const pos = new Float32Array(look.pos);
  if (lying || tilt) {
    const m = tilt ? turnMatrix(tilt) : rotationMatrix(LYING);
    for (let i = 0; i < pos.length; i += 3) {
      const [x, y, z] = [pos[i], pos[i + 1], pos[i + 2]];
      for (let r = 0; r < 3; r++) pos[i + r] = m[r * 3] * x + m[r * 3 + 1] * y + m[r * 3 + 2] * z;
    }
  }
  return { pos, idx: Uint32Array.from(look.idx) };
}

/** A name for the look made from its bytes, so that the same look always has the same name. */
export function meshIdOf(bytes: Uint8Array) {
  let h1 = 0xdeadbeef ^ bytes.length;
  let h2 = 0x41c6ce57 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 2654435761);
    h2 = Math.imul(h2 ^ bytes[i], 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (h: number) => (h >>> 0).toString(16).padStart(8, '0');
  return `m${hex(h1)}${hex(h2)}`;
}
