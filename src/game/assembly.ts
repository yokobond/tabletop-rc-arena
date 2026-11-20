/**
 * Parts made of parts: pieces stuck together on a car, made into one (組み部品). On the car they
 * share a `group` and are picked, moved, turned and taken off together; in the tray they are an
 * `Assembly`, kept and carried in files like a made-up part, and put on a car in one go.
 *
 * Each piece stays a piece of its own, with its joints to the others, so the physics, the model
 * and the rules for what sticks are the same as for pieces put on one by one. Plain data and pure
 * geometry like `bodyParts.ts`.
 */
import {
  BASE,
  IDENTITY,
  MADE_LIMITS,
  MAX_PIECES,
  MAX_PIECE_MASS,
  boxBounds,
  connectedToBase,
  designMass,
  dropLoose,
  jointBond,
  jointsFor,
  overlaps,
  pieceBox,
  pieceReach,
  placementProblem,
  qmul,
  readJoints,
  readPiece,
  rotationMatrix,
  tidyNormal,
  tidyQuat,
  type Adhesive,
  type BodyJoint,
  type BodyPiece,
  type CarDesign,
  type PlaceResult,
  type Quat,
  type Vec3,
} from './bodyParts';

/**
 * Pieces made into one part, in its own frame: the box around them is centered on the origin,
 * and its pieces are named `a1`, `a2`, … Its joints are the ones between its pieces.
 */
export interface Assembly {
  name: string;
  pieces: BodyPiece[];
  joints: BodyJoint[];
}

const round = (v: number) => Math.round(v * 10000) / 10000 + 0;
const GRID = 0.005;
const snap = (v: number, step = GRID) => Math.round(v / step) * step + 0;
/** How far from its center an assembly's piece may be (well beyond any car). */
const FAR = 1;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const turn = (m: readonly number[], v: Vec3): Vec3 => [0, 1, 2].map((r) => m[r * 3] * v[0] + m[r * 3 + 1] * v[1] + m[r * 3 + 2] * v[2]) as Vec3;

// ---------------------------------------------------------------------------
// Groups on a car.
// ---------------------------------------------------------------------------
/** The pieces made into one with `id` (just it when it is on its own). */
export function groupOf(design: CarDesign, id: string): string[] {
  const group = design.pieces.find((p) => p.id === id)?.group;
  if (!group) return [id];
  return design.pieces.filter((p) => p.group === group).map((p) => p.id);
}

/** The pieces stuck to `id` through other pieces rather than the chassis, it first; whole groups. */
export function stuckTogether(design: CarDesign, id: string): string[] {
  const out = new Set(groupOf(design, id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const j of design.joints) {
      if (j.a === BASE || j.b === BASE || out.has(j.a) === out.has(j.b)) continue;
      for (const g of groupOf(design, out.has(j.a) ? j.b : j.a)) out.add(g);
      grew = true;
    }
  }
  return [id, ...design.pieces.map((p) => p.id).filter((p) => p !== id && out.has(p))];
}

/** The pieces that hang on the given ones alone: they reach the chassis only through them. */
export function hangingOnAll(design: CarDesign, ids: readonly string[]): string[] {
  const set = new Set(ids);
  const reached = connectedToBase(design.joints.filter((j) => !set.has(j.a) && !set.has(j.b)));
  return design.pieces.filter((p) => !set.has(p.id) && !reached.has(p.id)).map((p) => p.id);
}

/** A group id no piece of the design has yet. */
export function newGroupId(design: CarDesign) {
  let n = 1;
  while (design.pieces.some((p) => p.group === `g${n}`)) n++;
  return `g${n}`;
}

/** `count` piece ids the design does not use yet. */
export function newPieceIds(design: CarDesign, count: number) {
  const used = new Set(design.pieces.map((p) => p.id));
  const out: string[] = [];
  for (let n = design.pieces.length + 1; out.length < count; n++) {
    if (!used.has(`p${n}`)) out.push(`p${n}`);
  }
  return out;
}

/** The given pieces made into one part on the car (their old groups merge into it). */
export function makeGroup(design: CarDesign, ids: readonly string[]): CarDesign {
  const group = newGroupId(design);
  const set = new Set(ids);
  return { ...design, pieces: design.pieces.map((p) => (set.has(p.id) ? { ...p, group } : p)) };
}

/** The part `id` is in, back to pieces of their own. */
export function breakGroup(design: CarDesign, id: string): CarDesign {
  const set = new Set(groupOf(design, id));
  return {
    ...design,
    pieces: design.pieces.map((p) => {
      if (!set.has(p.id)) return p;
      const { group: _group, ...rest } = p;
      return rest;
    }),
  };
}

/** What the group is stuck to the rest of the car with (the first joint out of it), or null. */
export function outerAdhesive(design: CarDesign, ids: readonly string[]): Adhesive | null {
  const set = new Set(ids);
  return design.joints.find((j) => set.has(j.a) !== set.has(j.b))?.kind ?? null;
}

/** Takes pieces off, with whatever hung only on them. */
export function removePieces(design: CarDesign, ids: readonly string[]): CarDesign {
  const set = new Set(ids);
  return dropLoose({
    pieces: design.pieces.filter((p) => !set.has(p.id)),
    joints: design.joints.filter((j) => !set.has(j.a) && !set.has(j.b)),
  });
}

// ---------------------------------------------------------------------------
// Assemblies.
// ---------------------------------------------------------------------------
/** The middle of the box around some pieces, to 0.1 mm. */
export function centerOf(pieces: readonly BodyPiece[]): Vec3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pieces) {
    const b = boxBounds(pieceBox(p));
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], b.min[k]);
      max[k] = Math.max(max[k], b.max[k]);
    }
  }
  return [0, 1, 2].map((k) => round((min[k] + max[k]) / 2)) as Vec3;
}

/**
 * Pieces turned by `rot` about `from` and carried to `to` (the turn and the move a whole part
 * makes). A piece's surface turns with it.
 */
export function movePieces(pieces: readonly BodyPiece[], from: Vec3, to: Vec3, rot: Quat): BodyPiece[] {
  const m = rotationMatrix(rot);
  return pieces.map((p) => {
    const off = turn(m, [p.x - from[0], p.y - from[1], p.z - from[2]]);
    const out: BodyPiece = { ...p, x: round(to[0] + off[0]), y: round(to[1] + off[1]), z: round(to[2] + off[2]), rot: tidyQuat(qmul(rot, p.rot))! };
    if (p.seat) out.seat = tidyNormal(turn(m, p.seat));
    return out;
  });
}

/**
 * A part made of pieces on a car (`ids`), turned by `rot` about its middle and with its middle
 * moved to `to`, and what hangs on it alone carried along. Its pieces lie on `seat` from now on
 * (by default, on what they lay on before).
 */
export function groupMoved(design: CarDesign, ids: readonly string[], rot: Quat, to: Vec3, seat?: Vec3) {
  const find = (id: string) => design.pieces.find((p) => p.id === id);
  const members = ids.map(find).filter((p): p is BodyPiece => !!p);
  const riders = hangingOnAll(design, ids).map(find).filter((p): p is BodyPiece => !!p);
  const moved = movePieces([...members, ...riders], centerOf(members), to, rot);
  const group = moved.slice(0, members.length).map((p, i) => {
    const out: BodyPiece = { ...p };
    const s = seat ?? members[i].seat;
    if (s) out.seat = s;
    else delete out.seat;
    return out;
  });
  return { group, riders: moved.slice(members.length) };
}

/** The given pieces of a car as a part of its own, named `name`. */
export function assemblyOf(design: CarDesign, ids: readonly string[], name: string): Assembly {
  const chosen = ids.map((id) => design.pieces.find((p) => p.id === id)).filter((p): p is BodyPiece => !!p);
  const rename = new Map(chosen.map((p, i) => [p.id, `a${i + 1}`]));
  const c = centerOf(chosen);
  const pieces = movePieces(chosen, c, [0, 0, 0], IDENTITY).map((p, i) => {
    const out: BodyPiece = { id: `a${i + 1}`, kind: p.kind, x: p.x, y: p.y, z: p.z, rot: p.rot, adhesive: p.adhesive };
    if (p.made) out.made = p.made;
    return out;
  });
  const joints = design.joints.filter((j) => rename.has(j.a) && rename.has(j.b)).map((j) => ({ a: rename.get(j.a)!, b: rename.get(j.b)!, kind: j.kind }));
  return { name: name.trim().slice(0, MADE_LIMITS.name), pieces, joints };
}

export const assemblyMass = (asm: Assembly) => designMass({ pieces: asm.pieces, joints: [] });

/** How far an assembly turned `rot` reaches from its center in direction `n` (a unit vector). */
export function assemblyReach(asm: Assembly, rot: Quat, n: Vec3) {
  const m = rotationMatrix(rot);
  return Math.max(...asm.pieces.map((p) => dot(turn(m, [p.x, p.y, p.z]), n) + pieceReach(p, qmul(rot, p.rot), n)));
}

/**
 * Where an assembly's center goes when it is held against a surface: on a 5 mm grid in the
 * surface by default (or a custom step in meters, unless `grid` is off), resting on it. Like
 * `seatAgainst` for one piece.
 */
export function seatAssembly(point: Vec3, normal: Vec3, asm: Assembly, rot: Quat, grid: boolean | number = true) {
  const n = tidyNormal(normal);
  const step = typeof grid === 'number' ? (grid > 0 ? grid : 0) : grid ? GRID : 0;
  const snapped = step > 0 ? (point.map((v) => snap(v, step)) as Vec3) : point;
  const back = dot([snapped[0] - point[0], snapped[1] - point[1], snapped[2] - point[2]], n);
  const reach = assemblyReach(asm, rot, n);
  const at = [0, 1, 2].map((k) => round(snapped[k] - n[k] * back + n[k] * reach)) as Vec3;
  return { at, seat: n };
}

/**
 * An assembly put on a car: turned `rot`, its center at `at`, its pieces named `ids` and made
 * into `group`, with the joints between them named the same way.
 */
export function poseAssembly(asm: Assembly, rot: Quat, at: Vec3, ids: readonly string[], group: string, seat?: Vec3) {
  const rename = new Map(asm.pieces.map((p, i) => [p.id, ids[i]]));
  const pieces = movePieces(asm.pieces, [0, 0, 0], at, rot).map((p, i) => {
    const out: BodyPiece = { ...p, id: ids[i], group };
    if (seat) out.seat = seat;
    else delete out.seat;
    return out;
  });
  const joints = asm.joints.map((j) => ({ a: rename.get(j.a)!, b: rename.get(j.b)!, kind: j.kind }));
  return { pieces, joints };
}

/**
 * Puts a part made of pieces in, or moves one already there, and sticks it with `adhesive` to
 * what it touches. `inner` are the joints between its pieces when it is new (one already there
 * keeps its own); `riders`, what hangs on it alone, come along moved the same way.
 */
export function putGroup(design: CarDesign, group: readonly BodyPiece[], inner: readonly BodyJoint[], adhesive: Adhesive, riders: readonly BodyPiece[] = []): PlaceResult {
  const moving = [...group, ...riders];
  const ids = new Set(moving.map((p) => p.id));
  const added = group.filter((g) => !design.pieces.some((p) => p.id === g.id));
  if (design.pieces.length + added.length > MAX_PIECES) return { design: null, problem: 'full' };
  const rest: CarDesign = { pieces: design.pieces.filter((p) => !ids.has(p.id)), joints: [] };
  for (const g of moving) {
    const problem = placementProblem(rest, g);
    if (problem) return { design: null, problem };
  }
  const byId = new Map(moving.map((p) => [p.id, p]));
  const pieces = [...design.pieces.map((p) => byId.get(p.id) ?? p), ...added];
  if (designMass({ pieces, joints: [] }) > MAX_PIECE_MASS + 1e-9) return { design: null, problem: 'heavy' };
  // Joints inside what moves come along; its joints to the rest are made where it is now.
  const kept = design.joints.filter((j) => ids.has(j.a) === ids.has(j.b));
  const own = group.flatMap((g) => jointsFor(rest, { ...g, adhesive }));
  if (own.length === 0) return { design: null, problem: adhesive };
  const joints = [...kept];
  for (const j of [...inner, ...own]) {
    if (!joints.some((k) => (k.a === j.a && k.b === j.b) || (k.a === j.b && k.b === j.a))) joints.push(j);
  }
  return { design: dropLoose({ pieces, joints }), problem: null };
}

/**
 * An assembly from somewhere else (storage, a file) as this game accepts it, or null: its pieces
 * checked like a car's, not in each other, all held together by joints that hold, and centered.
 */
export function readAssembly(raw: unknown): Assembly | null {
  if (!raw || typeof raw !== 'object') return null;
  const { name, pieces, joints } = raw as { name?: unknown; pieces?: unknown; joints?: unknown };
  if (typeof name !== 'string' || !Array.isArray(pieces) || !Array.isArray(joints)) return null;
  const label = name.trim().slice(0, MADE_LIMITS.name);
  if (!label || pieces.length === 0 || pieces.length > MAX_PIECES || joints.length > MAX_PIECES * 8) return null;
  const out: BodyPiece[] = [];
  for (const item of pieces) {
    const p = readPiece(item);
    if (!p || out.some((q) => q.id === p.id) || [p.x, p.y, p.z].some((v) => Math.abs(v) > FAR)) return null;
    const { seat: _seat, group: _group, ...plain } = p;
    out.push(plain);
  }
  const read = readJoints(joints, new Set(out.map((p) => p.id)));
  if (!read) return null;
  const design: CarDesign = { pieces: out, joints: read };
  if (designMass(design) > MAX_PIECE_MASS + 1e-9) return null;
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) if (overlaps(pieceBox(out[i]), pieceBox(out[j]))) return null;
  }
  const held = read.filter((j) => jointBond(design, j) !== null);
  // All of it hangs together: from the first piece, every other is reached through joints.
  const reached = new Set([out[0].id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const j of held) {
      if (reached.has(j.a) !== reached.has(j.b)) {
        reached.add(j.a);
        reached.add(j.b);
        grew = true;
      }
    }
  }
  if (reached.size !== out.length) return null;
  return assemblyOf({ pieces: out, joints: held }, out.map((p) => p.id), label);
}
