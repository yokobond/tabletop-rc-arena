/**
 * Pure geometry helpers for placing and dragging garage parts across any bondable portion
 * (including overhangs and 3 cm hot-glue gaps), keeping grab offset, lift and tilt intact.
 */
import {
  BASE,
  BASE_BOXES,
  GLUE_GAP,
  IDENTITY,
  boxAxis,
  faceAxis,
  faceSign,
  movedGroup,
  newPieceId,
  onSurface,
  pieceBox,
  pieceReach,
  putPiece,
  restingOn,
  seatAgainst,
  specOf,
  tidyNormal,
  type Adhesive,
  type BodyPiece,
  type CarDesign,
  type PartType,
  type PieceShape,
  type PlaceResult,
  type Quat,
  type SolidBox,
  type Vec3,
} from './bodyParts';
import {
  assemblyOf,
  assemblyReach,
  centerOf,
  groupMoved,
  groupOf,
  newGroupId,
  newPieceIds,
  outerAdhesive,
  poseAssembly,
  putGroup,
  seatAssembly,
  type Assembly,
} from './assembly';

export interface SurfaceHit {
  point: Vec3;
  normal: Vec3;
  target: string;
}

export interface PointerRay {
  origin: Vec3;
  dir: Vec3;
}

export interface PointerTarget {
  hit: SurfaceHit | null;
  ray: PointerRay;
  shift: boolean;
}

export interface SupportPlane {
  anchor: Vec3;
  normal: Vec3;
}

export interface DragPlane {
  anchor: Vec3;
  normal: Vec3;
  originCenter: Vec3;
  rot: Quat;
  seat: Vec3;
}

export type HandSpec = (PartType & { rot: Quat; asm?: undefined }) | { asm: Assembly; rot: Quat };

export interface ResolvedPlacement {
  pieces: BodyPiece[];
  result: PlaceResult;
  plane: SupportPlane | null;
}

export interface ResolvedDrag {
  pieces: BodyPiece[];
  result: PlaceResult;
  nextPlane: DragPlane;
  switched: boolean;
}

export const DRAG_GRID = 0.005;
export const FINE_GRID = 0.001;

const UP: Vec3 = [0, 1, 0];

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 1e-12 ? scale(a, 1 / l) : [0, 1, 0];
};
const roundPos = (v: number) => Math.round(v * 10000) / 10000 + 0;
const isHorizontal = (n: Vec3) => Math.abs(dot(unit(n), UP)) > 0.99;

/** Intersects `ray` with the plane through `anchor` with normal `normal`. */
export function intersectPlane(
  ray: PointerRay,
  anchor: Vec3,
  normal: Vec3,
  minCos = 0.12,
  maxDist = 0.9,
): { point: Vec3; t: number } | null {
  const dir = unit(ray.dir);
  const n = unit(normal);
  const denom = dot(dir, n);
  if (Math.abs(denom) < minCos) return null;
  const t = dot(sub(anchor, ray.origin), n) / denom;
  if (!(t > 0.02 && t <= 10)) return null;
  const point = add(ray.origin, scale(dir, t));
  if (len(sub(point, anchor)) > maxDist) return null;
  return { point, t };
}

/**
 * Computes a moved center by adding the pointer's displacement from `anchor` to `originCenter`,
 * snapping to `step` meters, and projecting back onto the plane through `originCenter` with `normal`.
 */
export function snapOnPlane(originCenter: Vec3, anchor: Vec3, hitPoint: Vec3, normal: Vec3, step: number): Vec3 {
  const n = unit(normal);
  const raw = add(originCenter, sub(hitPoint, anchor));
  const snapped = step > 0 ? (raw.map((v) => Math.round(v / step) * step + 0) as Vec3) : raw;
  const onPlane = sub(snapped, scale(n, dot(sub(snapped, originCenter), n)));
  return onPlane.map(roundPos) as Vec3;
}

export interface FacePlaneCandidate {
  point: Vec3;
  normal: Vec3;
  t: number;
  edgeDist: number;
}

/**
 * Collects camera-facing flat face planes whose infinite extensions intersect `ray` near enough to
 * their face rectangle (`edgeDist <= reach + GLUE_GAP + 0.02`), sorted closest-edge-first and
 * deduplicated by plane equation. If `preferred` intersects cleanly within `maxT`, it comes first.
 */
export function candidateFacePlanes(
  design: CarDesign,
  ray: PointerRay,
  reach: number,
  preferred?: SupportPlane | null,
  maxT?: number,
  boxesOverride?: readonly SolidBox[],
): FacePlaneCandidate[] {
  const dir = unit(ray.dir);
  const out: FacePlaneCandidate[] = [];

  if (preferred) {
    const n = unit(preferred.normal);
    if (dot(n, dir) < -0.15) {
      const hit = intersectPlane(ray, preferred.anchor, n, 0.15);
      if (hit && (maxT === undefined || hit.t < maxT - 0.004)) {
        out.push({ point: hit.point, normal: tidyNormal(n), t: hit.t, edgeDist: -1 });
      }
    }
  }

  const boxes = boxesOverride ?? [...BASE_BOXES, ...design.pieces.map(pieceBox)];
  const faces: FacePlaneCandidate[] = [];
  const limit = reach + GLUE_GAP + 0.02;

  for (const b of boxes) {
    for (let f = 0; f < 6; f++) {
      if (!b.flat[f]) continue;
      const k = faceAxis(f);
      const [iu, iv] = [0, 1, 2].filter((x) => x !== k);
      const n = tidyNormal(scale(boxAxis(b, k), faceSign(f)));
      if (dot(n, dir) >= -0.15) continue;
      const c = add(b.c, scale(n, b.h[k]));
      const hit = intersectPlane(ray, c, n, 0.15);
      if (!hit) continue;
      if (maxT !== undefined && hit.t >= maxT - 0.004) continue;
      const offset = sub(hit.point, c);
      const du = dot(offset, boxAxis(b, iu));
      const dv = dot(offset, boxAxis(b, iv));
      const hu = b.h[iu];
      const hv = b.h[iv];
      const edgeDist =
        b.shape === 'cylinder'
          ? Math.max(0, Math.hypot(du, dv) - hu)
          : Math.hypot(Math.max(0, Math.abs(du) - hu), Math.max(0, Math.abs(dv) - hv));
      if (edgeDist > limit) continue;
      faces.push({ point: hit.point, normal: n, t: hit.t, edgeDist });
    }
  }

  faces.sort((a, b) => a.edgeDist - b.edgeDist || a.t - b.t);
  for (const cand of faces) {
    const dup = out.some(
      (k) => dot(k.normal, cand.normal) > 0.999 && Math.abs(dot(k.normal, sub(k.point, cand.point))) < 0.002,
    );
    if (!dup) out.push(cand);
  }
  return out;
}

function shapeRadius(s: PieceShape): number {
  if (s.kind === 'box') return 0.5 * Math.hypot(s.size[0], s.size[1], s.size[2]);
  if (s.kind === 'cylinder') return Math.hypot(s.r, s.h / 2);
  return s.r;
}

function handMaxReach(hand: HandSpec): number {
  if (hand.asm) {
    return Math.max(...hand.asm.pieces.map((p) => len([p.x, p.y, p.z]) + shapeRadius(specOf(p).shape)));
  }
  return shapeRadius(specOf(hand).shape);
}

function seatHandAt(
  design: CarDesign,
  point: Vec3,
  normal: Vec3,
  round: boolean,
  hand: HandSpec,
  adhesive: Adhesive,
  step: number,
): { pieces: BodyPiece[]; result: PlaceResult } {
  const grid = round ? false : step;
  const rot = restingOn(hand.rot, normal);
  if (hand.asm) {
    const at = seatAssembly(point, normal, hand.asm, rot, grid);
    const ids = newPieceIds(design, hand.asm.pieces.length);
    const { pieces, joints } = poseAssembly(hand.asm, rot, at.at, ids, newGroupId(design), at.seat);
    return { pieces, result: putGroup(design, pieces, joints, adhesive) };
  }
  const at = seatAgainst(point, normal, hand, rot, grid);
  const piece: BodyPiece = { id: newPieceId(design), kind: hand.kind, rot, adhesive, x: at.x, y: at.y, z: at.z, seat: at.seat };
  if (hand.made) piece.made = hand.made;
  return { pieces: [piece], result: putPiece(design, piece) };
}

/**
 * Resolves where a tray piece/assembly goes for hover or tap: prefers a direct valid hit,
 * then continues along `lastPlane` or nearby flat faces (e.g. for edge overhangs or empty-space hovers).
 */
export function resolveHandPlacement(
  design: CarDesign,
  target: PointerTarget,
  hand: HandSpec,
  adhesive: Adhesive,
  lastPlane: SupportPlane | null = null,
): ResolvedPlacement | null {
  const step = target.shift ? FINE_GRID : DRAG_GRID;
  const dir = unit(target.ray.dir);
  const maxReach = handMaxReach(hand);

  if (target.hit) {
    const surface = onSurface(design, target.hit.target, target.hit.point, target.hit.normal);
    const direct = seatHandAt(design, surface.point, surface.normal, surface.round, hand, adhesive, step);
    const directPlane: SupportPlane | null = surface.round ? null : { anchor: surface.point, normal: surface.normal };
    if (direct.result.design) {
      return { ...direct, plane: directPlane };
    }

    const tHit = dot(sub(target.hit.point, target.ray.origin), dir);
    if (lastPlane) {
      const pHit = intersectPlane(target.ray, lastPlane.anchor, lastPlane.normal, 0.15);
      if (pHit && pHit.t < tHit - 0.004) {
        const res = seatHandAt(design, pHit.point, lastPlane.normal, false, hand, adhesive, step);
        if (res.result.design) return { ...res, plane: lastPlane };
      }
    }

    if (target.hit.target === BASE) {
      const baseCands = candidateFacePlanes(design, target.ray, maxReach, null, tHit, BASE_BOXES);
      for (const cand of baseCands) {
        const res = seatHandAt(design, cand.point, cand.normal, false, hand, adhesive, step);
        if (res.result.design) {
          return { ...res, plane: { anchor: cand.point, normal: cand.normal } };
        }
      }
    }

    return { ...direct, plane: directPlane };
  }

  const cands = candidateFacePlanes(design, target.ray, maxReach, lastPlane);
  for (const cand of cands) {
    const res = seatHandAt(design, cand.point, cand.normal, false, hand, adhesive, step);
    if (res.result.design) {
      return {
        ...res,
        plane:
          lastPlane && dot(lastPlane.normal, cand.normal) > 0.999 && Math.abs(dot(lastPlane.normal, sub(lastPlane.anchor, cand.point))) < 0.002
            ? lastPlane
            : { anchor: cand.point, normal: cand.normal },
      };
    }
  }
  return null;
}

const DEFAULT_DECK_OFFSETS: readonly [number, number][] = [
  [0, 0],
  [0, 0.08],
  [0, -0.08],
  [0.06, 0],
  [-0.06, 0],
  [0, 0.15],
  [0, -0.15],
  [0.07, 0.1],
  [-0.07, 0.1],
  [0.07, -0.1],
  [-0.07, -0.1],
];

/**
 * Finds a default valid placement on the car for non-drag (keyboard) activation:
 * checks spots on the chassis deck top first, then flat tops of existing pieces.
 * Returns the first valid placement, or the first failed attempt so its problem can be reported.
 */
export function findDefaultHandPlacement(
  design: CarDesign,
  hand: HandSpec,
  adhesive: Adhesive,
): ResolvedPlacement | null {
  const deck = BASE_BOXES[0];
  const deckTopY = deck.c[1] + deck.h[1];
  const candidates: { point: Vec3; normal: Vec3 }[] = DEFAULT_DECK_OFFSETS.map(([dx, dz]) => ({
    point: [deck.c[0] + dx, deckTopY, deck.c[2] + dz],
    normal: UP,
  }));

  for (const p of design.pieces) {
    const b = pieceBox(p);
    for (let f = 0; f < 6; f++) {
      if (!b.flat[f]) continue;
      const k = faceAxis(f);
      const n = tidyNormal(scale(boxAxis(b, k), faceSign(f)));
      if (dot(n, UP) <= 0.7) continue;
      candidates.push({ point: add(b.c, scale(n, b.h[k])), normal: n });
    }
  }

  let firstAttempt: ResolvedPlacement | null = null;
  for (const c of candidates) {
    const res = seatHandAt(design, c.point, c.normal, false, hand, adhesive, DRAG_GRID);
    const placed: ResolvedPlacement = { ...res, plane: null };
    if (res.result.design) return placed;
    if (!firstAttempt) firstAttempt = placed;
  }
  return firstAttempt;
}

/** Creates the initial drag support plane when dragging `id` from `grabPoint`. */
export function createDragPlane(design: CarDesign, id: string, grabPoint: Vec3): DragPlane | null {
  const p = design.pieces.find((q) => q.id === id);
  if (!p) return null;
  const ids = groupOf(design, id);
  if (ids.length > 1) {
    const members = ids.map((mid) => design.pieces.find((q) => q.id === mid)!);
    const seat = tidyNormal(members[0]?.seat ?? p.seat ?? UP);
    return { anchor: grabPoint, normal: seat, originCenter: centerOf(members), rot: IDENTITY, seat };
  }
  const seat = tidyNormal(p.seat ?? UP);
  return { anchor: grabPoint, normal: seat, originCenter: [p.x, p.y, p.z], rot: p.rot, seat };
}

function evalDraggedAt(
  design: CarDesign,
  id: string,
  ids: string[],
  center: Vec3,
  rot: Quat,
  seat: Vec3,
  fallbackAdhesive: Adhesive,
): { pieces: BodyPiece[]; result: PlaceResult } {
  if (ids.length > 1) {
    const { group, riders } = groupMoved(design, ids, rot, center, seat);
    const adhesive = outerAdhesive(design, ids) ?? fallbackAdhesive;
    return { pieces: [...group, ...riders], result: putGroup(design, group, [], adhesive, riders) };
  }
  const p = design.pieces.find((q) => q.id === id)!;
  const moved: BodyPiece = { ...p, x: center[0], y: center[1], z: center[2], rot, seat };
  return { pieces: movedGroup(design, moved), result: putPiece(design, moved) };
}

function evalDraggedOnHit(
  design: CarDesign,
  id: string,
  ids: string[],
  hit: SurfaceHit,
  step: number,
  fallbackAdhesive: Adhesive,
) {
  const surface = onSurface(design, hit.target, hit.point, hit.normal);
  const grid = surface.round ? false : step;
  if (ids.length > 1) {
    const first = design.pieces.find((q) => q.id === ids[0]);
    const rot = restingOn(IDENTITY, surface.normal, first?.seat);
    const asm = assemblyOf(design, ids, '');
    const at = seatAssembly(surface.point, surface.normal, asm, rot, grid);
    const evaluated = evalDraggedAt(design, id, ids, at.at, rot, at.seat, fallbackAdhesive);
    return {
      ...evaluated,
      surface,
      nextPlane: { anchor: surface.point, normal: surface.normal, originCenter: at.at, rot, seat: at.seat } as DragPlane,
    };
  }
  const p = design.pieces.find((q) => q.id === id)!;
  const rot = restingOn(p.rot, surface.normal, p.seat);
  const at = seatAgainst(surface.point, surface.normal, p, rot, grid);
  const center: Vec3 = [at.x, at.y, at.z];
  const evaluated = evalDraggedAt(design, id, ids, center, rot, at.seat, fallbackAdhesive);
  return {
    ...evaluated,
    surface,
    nextPlane: { anchor: surface.point, normal: surface.normal, originCenter: center, rot, seat: at.seat } as DragPlane,
  };
}

/**
 * Evaluates a drag frame for `id` (or its group): slides along `plane` preserving grab offset,
 * lift and tilt through overhangs and gaps, and switches smoothly when hitting another solid in front
 * or leaving the valid bondable area onto a valid surface.
 */
export function resolvePieceDrag(
  design: CarDesign,
  id: string,
  target: PointerTarget,
  plane: DragPlane,
  fallbackAdhesive: Adhesive,
): ResolvedDrag {
  const p = design.pieces.find((q) => q.id === id)!;
  const ids = groupOf(design, id);
  const step = target.shift ? FINE_GRID : DRAG_GRID;
  const dir = unit(target.ray.dir);

  let activeNormal = plane.normal;
  let planeHit = intersectPlane(target.ray, plane.anchor, plane.normal, isHorizontal(plane.normal) ? 0.08 : 0.18);
  if (!planeHit && !isHorizontal(plane.normal)) {
    activeNormal = UP;
    planeHit = intersectPlane(target.ray, plane.anchor, UP, 0.08);
  }

  const planeCand = planeHit
    ? {
        ...evalDraggedAt(
          design,
          id,
          ids,
          snapOnPlane(plane.originCenter, plane.anchor, planeHit.point, activeNormal, step),
          plane.rot,
          plane.seat,
          fallbackAdhesive,
        ),
        t: planeHit.t,
      }
    : null;

  const hitCand = target.hit
    ? {
        ...evalDraggedOnHit(design, id, ids, target.hit, step, fallbackAdhesive),
        t: dot(sub(target.hit.point, target.ray.origin), dir),
      }
    : null;

  const reach =
    ids.length > 1
      ? assemblyReach(assemblyOf(design, ids, ''), plane.rot, plane.seat)
      : pieceReach(p, plane.rot, plane.seat);
  const supportOffset = dot(plane.originCenter, plane.seat) - reach;
  const sameSupportPlane =
    hitCand !== null &&
    !hitCand.surface.round &&
    dot(hitCand.surface.normal, plane.seat) > 0.995 &&
    Math.abs(dot(hitCand.surface.point, plane.seat) - supportOffset) < 0.004;
  const hitInFront = hitCand !== null && planeCand !== null && hitCand.t < planeCand.t - 0.004;

  const planeOk = planeCand !== null && planeCand.result.design !== null;
  const hitOk = hitCand !== null && hitCand.result.design !== null;

  if (planeCand && planeOk) {
    if (hitCand && hitOk && (hitCand.surface.round || (!sameSupportPlane && hitInFront))) {
      return { pieces: hitCand.pieces, result: hitCand.result, nextPlane: hitCand.nextPlane, switched: true };
    }
    return { pieces: planeCand.pieces, result: planeCand.result, nextPlane: plane, switched: false };
  }

  if (hitCand && hitOk) {
    return { pieces: hitCand.pieces, result: hitCand.result, nextPlane: hitCand.nextPlane, switched: true };
  }

  if (hitCand && !sameSupportPlane && (planeCand === null || hitInFront)) {
    return { pieces: hitCand.pieces, result: hitCand.result, nextPlane: plane, switched: false };
  }

  if (planeCand) {
    return { pieces: planeCand.pieces, result: planeCand.result, nextPlane: plane, switched: false };
  }

  if (hitCand) {
    return { pieces: hitCand.pieces, result: hitCand.result, nextPlane: plane, switched: false };
  }

  const unchanged = evalDraggedAt(design, id, ids, plane.originCenter, plane.rot, plane.seat, fallbackAdhesive);
  return { pieces: unchanged.pieces, result: { design: null, problem: 'bounds' }, nextPlane: plane, switched: false };
}
