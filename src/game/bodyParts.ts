/**
 * Car bodies built in the garage: everyday things stuck onto the RC chassis with hot glue
 * (ホットグルー) or superglue (瞬間接着剤). Plain data and pure geometry, shared by the garage,
 * the physics and the replicated model, so every browser judges a design the same way.
 *
 * Coordinates are car-local like `carParts.ts`: the nose points to +Z, the wheels rest on y = 0.
 * A piece can be turned around the car's axes (45° steps or any angle), and fills its own box
 * exactly (a box) or nearly (a cylinder or a ball). Contacts and gaps are measured on those boxes,
 * turned with it.
 */

export type PieceKind =
  | 'eraser'
  | 'pencil'
  | 'brick'
  | 'cube'
  | 'matchbox'
  | 'ruler'
  | 'cap'
  | 'battery'
  | 'cup'
  | 'ball';

/**
 * Hot glue fills gaps and holds any shape, but lets go easily. Superglue only holds flat faces
 * that touch, and holds much stronger.
 */
export type Adhesive = 'hotglue' | 'superglue';
export const ADHESIVES: Adhesive[] = ['hotglue', 'superglue'];
export const ADHESIVE_LABEL: Record<Adhesive, string> = { hotglue: 'ホットグルー', superglue: '瞬間接着剤' };

/**
 * An adhesive as stored or sent. Designs from before kept double-sided tape or a strong glue
 * (セメダイン): both become hot glue now.
 */
export function readAdhesive(v: unknown): Adhesive | null {
  if (v === 'glue' || v === 'tape') return 'hotglue';
  return ADHESIVES.includes(v as Adhesive) ? (v as Adhesive) : null;
}

/** A cylinder's axis is its local Y. */
export type PieceShape =
  | { kind: 'box'; size: [number, number, number] }
  | { kind: 'cylinder'; r: number; h: number }
  | { kind: 'ball'; r: number };

export interface PieceSpec {
  kind: PartKind;
  label: string;
  shape: PieceShape;
  mass: number;
  /** Comes out of the tray lying along the car rather than standing up (long round things). */
  lying?: boolean;
  /** A made-up part's one color (`#rrggbb`); the tray's things are painted their own way. */
  color?: string;
}

/**
 * A thing the player made up in the garage: one plain shape (a box, a tube or a ball) in one color.
 * One read from an STL file also names its look (`mesh`): the shape is then only how it bumps and sticks.
 */
export interface MadePart {
  name: string;
  shape: PieceShape;
  mass: number;
  color: string;
  /** The look, by the id the mesh store keeps it under (`m` and 16 hex digits). */
  mesh?: string;
  /** A tube with a look: whether it comes out lying (its look is turned to match). */
  lying?: boolean;
  /**
   * A box with a look: how far the box was tilted around the look's x, y and z (degrees, see
   * `turnMatrix`). The look was turned the other way, so the box is square with the part as
   * always; this only lets the maker show it as the player made it.
   */
  turn?: Vec3;
}

/** How a made-up part's look is named. */
export const MESH_ID = /^m[0-9a-f]{16}$/;

/** One of the tray's things, or `made`: one the player made up, carried along in `made`. */
export type PartKind = PieceKind | 'made';

/** What a piece is. A made-up one carries its own shape, so that other browsers know it too. */
export interface PartType {
  kind: PartKind;
  made?: MadePart;
}

export interface BodyPiece {
  id: string;
  kind: PartKind;
  /** What it is, when `kind` is `made`. */
  made?: MadePart;
  /** Center, car-local. */
  x: number;
  y: number;
  z: number;
  /** How it is turned, car-local. */
  rot: Quat;
  /** What the piece was stuck on with when it was put there. */
  adhesive: Adhesive;
  /** The outward direction of the surface it was put on: turning it keeps it resting there. */
  seat?: Vec3;
  /** Pieces made into one part (see `assembly.ts`) share this: they are picked, moved and taken off together. */
  group?: string;
}

/** `a` and `b` are piece ids; `base` is the chassis. */
export interface BodyJoint {
  a: string;
  b: string;
  kind: Adhesive;
}

export interface CarDesign {
  pieces: BodyPiece[];
  joints: BodyJoint[];
}

export const BASE = 'base';
export const MAX_PIECES = 14;
/** Above this the car is too heavy to build: the chassis alone weighs 0.71. */
export const MAX_PIECE_MASS = 0.6;
/** Touching, for flat-only adhesives such as superglue. */
export const FLAT_TOLERANCE = 0.002;
/** The widest gap hot glue fills. */
export const GLUE_GAP = 0.03;
/** Faces have to overlap this much on both sides for superglue. */
const MIN_FLAT_OVERLAP = 0.008;
const EPS = 0.0015;

/** How much a car of the given body weighs (the classic car is 1). */
export const CHASSIS_MASS = 0.71;

/** Where pieces may be: the car must still fit through a fight. */
export const DESIGN_BOUNDS = { min: [-0.32, 0.02, -0.42], max: [0.32, 0.52, 0.44] } as const;

// ---------------------------------------------------------------------------
// The things in the tray.
// ---------------------------------------------------------------------------
const box = (x: number, y: number, z: number): PieceShape => ({ kind: 'box', size: [x, y, z] });

export const PIECES: PieceSpec[] = [
  { kind: 'eraser', label: '消しゴム', shape: box(0.11, 0.04, 0.06), mass: 0.06 },
  { kind: 'brick', label: 'ブロック', shape: box(0.128, 0.048, 0.064), mass: 0.05 },
  { kind: 'cube', label: '積み木', shape: box(0.07, 0.07, 0.07), mass: 0.07 },
  { kind: 'matchbox', label: 'マッチ箱', shape: box(0.1, 0.035, 0.07), mass: 0.03 },
  { kind: 'ruler', label: '定規', shape: box(0.3, 0.008, 0.045), mass: 0.04 },
  { kind: 'pencil', label: '鉛筆', shape: { kind: 'cylinder', r: 0.018, h: 0.3 }, mass: 0.03, lying: true },
  { kind: 'cap', label: 'キャップ', shape: { kind: 'cylinder', r: 0.028, h: 0.022 }, mass: 0.012 },
  { kind: 'battery', label: '乾電池', shape: { kind: 'cylinder', r: 0.025, h: 0.1 }, mass: 0.07, lying: true },
  { kind: 'cup', label: '紙コップ', shape: { kind: 'cylinder', r: 0.045, h: 0.09 }, mass: 0.02 },
  { kind: 'ball', label: 'ピンポン玉', shape: { kind: 'ball', r: 0.04 }, mass: 0.01 },
];

export const PIECE_SPEC = Object.fromEntries(PIECES.map((p) => [p.kind, p])) as Record<PieceKind, PieceSpec>;

/** How big, how heavy and how long-named a made-up part may be (meters, kilograms). */
export const MADE_LIMITS = {
  /** A box's sides, a tube's length. */
  side: [0.01, 0.3],
  /** A tube's or a ball's radius. */
  radius: [0.005, 0.08],
  mass: [0.005, 0.2],
  name: 12,
} as const;

const madeSpecs = new WeakMap<MadePart, PieceSpec>();
const UNKNOWN: PieceSpec = { kind: 'made', label: 'なにか', shape: box(0.05, 0.05, 0.05), mass: 0.05, color: '#94A3B8' };

/** What a piece is like: a tray thing's spec, or one built from the made-up part it carries. */
export function specOf(t: PartType | PieceKind): PieceSpec {
  if (typeof t === 'string') return PIECE_SPEC[t as PieceKind] ?? UNKNOWN;
  if (t.kind !== 'made') return PIECE_SPEC[t.kind];
  const m = t.made;
  if (!m) return UNKNOWN;
  let spec = madeSpecs.get(m);
  if (!spec) {
    // A tube much longer than it is thick comes out lying down, like the pencil.
    const lying = m.shape.kind === 'cylinder' && (m.mesh ? m.lying === true : m.shape.h > m.shape.r * 4);
    spec = { kind: 'made', label: m.name, shape: m.shape, mass: m.mass, color: m.color, lying };
    madeSpecs.set(m, spec);
  }
  return spec;
}

const tenthMm = (v: number) => Math.round(v * 10000) / 10000 + 0;
const within = (v: unknown, [lo, hi]: readonly [number, number]) => typeof v === 'number' && Number.isFinite(v) && v >= lo - 1e-9 && v <= hi + 1e-9;

/** A made-up part as this game accepts it (sizes to 0.1 mm, within `MADE_LIMITS`), or null. */
export function readMadePart(raw: unknown): MadePart | null {
  if (!raw || typeof raw !== 'object') return null;
  const { name, shape, mass, color, mesh, lying } = raw as Partial<MadePart>;
  if (typeof name !== 'string' || typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return null;
  const label = name.trim().slice(0, MADE_LIMITS.name);
  if (!label || !within(mass, MADE_LIMITS.mass) || !shape || typeof shape !== 'object') return null;
  let out: PieceShape;
  if (shape.kind === 'box') {
    const size = (shape as { size?: unknown }).size;
    if (!Array.isArray(size) || size.length !== 3 || !size.every((v) => within(v, MADE_LIMITS.side))) return null;
    out = { kind: 'box', size: [tenthMm(size[0]), tenthMm(size[1]), tenthMm(size[2])] };
  } else if (shape.kind === 'cylinder') {
    if (!within(shape.r, MADE_LIMITS.radius) || !within(shape.h, MADE_LIMITS.side)) return null;
    out = { kind: 'cylinder', r: tenthMm(shape.r), h: tenthMm(shape.h) };
  } else if (shape.kind === 'ball') {
    if (!within(shape.r, MADE_LIMITS.radius)) return null;
    out = { kind: 'ball', r: tenthMm(shape.r) };
  } else return null;
  const part: MadePart = { name: label, shape: out, mass: tenthMm(mass as number), color: color.toUpperCase() };
  if (mesh !== undefined) {
    if (typeof mesh !== 'string' || !MESH_ID.test(mesh)) return null;
    part.mesh = mesh;
    part.lying = out.kind === 'cylinder' && lying === true;
    const turn = (raw as Partial<MadePart>).turn;
    if (out.kind === 'box' && Array.isArray(turn) && turn.length === 3 && turn.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      const degrees = turn.map((v) => Math.max(-180, Math.min(180, Math.round(v))) + 0) as Vec3;
      if (degrees.some((v) => v !== 0)) part.turn = degrees;
    }
  }
  return part;
}

/**
 * A tilt of `degrees` around x, then y, then z (each around the fixed axes), as a matrix: what a
 * made-up box was turned by against its look.
 */
export function turnMatrix([ax, ay, az]: Vec3): Mat3 {
  const r = Math.PI / 180;
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax * r), Math.sin(ax * r), Math.cos(ay * r), Math.sin(ay * r), Math.cos(az * r), Math.sin(az * r)];
  // Rz · Ry · Rx
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

// ---------------------------------------------------------------------------
// Orientations: turned around the car's axes.
// ---------------------------------------------------------------------------
export type Vec3 = [number, number, number];
/** A rotation as a quaternion x, y, z, w (kept to 4 decimals; normalised where it is used). */
export type Quat = [number, number, number, number];
/** Row-major 3x3; its columns are the piece's own axes in car space. */
export type Mat3 = readonly number[];

export const IDENTITY: Quat = [0, 0, 0, 1];
/** One press of a 45° turn step. */
export const TURN_STEP = Math.PI / 4;

/** Length of a vector (Math.hypot is not rounded the same in every browser; the model needs that). */
const hyp = (...v: number[]) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));

/** The turn `b` then `a`. */
export const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/**
 * A rotation as this game keeps it: unit length, rounded to 4 decimals, with the sign fixed
 * (q and -q are the same turn). Null for something that is not a rotation.
 */
export function tidyQuat(q: readonly number[]): Quat | null {
  if (q.length !== 4 || !q.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const len = hyp(...q);
  if (!(len > 0.5 && len < 2)) return null;
  // Already rounded from a unit quaternion: left as it is, so that tidying again changes nothing.
  const k = Math.abs(len - 1) < 1e-3 ? 1 : len;
  const r = q.map((v) => Math.round((v / k) * 10000) / 10000 + 0);
  const lead = [r[3], r[0], r[1], r[2]].find((v) => v !== 0) ?? 1;
  return (lead < 0 ? r.map((v) => -v + 0) : r) as Quat;
}

/** `rot` turned by `radians` around a car axis (counter-clockwise looking down the positive axis). */
export function rotateOrientation(rot: Quat, axis: 'x' | 'y' | 'z', radians: number): Quat {
  const half = radians / 2;
  const t: Quat = [0, 0, 0, Math.cos(half)];
  t['xyz'.indexOf(axis)] = Math.sin(half);
  return tidyQuat(qmul(t, rot))!;
}

/** `rot` turned by `steps` eighths around a car axis (counter-clockwise looking down the positive axis). */
export function turnOrientation(rot: Quat, axis: 'x' | 'y' | 'z', steps = 1): Quat {
  return rotateOrientation(rot, axis, steps * TURN_STEP);
}

export const sameOrientation = (a: Quat, b: Quat) => {
  const p = orientationQuat(a);
  const q = orientationQuat(b);
  return Math.abs(p.x * q.x + p.y * q.y + p.z * q.z + p.w * q.w) > 0.99999;
};

/** Lying along the car (local Y turned onto Z): the tray's way for long round things. */
export const LYING = turnOrientation(IDENTITY, 'x', 2);
export const defaultRot = (t: PartType | PieceKind): Quat => (specOf(t).lying ? LYING : IDENTITY);

export function orientationQuat(rot: Quat) {
  const len = hyp(...rot) || 1;
  return { x: rot[0] / len, y: rot[1] / len, z: rot[2] / len, w: rot[3] / len };
}

/** Entries this close to 0 or ±1 are taken as exactly that, so square pieces stay square while 1° tilts remain distinct. */
const SNAP = 1e-4;

export function rotationMatrix(rot: Quat): Mat3 {
  const { x, y, z, w } = orientationQuat(rot);
  const m = [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
  return m.map((v) => (Math.abs(v) < SNAP ? 0 : Math.abs(v - 1) < SNAP ? 1 : Math.abs(v + 1) < SNAP ? -1 : v));
}

/** The rotation whose columns are the given axes (a proper rotation matrix, row-major). */
export function matrixQuat(m: Mat3): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const trace = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  return [x, y, z, w];
}

// ---------------------------------------------------------------------------
// Vectors.
// ---------------------------------------------------------------------------
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3) => hyp(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => scale(a, 1 / (length(a) || 1));

// ---------------------------------------------------------------------------
// Boxes in car space.
// ---------------------------------------------------------------------------
/**
 * A solid, turned any way: a box, a ball or a cylinder (its axis its own Y), with the box around
 * it. `flat[f]` tells whether its own face f (see FACE) is a flat surface superglue sticks to.
 */
export interface SolidBox {
  owner: string;
  shape: 'box' | 'ball' | 'cylinder';
  /** Center, car-local. */
  c: Vec3;
  /** Half size of the box around it, along its own axes (a ball: r r r; a cylinder: r h/2 r). */
  h: Vec3;
  m: Mat3;
  flat: boolean[];
}

/** Face index: axis * 2 + (1 for the positive side). */
export const FACE = { nx: 0, px: 1, ny: 2, py: 3, nz: 4, pz: 5 } as const;
export const faceAxis = (face: number) => face >> 1;
export const faceSign = (face: number) => (face & 1 ? 1 : -1);

const ALL_FLAT = [true, true, true, true, true, true];
const SQUARE: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Axis k of a box in car space. */
export const boxAxis = (b: Pick<SolidBox, 'm'>, k: number): Vec3 => [b.m[k], b.m[3 + k], b.m[6 + k]];

/** How far a solid reaches from its center in direction `n` (a unit vector). */
export function reachOf(b: Pick<SolidBox, 'shape' | 'h' | 'm'>, n: Vec3) {
  if (b.shape === 'ball') return b.h[0];
  if (b.shape === 'cylinder') {
    const a = Math.min(1, Math.abs(dot(n, boxAxis(b, 1))));
    return b.h[1] * a + b.h[0] * Math.sqrt(1 - a * a);
  }
  return [0, 1, 2].reduce((sum, k) => sum + b.h[k] * Math.abs(dot(n, boxAxis(b, k))), 0);
}

const AXES: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** The car-space box around a solid: its corners and half size. */
export function boxBounds(b: SolidBox) {
  const half = AXES.map((e) => reachOf(b, e)) as Vec3;
  return { min: sub(b.c, half), max: add(b.c, half), half };
}

/** The chassis surfaces things can be stuck to: the tub and both bumpers (see carParts.ts). */
export const BASE_BOXES: SolidBox[] = [
  { owner: BASE, shape: 'box', c: [0, 0.08, 0], h: [0.135, 0.025, 0.23], m: SQUARE, flat: ALL_FLAT },
  { owner: BASE, shape: 'box', c: [0, 0.075, 0.245], h: [0.145, 0.021, 0.015], m: SQUARE, flat: ALL_FLAT },
  { owner: BASE, shape: 'box', c: [0, 0.09, -0.22], h: [0.12, 0.018, 0.012], m: SQUARE, flat: ALL_FLAT },
];

/** The wheels turn and steer: nothing may be built into them. */
export const WHEEL_BOXES: SolidBox[] = [-1, 1].flatMap((sx) =>
  [-1, 1].map((sz): SolidBox => ({ owner: 'wheel', shape: 'box', c: [sx * 0.145, 0.058, sz * 0.145], h: [0.03, 0.062, 0.065], m: SQUARE, flat: [] })),
);

/** Half extents in the piece's own frame. */
export function localHalf(shape: PieceShape): Vec3 {
  if (shape.kind === 'box') return [shape.size[0] / 2, shape.size[1] / 2, shape.size[2] / 2];
  if (shape.kind === 'cylinder') return [shape.r, shape.h / 2, shape.r];
  return [shape.r, shape.r, shape.r];
}

const solidOf = (t: PartType | PieceKind, rot: Quat): SolidBox => {
  const shape = specOf(t).shape;
  return { owner: '', shape: shape.kind, c: [0, 0, 0], h: localHalf(shape), m: rotationMatrix(rot), flat: [] };
};

/** Half extents of the car-space box around a piece. */
export function pieceHalf(t: PartType | PieceKind, rot: Quat): Vec3 {
  return boxBounds(solidOf(t, rot)).half;
}

/** How far a piece reaches from its center in direction `n` (a unit vector). */
export function pieceReach(t: PartType | PieceKind, rot: Quat, n: Vec3) {
  return reachOf(solidOf(t, rot), n);
}

export function pieceBox(p: Pick<BodyPiece, 'id' | 'kind' | 'made' | 'x' | 'y' | 'z' | 'rot'>): SolidBox {
  const shape = specOf(p).shape;
  let flat = ALL_FLAT;
  // A ball has no flat side; a cylinder only its two round ends (its own Y).
  if (shape.kind === 'ball') flat = [false, false, false, false, false, false];
  else if (shape.kind === 'cylinder') flat = [false, false, true, true, false, false];
  return { owner: p.id, shape: shape.kind, c: [p.x, p.y, p.z], h: localHalf(shape), m: rotationMatrix(p.rot), flat };
}

/**
 * The separating-axis gap between two boxes: positive when they are apart (at most their
 * distance), negative when they overlap (by about that much).
 */
function sepGap(a: SolidBox, b: SolidBox) {
  const d = sub(b.c, a.c);
  const axes: Vec3[] = [];
  for (let k = 0; k < 3; k++) axes.push(boxAxis(a, k), boxAxis(b, k));
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const c = cross(boxAxis(a, i), boxAxis(b, j));
      if (length(c) > 1e-6) axes.push(unit(c));
    }
  }
  let worst = -Infinity;
  for (const l of axes) {
    let ra = 0;
    let rb = 0;
    for (let k = 0; k < 3; k++) {
      ra += a.h[k] * Math.abs(dot(l, boxAxis(a, k)));
      rb += b.h[k] * Math.abs(dot(l, boxAxis(b, k)));
    }
    worst = Math.max(worst, Math.abs(dot(d, l)) - ra - rb);
  }
  return worst;
}

/** Whether two solids overlap (more than just touching). Round ones are taken as they are, not as their boxes. */
export function overlaps(a: SolidBox, b: SolidBox) {
  if (sepGap(a, b) >= -EPS) return false;
  if (a.shape === 'box' && b.shape === 'box') return true;
  const shrunk = (s: SolidBox): SolidBox => ({ ...s, h: s.h.map((v) => v - EPS / 2) as Vec3 });
  return gjk(shrunk(a), shrunk(b)).hit;
}

function corners(b: SolidBox): Vec3[] {
  const out: Vec3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        out.push(add(b.c, add(scale(boxAxis(b, 0), sx * b.h[0]), add(scale(boxAxis(b, 1), sy * b.h[1]), scale(boxAxis(b, 2), sz * b.h[2])))));
      }
    }
  }
  return out;
}

function edges(b: SolidBox): [Vec3, Vec3][] {
  const out: [Vec3, Vec3][] = [];
  for (let k = 0; k < 3; k++) {
    const [u, v] = [0, 1, 2].filter((j) => j !== k);
    const along = scale(boxAxis(b, k), b.h[k]);
    for (const su of [-1, 1]) {
      for (const sv of [-1, 1]) {
        const mid = add(b.c, add(scale(boxAxis(b, u), su * b.h[u]), scale(boxAxis(b, v), sv * b.h[v])));
        out.push([sub(mid, along), add(mid, along)]);
      }
    }
  }
  return out;
}

/** The point of a box nearest to `p`. */
function nearestOnBox(b: SolidBox, p: Vec3): Vec3 {
  const d = sub(p, b.c);
  let out = b.c;
  for (let k = 0; k < 3; k++) {
    const t = Math.max(-b.h[k], Math.min(b.h[k], dot(d, boxAxis(b, k))));
    out = add(out, scale(boxAxis(b, k), t));
  }
  return out;
}

/** The nearest points of two segments. */
function nearestOnSegments(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): [Vec3, Vec3] {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const c = dot(d1, r);
  const b = dot(d1, d2);
  const denom = a * e - b * b;
  let s = denom > 1e-12 ? clamp((b * f - c * e) / denom) : 0;
  let t = (b * s + f) / e;
  if (t < 0) {
    t = 0;
    s = clamp(-c / a);
  } else if (t > 1) {
    t = 1;
    s = clamp((b - c) / a);
  }
  return [add(p1, scale(d1, s)), add(p2, scale(d2, t))];
}

/** The nearest points of two boxes that do not overlap, and how far apart they are. */
function nearest(a: SolidBox, b: SolidBox) {
  let best = { d: Infinity, pa: a.c, pb: b.c };
  const consider = (pa: Vec3, pb: Vec3) => {
    const d = length(sub(pb, pa));
    if (d < best.d) best = { d, pa, pb };
  };
  for (const v of corners(a)) consider(v, nearestOnBox(b, v));
  for (const v of corners(b)) consider(nearestOnBox(a, v), v);
  const eb = edges(b);
  for (const [p1, q1] of edges(a)) for (const [p2, q2] of eb) consider(...nearestOnSegments(p1, q1, p2, q2));
  return best;
}

/** The nearest points of two solids that do not overlap, and how far apart they are. */
function nearestSolids(a: SolidBox, b: SolidBox) {
  if (a.shape === 'box' && b.shape === 'box') return nearest(a, b);
  return gjk(a, b);
}

/** Shortest distance between two solids (0 when they touch or overlap). */
export function distance(a: SolidBox, b: SolidBox) {
  if (overlaps(a, b)) return 0;
  if (a.shape === 'box' && b.shape === 'box') return sepGap(a, b) <= 0 ? 0 : nearest(a, b).d;
  return gjk(a, b).d;
}

// ---------------------------------------------------------------------------
// Round things as they are: GJK on the real shapes.
// ---------------------------------------------------------------------------
/** The point of a solid farthest in direction `d`. */
function supportPoint(s: SolidBox, d: Vec3): Vec3 {
  if (s.shape === 'ball') {
    const len = length(d);
    return len < 1e-12 ? add(s.c, [s.h[0], 0, 0]) : add(s.c, scale(d, s.h[0] / len));
  }
  if (s.shape === 'cylinder') {
    const u = boxAxis(s, 1);
    const du = dot(d, u);
    const perp = sub(d, scale(u, du));
    const pl = length(perp);
    const end = add(s.c, scale(u, du >= 0 ? s.h[1] : -s.h[1]));
    return pl > 1e-12 ? add(end, scale(perp, s.h[0] / pl)) : end;
  }
  let p = s.c;
  for (let k = 0; k < 3; k++) {
    const ax = boxAxis(s, k);
    p = add(p, scale(ax, dot(d, ax) >= 0 ? s.h[k] : -s.h[k]));
  }
  return p;
}

/** A corner of the Minkowski difference A - B, with the points of A and B it comes from. */
interface SimplexPoint {
  w: Vec3;
  a: Vec3;
  b: Vec3;
}

/** The point of a simplex nearest the origin, as weights of the corners it needs. */
interface Closest {
  pts: SimplexPoint[];
  lambda: number[];
  v: Vec3;
}

const ORIGIN: Vec3 = [0, 0, 0];
const weigh = (pts: SimplexPoint[], lambda: number[]): Closest => ({
  pts,
  lambda,
  v: pts.reduce((acc, p, i) => add(acc, scale(p.w, lambda[i])), ORIGIN),
});
const corner = (p: SimplexPoint) => weigh([p], [1]);

function nearestOnSimplexSegment([a, b]: SimplexPoint[]): Closest {
  const ab = sub(b.w, a.w);
  const den = dot(ab, ab);
  const t = den < 1e-24 ? 0 : -dot(a.w, ab) / den;
  if (t <= 0) return corner(a);
  if (t >= 1) return corner(b);
  return weigh([a, b], [1 - t, t]);
}

/** Real-Time Collision Detection, 5.1.5, for the origin. */
function nearestOnSimplexTriangle([A, B, C]: SimplexPoint[]): Closest {
  const ab = sub(B.w, A.w);
  const ac = sub(C.w, A.w);
  const d1 = -dot(ab, A.w);
  const d2 = -dot(ac, A.w);
  if (d1 <= 0 && d2 <= 0) return corner(A);
  const d3 = -dot(ab, B.w);
  const d4 = -dot(ac, B.w);
  if (d3 >= 0 && d4 <= d3) return corner(B);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    return weigh([A, B], [1 - t, t]);
  }
  const d5 = -dot(ab, C.w);
  const d6 = -dot(ac, C.w);
  if (d6 >= 0 && d5 <= d6) return corner(C);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    return weigh([A, C], [1 - t, t]);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return weigh([B, C], [1 - t, t]);
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den;
  const w = vc * den;
  return weigh([A, B, C], [1 - v - w, v, w]);
}

/** Null when the origin is inside the tetrahedron. */
function nearestOnSimplexTetra([A, B, C, D]: SimplexPoint[]): Closest | null {
  const flat = Math.abs(dot(sub(B.w, A.w), cross(sub(C.w, A.w), sub(D.w, A.w)))) < 1e-18;
  let best: Closest | null = null;
  for (const [p0, p1, p2, opp] of [
    [A, B, C, D],
    [A, C, D, B],
    [A, D, B, C],
    [B, D, C, A],
  ]) {
    const n = cross(sub(p1.w, p0.w), sub(p2.w, p0.w));
    const outside = flat || -dot(n, p0.w) * dot(n, sub(opp.w, p0.w)) < 0;
    if (!outside) continue;
    const c = nearestOnSimplexTriangle([p0, p1, p2]);
    if (!best || dot(c.v, c.v) < dot(best.v, best.v)) best = c;
  }
  return best;
}

/**
 * The nearest points of two convex solids (GJK), or `hit` when they meet. Plain arithmetic and
 * Math.sqrt only, so every browser gets the same answer.
 */
function gjk(A: SolidBox, B: SolidBox) {
  const vert = (d: Vec3): SimplexPoint => {
    const a = supportPoint(A, d);
    const b = supportPoint(B, scale(d, -1));
    return { w: sub(a, b), a, b };
  };
  let start = sub(B.c, A.c);
  if (dot(start, start) < 1e-20) start = [1, 0, 0];
  let simplex = corner(vert(start));
  let hit = false;
  for (let i = 0; i < 64; i++) {
    const v = simplex.v;
    const vv = dot(v, v);
    if (vv < 1e-16) {
      hit = true;
      break;
    }
    const w = vert(scale(v, -1));
    // No corner closer to the origin than v: v is it.
    if (vv - dot(v, w.w) <= 1e-14 + vv * 1e-10) break;
    if (simplex.pts.some((p) => p.w[0] === w.w[0] && p.w[1] === w.w[1] && p.w[2] === w.w[2])) break;
    const pts = [...simplex.pts, w];
    const next = pts.length === 4 ? nearestOnSimplexTetra(pts) : pts.length === 3 ? nearestOnSimplexTriangle(pts) : nearestOnSimplexSegment(pts);
    if (!next) {
      hit = true;
      break;
    }
    if (dot(next.v, next.v) >= vv) break;
    simplex = next;
  }
  const pa = simplex.pts.reduce((acc, p, i) => add(acc, scale(p.a, simplex.lambda[i])), ORIGIN);
  const pb = simplex.pts.reduce((acc, p, i) => add(acc, scale(p.b, simplex.lambda[i])), ORIGIN);
  return { hit, d: hit ? 0 : length(simplex.v), pa, pb };
}

// ---------------------------------------------------------------------------
// Where two boxes meet.
// ---------------------------------------------------------------------------
type Vec2 = [number, number];

interface Face {
  /** Outward normal, the face's center, and its two in-plane half axes. */
  n: Vec3;
  c: Vec3;
  u: Vec3;
  v: Vec3;
}

function faceOf(b: SolidBox, f: number): Face {
  const k = faceAxis(f);
  const [i, j] = [0, 1, 2].filter((x) => x !== k);
  const n = scale(boxAxis(b, k), faceSign(f));
  return { n, c: add(b.c, scale(n, b.h[k])), u: scale(boxAxis(b, i), b.h[i]), v: scale(boxAxis(b, j), b.h[j]) };
}

/**
 * Where a solid really meets the plane of its face f: all of it for a box or a round end, a line
 * down the middle for a round side, a point for a ball.
 */
function patchOf(b: SolidBox, f: number): Face {
  const face = faceOf(b, f);
  const thin = 0.001;
  if (b.shape === 'ball') return { ...face, u: scale(unit(face.u), thin), v: scale(unit(face.v), thin) };
  if (b.shape === 'cylinder' && faceAxis(f) !== 1) {
    // The face's in-plane axes are the cylinder's axis and a radius: only the axis keeps its length.
    return faceAxis(f) === 0 ? { ...face, v: scale(unit(face.v), thin) } : { ...face, u: scale(unit(face.u), thin) };
  }
  return face;
}

const polyArea = (p: Vec2[]) => p.reduce((s, a, i) => s + a[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * a[1], 0) / 2;
const ccw = (p: Vec2[]) => (polyArea(p) < 0 ? [...p].reverse() : p);

/** The part of convex polygon `subject` inside convex polygon `clip` (both counter-clockwise). */
function clipPolygon(subject: Vec2[], clip: Vec2[]): Vec2[] {
  let out = subject;
  for (let i = 0; i < clip.length && out.length > 0; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const side = (p: Vec2) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j];
      const q = input[(j + 1) % input.length];
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out;
}

/** The narrowest a convex polygon is, across any direction. */
function polyWidth(p: Vec2[]) {
  let best = Infinity;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    const len = hyp(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) continue;
    let far = 0;
    for (const q of p) far = Math.max(far, Math.abs((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])) / len);
    best = Math.min(best, far);
  }
  return best === Infinity ? 0 : best;
}

/**
 * Two faces turned toward each other, `gap` apart, and the part of them that faces the other
 * (in the plane of `fa`, as a box: center, its two half axes, and the area really shared).
 */
interface FacePair {
  n: Vec3;
  gap: number;
  center: Vec3;
  u: Vec3;
  hu: number;
  hv: number;
  area: number;
  width: number;
}

function facePair(fa: Face, fb: Face): FacePair | null {
  if (dot(fa.n, fb.n) > -0.9999) return null;
  const gap = dot(sub(fb.c, fa.c), fa.n);
  const eu = unit(fa.u);
  const ev = unit(fa.v);
  const flat = (p: Vec3): Vec2 => [dot(sub(p, fa.c), eu), dot(sub(p, fa.c), ev)];
  const rect = (f: Face): Vec2[] => ccw([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => flat(add(f.c, add(scale(f.u, s), scale(f.v, t))))));
  const shared = clipPolygon(rect(fb), rect(fa));
  const area = Math.abs(polyArea(shared));
  if (shared.length < 3 || area < 1e-8) return null;
  // The bond is a strip along one face or the other, whichever wraps the shared part closer.
  let bestBox: { center: Vec3; u: Vec3; hu: number; hv: number } | null = null;
  for (const axis of [fa.u, fb.u]) {
    const a2 = unit(sub(axis, scale(fa.n, dot(axis, fa.n))));
    const b2 = cross(fa.n, a2);
    const pts = shared.map(([s, t]) => add(fa.c, add(scale(eu, s), scale(ev, t))));
    const along = pts.map((p) => dot(p, a2));
    const across = pts.map((p) => dot(p, b2));
    const hu = (Math.max(...along) - Math.min(...along)) / 2;
    const hv = (Math.max(...across) - Math.min(...across)) / 2;
    if (!bestBox || hu * hv < bestBox.hu * bestBox.hv - 1e-12) {
      const mid = add(scale(a2, (Math.max(...along) + Math.min(...along)) / 2), scale(b2, (Math.max(...across) + Math.min(...across)) / 2));
      // Back onto the face's plane.
      const center = add(mid, scale(fa.n, dot(sub(fa.c, mid), fa.n)));
      bestBox = { center, u: a2, hu, hv };
    }
  }
  return { n: fa.n, gap, ...bestBox!, area, width: polyWidth(shared) };
}

/**
 * Where two boxes meet, as the box the hot glue or superglue fills: the overlap of their
 * footprints and, across a gap, the gap itself. For superglue the faces have to touch flat on flat.
 */
export interface Bond {
  kind: Adhesive;
  /** Car-local center, half size along its own axes, and how it is turned (its Y across the joint). */
  center: Vec3;
  half: Vec3;
  rot: Quat;
  /** Area of the faces in contact (for superglue), m². */
  area: number;
}

/** A frame with `n` as its Y and `u` (in the plane) as its X. */
function frameRot(n: Vec3, u: Vec3): Quat {
  const z = cross(u, n);
  return matrixQuat([u[0], n[0], z[0], u[1], n[1], z[1], u[2], n[2], z[2]]);
}

function bondBetween(a: SolidBox, b: SolidBox, kind: Adhesive): Bond | null {
  // The boxes are around the solids, so their gap is never more than the solids' gap.
  const sep = sepGap(a, b);
  if (overlaps(a, b)) return null;
  if (kind === 'superglue') {
    if (sep > FLAT_TOLERANCE) return null;
    let best: FacePair | null = null;
    for (let i = 0; i < 6; i++) {
      if (!a.flat[i]) continue;
      for (let j = 0; j < 6; j++) {
        if (!b.flat[j]) continue;
        const pair = facePair(faceOf(a, i), faceOf(b, j));
        if (!pair || Math.abs(pair.gap) > FLAT_TOLERANCE || pair.width < MIN_FLAT_OVERLAP) continue;
        if (!best || pair.area > best.area) best = pair;
      }
    }
    if (!best) return null;
    const center = add(best.center, scale(best.n, best.gap / 2));
    return { kind, center, half: [best.hu, 0.001, best.hv], rot: frameRot(best.n, best.u), area: best.area };
  }
  if (sep > GLUE_GAP) return null;
  const near = nearestSolids(a, b);
  if (near.d > GLUE_GAP) return null;
  // Surfaces turned toward each other across the gap: a bead over the part they share.
  let best: FacePair | null = null;
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      const pair = facePair(patchOf(a, i), patchOf(b, j));
      if (!pair || pair.gap < -FLAT_TOLERANCE || pair.gap > GLUE_GAP + EPS) continue;
      if (!best || pair.area > best.area) best = pair;
    }
  }
  if (best) {
    const span = Math.max(best.gap, 0.006);
    const center = add(best.center, scale(best.n, best.gap / 2));
    const bead = (h: number) => Math.max(Math.min(h * 0.6, 0.035), 0.008);
    const half: Vec3 = [bead(best.hu), span / 2, bead(best.hv)];
    return { kind, center, half, rot: frameRot(best.n, best.u), area: 0 };
  }
  // Otherwise a dab where they come nearest: a corner, an edge, a round side.
  const across = sub(near.pb, near.pa);
  const n = length(across) > 1e-5 ? unit(across) : boxAxis(a, 1);
  const helper: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  const u = unit(cross(helper, n));
  const center = scale(add(near.pa, near.pb), 0.5);
  // A string of glue across the gap rather than a lump: thinner the longer it is.
  const thick = near.d > 0.01 ? 0.006 : 0.009;
  return { kind, center, half: [thick, Math.max(near.d, 0.006) / 2, thick], rot: frameRot(n, u), area: 0 };
}

/** The strongest bond two things allow (the chassis is several boxes). */
function bestBond(as: SolidBox[], bs: SolidBox[], kind: Adhesive) {
  let best: Bond | null = null;
  for (const a of as) {
    for (const b of bs) {
      const bond = bondBetween(a, b, kind);
      if (bond && (!best || bond.area > best.area || (bond.area === best.area && kind !== 'superglue' && volume(bond) > volume(best)))) best = bond;
    }
  }
  return best;
}
const volume = (b: Bond) => b.half[0] * b.half[1] * b.half[2];

function boxesOf(design: CarDesign, id: string) {
  if (id === BASE) return BASE_BOXES;
  const p = design.pieces.find((q) => q.id === id);
  return p ? [pieceBox(p)] : [];
}

/** The bond a joint makes, or null when the pieces no longer allow it. */
export function jointBond(design: CarDesign, joint: BodyJoint) {
  return bestBond(boxesOf(design, joint.a), boxesOf(design, joint.b), joint.kind);
}

/**
 * How much of a hit a joint takes before it lets go. Hot glue gives way fairly easily; superglue
 * holds much harder and scales with the contact area.
 */
export function jointStrength(bond: Bond) {
  if (bond.kind === 'hotglue') return 4;
  return 8 + 8 * Math.min(1, bond.area / 0.005);
}

// ---------------------------------------------------------------------------
// Whole designs.
// ---------------------------------------------------------------------------
export const emptyDesign = (): CarDesign => ({ pieces: [], joints: [] });

export function designMass(design: CarDesign) {
  return design.pieces.reduce((sum, p) => sum + specOf(p).mass, 0);
}

/** The ids reachable from the chassis through joints that hold. */
export function connectedToBase(joints: readonly BodyJoint[], holds: (index: number) => boolean = () => true) {
  const reached = new Set<string>([BASE]);
  let grew = true;
  while (grew) {
    grew = false;
    joints.forEach((j, i) => {
      if (!holds(i)) return;
      if (reached.has(j.a) !== reached.has(j.b)) {
        reached.add(j.a);
        reached.add(j.b);
        grew = true;
      }
    });
  }
  return reached;
}

export type PlaceProblem = 'bounds' | 'overlap' | 'wheel' | Adhesive | 'full' | 'heavy';

export const PROBLEM_TEXT: Record<PlaceProblem, string> = {
  bounds: '車からはみ出しすぎです。',
  overlap: 'ほかのパーツにめり込みます。',
  wheel: 'タイヤに当たります。',
  hotglue: 'くっつける相手が遠すぎます。ホットグルーで埋められるすき間は 3cm までです。',
  superglue: '瞬間接着剤は、平らな面どうしがぴったり重なるところにだけくっつけられます。',
  full: `パーツは ${MAX_PIECES} 個までです。`,
  heavy: '重すぎて走れません。',
};

/** Why a piece cannot be where it is in the design (ignoring joints), or null. */
export function placementProblem(design: CarDesign, piece: BodyPiece): PlaceProblem | null {
  const b = pieceBox(piece);
  const { min, max } = boxBounds(b);
  for (let k = 0; k < 3; k++) {
    if (min[k] < DESIGN_BOUNDS.min[k] - EPS || max[k] > DESIGN_BOUNDS.max[k] + EPS) return 'bounds';
  }
  if (WHEEL_BOXES.some((w) => overlaps(w, b))) return 'wheel';
  if (BASE_BOXES.some((w) => overlaps(w, b))) return 'overlap';
  if (design.pieces.some((p) => p.id !== piece.id && overlaps(pieceBox(p), b))) return 'overlap';
  return null;
}

/** The joints a piece makes, with its own adhesive, to everything it touches (or nearly, for hot glue). */
export function jointsFor(design: CarDesign, piece: BodyPiece): BodyJoint[] {
  const mine = [pieceBox(piece)];
  const out: BodyJoint[] = [];
  if (bestBond(mine, BASE_BOXES, piece.adhesive)) out.push({ a: BASE, b: piece.id, kind: piece.adhesive });
  for (const other of design.pieces) {
    if (other.id === piece.id) continue;
    if (bestBond(mine, [pieceBox(other)], piece.adhesive)) out.push({ a: other.id, b: piece.id, kind: piece.adhesive });
  }
  return out;
}

export interface PlaceResult {
  design: CarDesign | null;
  problem: PlaceProblem | null;
}

/** The pieces that hang on `id` alone: they reach the chassis only through it. */
export function hangingOn(design: CarDesign, id: string): string[] {
  const reached = connectedToBase(design.joints.filter((j) => j.a !== id && j.b !== id));
  return design.pieces.filter((p) => p.id !== id && !reached.has(p.id)).map((p) => p.id);
}

const roundPos = (v: number) => Math.round(v * 10000) / 10000 + 0;

/** Where `p` goes when `from` is moved to `to` and takes it along: turned with it about its center, and carried. */
function carriedAlong(from: BodyPiece, to: BodyPiece, p: BodyPiece): BodyPiece {
  const f = orientationQuat(from.rot);
  const delta = tidyQuat(qmul(to.rot, [-f.x, -f.y, -f.z, f.w]))!;
  const m = rotationMatrix(delta);
  const turn = (v: Vec3): Vec3 => [0, 1, 2].map((r) => m[r * 3] * v[0] + m[r * 3 + 1] * v[1] + m[r * 3 + 2] * v[2]) as Vec3;
  const off = turn([p.x - from.x, p.y - from.y, p.z - from.z]);
  const out: BodyPiece = { ...p, x: roundPos(to.x + off[0]), y: roundPos(to.y + off[1]), z: roundPos(to.z + off[2]), rot: tidyQuat(qmul(delta, p.rot))! };
  if (p.seat) out.seat = tidyNormal(turn(p.seat));
  return out;
}

/**
 * A piece where it is to go, with whatever hangs on it alone (and so would fall off) carried
 * along: the piece first, then those.
 */
export function movedGroup(design: CarDesign, piece: BodyPiece): BodyPiece[] {
  const old = design.pieces.find((p) => p.id === piece.id);
  if (!old) return [piece];
  const moved = old.x !== piece.x || old.y !== piece.y || old.z !== piece.z || old.rot.some((v, i) => v !== piece.rot[i]);
  const riders = hangingOn(design, piece.id).map((id) => design.pieces.find((p) => p.id === id)!);
  return [piece, ...(moved ? riders.map((r) => carriedAlong(old, piece, r)) : riders)];
}

/**
 * Puts a piece in (or moves one already there) and sticks it to what it touches with its
 * adhesive. What hangs on it alone moves with it, still stuck to it as it was; its joints to
 * everything else are made afresh where it now is.
 */
export function putPiece(design: CarDesign, piece: BodyPiece): PlaceResult {
  const existing = design.pieces.some((p) => p.id === piece.id);
  if (!existing && design.pieces.length >= MAX_PIECES) return { design: null, problem: 'full' };
  const group = movedGroup(design, piece);
  const inGroup = new Set(group.map((p) => p.id));
  const rest: CarDesign = { pieces: design.pieces.filter((p) => !inGroup.has(p.id)), joints: [] };
  for (const g of group) {
    const problem = placementProblem(rest, g);
    if (problem) return { design: null, problem };
  }
  const byId = new Map(group.map((p) => [p.id, p]));
  const pieces = existing ? design.pieces.map((p) => byId.get(p.id) ?? p) : [...design.pieces, piece];
  if (designMass({ pieces, joints: [] }) > MAX_PIECE_MASS + 1e-9) return { design: null, problem: 'heavy' };
  // Joints inside the group come along; the piece's joints to the rest are made where it is now.
  const kept = design.joints.filter((j) => (j.a !== piece.id && j.b !== piece.id) || (inGroup.has(j.a) && inGroup.has(j.b)));
  const own = jointsFor(rest, piece);
  if (own.length === 0) return { design: null, problem: piece.adhesive };
  return { design: dropLoose({ pieces, joints: [...kept, ...own] }), problem: null };
}

/** Takes a piece off, with whatever hung only on it. */
export function removePiece(design: CarDesign, id: string): CarDesign {
  return dropLoose({
    pieces: design.pieces.filter((p) => p.id !== id),
    joints: design.joints.filter((j) => j.a !== id && j.b !== id),
  });
}

/** Without joints that no longer fit and pieces that no longer reach the chassis. */
export function dropLoose(design: CarDesign): CarDesign {
  const joints = design.joints.filter((j) => jointBond(design, j) !== null);
  const reached = connectedToBase(joints);
  return {
    pieces: design.pieces.filter((p) => reached.has(p.id)),
    joints: joints.filter((j) => reached.has(j.a) && reached.has(j.b)),
  };
}

export function newPieceId(design: CarDesign) {
  let n = design.pieces.length + 1;
  while (design.pieces.some((p) => p.id === `p${n}`)) n++;
  return `p${n}`;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const GROUP_ID = /^[A-Za-z0-9_-]{1,16}$/;

/**
 * One piece from somewhere else, as this game accepts it (coordinates rounded to 0.1 mm), or null.
 * Whether it fits with the others is for the caller to check.
 */
export function readPiece(raw: unknown): BodyPiece | null {
  const p = raw as Partial<BodyPiece> | null;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || p.id.length === 0 || p.id.length > 16 || p.id === BASE) return null;
  if (typeof p.kind !== 'string' || (p.kind !== 'made' && !Object.prototype.hasOwnProperty.call(PIECE_SPEC, p.kind))) return null;
  const made = p.kind === 'made' ? readMadePart(p.made) : null;
  if (p.kind === 'made' && !made) return null;
  if (!isNum(p.x) || !isNum(p.y) || !isNum(p.z) || !Array.isArray(p.rot)) return null;
  const rot = tidyQuat(p.rot);
  if (!rot) return null;
  const adhesive: Adhesive = readAdhesive(p.adhesive) ?? 'hotglue';
  const piece: BodyPiece = { id: p.id, kind: p.kind as PartKind, x: roundPos(p.x), y: roundPos(p.y), z: roundPos(p.z), rot, adhesive };
  if (made) piece.made = made;
  const seat = Array.isArray(p.seat) && p.seat.length === 3 && p.seat.every(isNum) && length(p.seat as Vec3) > 0.5 ? unit(p.seat as Vec3) : null;
  if (seat) piece.seat = seat.map(roundPos) as Vec3;
  if (typeof p.group === 'string' && GROUP_ID.test(p.group)) piece.group = p.group;
  return piece;
}

/** Joints between the given ids, as this game accepts them (each pair once), or null when one is no joint. */
export function readJoints(raw: unknown[], ids: Set<string>): BodyJoint[] | null {
  const bonds: BodyJoint[] = [];
  for (const j of raw as Partial<BodyJoint>[]) {
    if (!j || typeof j.a !== 'string' || typeof j.b !== 'string' || j.a === j.b || !ids.has(j.a) || !ids.has(j.b)) return null;
    const kind = readAdhesive(j.kind);
    if (!kind) return null;
    if (bonds.some((k) => (k.a === j.a && k.b === j.b) || (k.a === j.b && k.b === j.a))) continue;
    bonds.push({ a: j.a, b: j.b, kind });
  }
  return bonds;
}

/**
 * A design from somewhere else (storage, a file, another player) as this game accepts it, or null.
 * Coordinates are rounded to 0.1 mm, joints are checked again, and loose pieces are dropped, so
 * that every browser that runs this on the same input builds the same car.
 */
export function sanitizeDesign(raw: unknown): CarDesign | null {
  if (!raw || typeof raw !== 'object') return null;
  const { pieces, joints } = raw as { pieces?: unknown; joints?: unknown };
  if (!Array.isArray(pieces) || !Array.isArray(joints) || pieces.length > MAX_PIECES || joints.length > MAX_PIECES * 8) return null;
  const out: BodyPiece[] = [];
  for (const raw of pieces) {
    const piece = readPiece(raw);
    if (!piece || out.some((q) => q.id === piece.id)) return null;
    out.push(piece);
  }
  const bonds = readJoints(joints, new Set([BASE, ...out.map((p) => p.id)]));
  if (!bonds) return null;
  const design = { pieces: out, joints: bonds };
  if (designMass(design) > MAX_PIECE_MASS + 1e-9) return null;
  for (const p of out) if (placementProblem(design, p)) return null;
  return dropLoose(design);
}

// ---------------------------------------------------------------------------
// Garage helpers: putting a piece against a surface, turning it in place.
// ---------------------------------------------------------------------------
const GRID = 0.005;
const snap = (v: number, step = GRID) => Math.round(v / step) * step + 0;

/** A direction with its near-zero and near-one parts made exact (a pointer's normal is never quite). */
export function tidyNormal(n: Vec3): Vec3 {
  const u = unit(n).map((v) => (Math.abs(v) < 1e-4 ? 0 : Math.abs(v - 1) < 1e-4 ? 1 : Math.abs(v + 1) < 1e-4 ? -1 : Math.round(v * 10000) / 10000 + 0));
  return unit(u as Vec3).map((v) => v + 0) as Vec3;
}

/**
 * Where a piece goes when it is held against a surface: centered on the point (on a 5 mm grid
 * in the surface by default, a numeric `grid` sets the step in meters, or `false` disables it),
 * resting on the surface. `normal` is the surface's outward direction.
 */
export function seatAgainst(point: Vec3, normal: Vec3, kind: PartType | PieceKind, rot: Quat, grid: boolean | number = true) {
  const n = tidyNormal(normal);
  const step = typeof grid === 'number' ? (grid > 0 ? grid : 0) : grid ? GRID : 0;
  // On a round surface the grid would only lift it off: it stays where it was put.
  const snapped = step > 0 ? (point.map((v) => snap(v, step)) as Vec3) : point;
  // Back onto the surface: the grid only moves it along the surface.
  const onPlane = sub(snapped, scale(n, dot(sub(snapped, point), n)));
  const c = add(onPlane, scale(n, pieceReach(kind, rot, n))).map((v) => Math.round(v * 10000) / 10000 + 0) as Vec3;
  return { x: c[0], y: c[1], z: c[2], seat: n };
}

/** The car axis nearest to a direction (straight up wins a tie: things are made to lie on the deck). */
function nearestAxis(n: Vec3): Vec3 {
  const score = n.map((v, k) => Math.abs(v) + (k === 1 ? 1e-3 : 0));
  const k = score.indexOf(Math.max(...score));
  const out: Vec3 = [0, 0, 0];
  out[k] = n[k] < 0 ? -1 : 1;
  return out;
}

/** The tilt of a slope: the smallest turn from the car axis nearest its direction onto it. */
function slopeTurn(n: Vec3): Quat {
  const from = nearestAxis(n);
  const c = dot(from, n);
  if (c > 0.999999) return IDENTITY;
  const axis = cross(from, n);
  const len = hyp(axis[0], axis[1], axis[2], 1 + c);
  return [axis[0] / len, axis[1] / len, axis[2] / len, (1 + c) / len];
}

/**
 * How a piece turned `rot` lies on a surface facing `normal`: on a slope it tilts with the slope,
 * lying on it the way it would lie on the flat. `from` is the surface it lay on so far, if any
 * (its tilt comes off first), so that moving a piece from slope to slope does not add the tilts up.
 */
export function restingOn(rot: Quat, normal: Vec3, from?: Vec3): Quat {
  let r = rot;
  if (from) {
    const [x, y, z, w] = slopeTurn(tidyNormal(from));
    r = qmul([-x, -y, -z, w], r);
  }
  return tidyQuat(qmul(slopeTurn(tidyNormal(normal)), r))!;
}

export interface SurfacePoint {
  point: Vec3;
  /** The surface's outward direction there. */
  normal: Vec3;
  /** On a ball or the side of a cylinder. */
  round: boolean;
}

/**
 * A pointer hit moved onto the surface of what it hit: a picture is never exactly where the solid
 * is. A flat face is met on its plane; a ball or the side of a cylinder on its curve, facing out
 * from it there, so that what is put on it touches it.
 */
export function onSurface(design: CarDesign, target: string, point: Vec3, normal: Vec3): SurfacePoint {
  const n = tidyNormal(normal);
  const solids = boxesOf(design, target);
  const solid = solids.length === 1 ? solids[0] : null;
  if (solid?.shape === 'ball') {
    const out = tidyNormal(length(sub(point, solid.c)) > 1e-6 ? sub(point, solid.c) : n);
    return { point: add(solid.c, scale(out, solid.h[0])), normal: out, round: true };
  }
  if (solid?.shape === 'cylinder') {
    const u = boxAxis(solid, 1);
    const t = dot(sub(point, solid.c), u);
    if (Math.abs(dot(n, u)) < 0.9) {
      const radial = sub(sub(point, solid.c), scale(u, t));
      const out = tidyNormal(length(radial) > 1e-6 ? radial : n);
      const along = Math.max(-solid.h[1], Math.min(solid.h[1], t));
      return { point: add(add(solid.c, scale(u, along)), scale(out, solid.h[0])), normal: out, round: true };
    }
  }
  let best: number | null = null;
  for (const b of solids) {
    for (let f = 0; f < 6; f++) {
      const face = faceOf(b, f);
      if (dot(face.n, n) < 0.999) continue;
      const off = dot(sub(point, face.c), face.n);
      if (best === null || Math.abs(off) < Math.abs(best)) best = off;
    }
  }
  return { point: best !== null && Math.abs(best) < 0.03 ? sub(point, scale(n, best)) : point, normal: n, round: false };
}

/** A piece turned to another orientation, still resting on the surface it was put on. */
export function turnedInPlace(piece: BodyPiece, rot: Quat): BodyPiece {
  const seat = piece.seat ?? [0, 1, 0];
  const before = pieceReach(piece, piece.rot, seat);
  const after = pieceReach(piece, rot, seat);
  // Keep the surface it touches where it was.
  const c = add([piece.x, piece.y, piece.z], scale(seat, after - before)).map((v) => Math.round(v * 10000) / 10000 + 0);
  return { ...piece, rot, x: c[0], y: c[1], z: c[2] };
}
