/**
 * Pure geometry and interaction math for the 3-axis on-object rotation gizmo in the garage.
 * Kept free of DOM and three.js so it can be unit-tested directly under Vitest.
 */
import { boxBounds, pieceBox, type BodyPiece, type Vec3 } from './bodyParts';

export type RotationAxis = 'x' | 'y' | 'z';
export type HorizontalSide = 'px' | 'nx' | 'pz' | 'nz';

export interface HandleSides {
  x: 'px' | 'nx';
  y: HorizontalSide;
  z: 'pz' | 'nz';
}

export interface ScreenPoint {
  x: number;
  y: number;
  visible: boolean;
}

export type ProjectFn = (point: Vec3) => ScreenPoint;

export interface SelectionBounds {
  min: Vec3;
  max: Vec3;
  center: Vec3;
}

export interface RotateHandleView {
  axis: RotationAxis;
  x: number;
  y: number;
  arc: string;
  heads: string;
  visible: boolean;
}

export interface ProtractorPlane {
  axis: RotationAxis;
  cx: number;
  cy: number;
  a: number;
  b: number;
  c: number;
  d: number;
  screenRadius: number;
}

export interface LiftAxisScreen {
  dirX: number;
  dirY: number;
  pxPerMeter: number;
  angleDeg: number;
}

export interface LiftHandleView {
  x: number;
  y: number;
  visible: boolean;
  axis: LiftAxisScreen;
  baseX: number;
  baseY: number;
}

export interface LiftDeltaResult {
  deltaM: number;
  stepM: number;
}

export interface GizmoLayout {
  handles: RotateHandleView[];
  lift: LiftHandleView;
  planes: Record<RotationAxis, ProtractorPlane>;
  sides: HandleSides;
  center: ScreenPoint;
}

export interface DragAngleResult {
  unwrappedDeg: number;
  deltaDeg: number;
  mode: 'snap' | 'fine';
  step: number;
}

export const PROTRACTOR_LOCAL_RADIUS = 100;
export const PROTRACTOR_INNER_RADIUS = 72;
export const RING_SNAP_THRESHOLD = 1.1;
export const SNAP_STEP_DEG = 15;
export const SHIFT_INSIDE_STEP_DEG = 5;
export const FREE_STEP_DEG = 1;
export const SHIFT_OUTSIDE_STEP_DEG = 45;
export const LIFT_SNAP_STEP_M = 0.005;
export const LIFT_FINE_STEP_M = 0.001;

const AXIS_HYSTERESIS = 0.2;
const DOMINANCE_HYSTERESIS = 0.18;
const MIN_PLANE_ASPECT = 0.36;
const ARROW_HALF_SPAN_RAD = (54 * Math.PI) / 180;
const ARROW_STEPS = 12;
const TARGET_ARROW_CHORD_PX = 20;
const MIN_ARROW_SAGITTA_PX = 4.2;
const ARROW_HEAD_LEN = 6.5;
const ARROW_HEAD_HALF_W = 3.6;
const HANDLE_EDGE_OFFSET_PX = 22;
const LIFT_EDGE_OFFSET_PX = 34;
const MIN_HANDLE_CENTER_DIST_PX = 34;
const MIN_LIFT_CENTER_DIST_PX = 42;
const MIN_HANDLE_SEPARATION_PX = 42;
const VIEW_PAD_PX = 24;

/** Car-local bounding box and center of the selected pieces. */
export function selectionBounds(pieces: readonly BodyPiece[]): SelectionBounds | null {
  if (pieces.length === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const piece of pieces) {
    const b = boxBounds(pieceBox(piece));
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], b.min[k]);
      max[k] = Math.max(max[k], b.max[k]);
    }
  }
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  return { min, max, center };
}

/** Right-handed orthonormal basis (u × v = axisVec) for a rotation axis in car-local space. */
export function axisBasis(axis: RotationAxis): { axisVec: Vec3; u: Vec3; v: Vec3 } {
  if (axis === 'x') return { axisVec: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] };
  if (axis === 'y') return { axisVec: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] };
  return { axisVec: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] };
}

function sideScore(side: HorizontalSide, nx: number, nz: number) {
  if (side === 'px') return nx;
  if (side === 'nx') return -nx;
  if (side === 'pz') return nz;
  return -nz;
}

/**
 * Picks which side of the selection box each axis handle sits on, keeping them separated
 * across three distinct edges with hysteresis so handles do not flicker near quadrant boundaries.
 */
export function chooseHandleSides(cameraPos: Vec3, center: Vec3, prev?: HandleSides): HandleSides {
  const vx = cameraPos[0] - center[0];
  const vz = cameraPos[2] - center[2];
  const len = Math.hypot(vx, vz);
  if (len < 1e-6) return prev ?? { x: 'px', y: 'pz', z: 'pz' };
  const nx = vx / len;
  const nz = vz / len;

  let x: 'px' | 'nx';
  if (prev?.x === 'nx' && nx > -AXIS_HYSTERESIS) x = 'nx';
  else if (prev?.x === 'px' && nx < AXIS_HYSTERESIS) x = 'px';
  else x = nx >= 0 ? 'nx' : 'px';

  let z: 'pz' | 'nz';
  if (prev?.z === 'nz' && nz > -AXIS_HYSTERESIS) z = 'nz';
  else if (prev?.z === 'pz' && nz < AXIS_HYSTERESIS) z = 'pz';
  else z = nz >= 0 ? 'nz' : 'pz';

  const sides: HorizontalSide[] = ['px', 'nx', 'pz', 'nz'];
  let bestSide: HorizontalSide = 'pz';
  let bestScore = -Infinity;
  for (const s of sides) {
    const score = sideScore(s, nx, nz);
    if (score > bestScore) {
      bestScore = score;
      bestSide = s;
    }
  }
  const y = prev && sideScore(prev.y, nx, nz) >= bestScore - DOMINANCE_HYSTERESIS ? prev.y : bestSide;
  return { x, y, z };
}

/**
 * Computes an SVG `matrix(a b c d cx cy)` transform representing the rotation plane centered at
 * `centerWorld`. Guarantees a minimum screen aspect ratio so edge-on views remain easy to drag.
 */
export function computeProtractorPlane(
  project: ProjectFn,
  centerWorld: Vec3,
  axis: RotationAxis,
  cameraDistance: number,
  width: number,
  height: number,
): ProtractorPlane {
  const screenRadius = Math.min(114, Math.max(76, Math.min(width, height) * 0.24));
  const c = project(centerWorld);
  const { u, v } = axisBasis(axis);
  const step = Math.max(0.01, cameraDistance * 0.015);
  const u0 = project([centerWorld[0] - u[0] * step, centerWorld[1] - u[1] * step, centerWorld[2] - u[2] * step]);
  const u1 = project([centerWorld[0] + u[0] * step, centerWorld[1] + u[1] * step, centerWorld[2] + u[2] * step]);
  const v0 = project([centerWorld[0] - v[0] * step, centerWorld[1] - v[1] * step, centerWorld[2] - v[2] * step]);
  const v1 = project([centerWorld[0] + v[0] * step, centerWorld[1] + v[1] * step, centerWorld[2] + v[2] * step]);

  const m00 = (u1.x - u0.x) / 2;
  const m10 = (u1.y - u0.y) / 2;
  const m01 = (v1.x - v0.x) / 2;
  const m11 = (v1.y - v0.y) / 2;

  // Analytic 2x2 SVD of M = U * diag(s1, s2) * V^T.
  const g00 = m00 * m00 + m10 * m10;
  const g11 = m01 * m01 + m11 * m11;
  const g01 = m00 * m01 + m10 * m11;
  const tr = g00 + g11;
  const diff = g00 - g11;
  const disc = Math.hypot(diff, 2 * g01);
  const s1 = Math.sqrt(Math.max(0, (tr + disc) / 2));
  const s2 = Math.sqrt(Math.max(0, (tr - disc) / 2));

  if (!Number.isFinite(s1) || s1 < 1e-6) {
    const k = screenRadius / PROTRACTOR_LOCAL_RADIUS;
    return { axis, cx: c.x, cy: c.y, a: k, b: 0, c: 0, d: k, screenRadius };
  }

  const phi = 0.5 * Math.atan2(2 * g01, diff);
  const vx1 = Math.cos(phi);
  const vy1 = Math.sin(phi);
  const vx2 = -vy1;
  const vy2 = vx1;

  // M * v1 has length s1.
  const u1x = (m00 * vx1 + m01 * vy1) / s1;
  const u1y = (m10 * vx1 + m11 * vy1) / s1;
  const det = m00 * m11 - m01 * m10;
  const detSign = det < 0 ? -1 : 1;
  const u2x = -detSign * u1y;
  const u2y = detSign * u1x;

  const targetS1 = screenRadius / PROTRACTOR_LOCAL_RADIUS;
  const targetS2 = Math.max(s2 * (targetS1 / s1), MIN_PLANE_ASPECT * targetS1);

  return {
    axis,
    cx: c.x,
    cy: c.y,
    a: targetS1 * u1x * vx1 + targetS2 * u2x * vx2,
    b: targetS1 * u1y * vx1 + targetS2 * u2y * vx2,
    c: targetS1 * u1x * vy1 + targetS2 * u2x * vy2,
    d: targetS1 * u1y * vy1 + targetS2 * u2y * vy2,
    screenRadius,
  };
}

/** Maps a screen pointer position back into the protractor's local (u, v) coordinates. */
export function pointerOnProtractor(
  plane: ProtractorPlane,
  sx: number,
  sy: number,
): { u: number; v: number; angleDeg: number; radiusNorm: number } | null {
  const det = plane.a * plane.d - plane.b * plane.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  const dx = sx - plane.cx;
  const dy = sy - plane.cy;
  const u = (plane.d * dx - plane.c * dy) / det;
  const v = (-plane.b * dx + plane.a * dy) / det;
  const radiusNorm = Math.hypot(u, v) / PROTRACTOR_LOCAL_RADIUS;
  const angleDeg = (Math.atan2(v, u) * 180) / Math.PI;
  return { u, v, angleDeg, radiusNorm };
}

/** Normalizes any angle in degrees into (-180, 180] without -0. */
export function wrapSignedDeg(deg: number): number {
  let a = ((deg + 180) % 360 + 360) % 360 - 180;
  if (a <= -180) a += 360;
  return a === 0 ? 0 : a;
}

/**
 * Updates continuous unwrapped drag angle across the ±180° seam and returns the snapped delta.
 * Inside the protractor ring: 15° steps (5° with Shift). Outside: 1° steps (45° with Shift).
 */
export function stepDragAngle(params: {
  prevAngleDeg: number;
  currAngleDeg: number;
  prevUnwrappedDeg: number;
  radiusNorm: number;
  shiftKey: boolean;
}): DragAngleResult {
  const diff = wrapSignedDeg(params.currAngleDeg - params.prevAngleDeg);
  const unwrappedDeg = params.prevUnwrappedDeg + diff;
  const inside = params.radiusNorm <= RING_SNAP_THRESHOLD;
  const mode: 'snap' | 'fine' = inside ? 'snap' : 'fine';
  const step = inside
    ? params.shiftKey
      ? SHIFT_INSIDE_STEP_DEG
      : SNAP_STEP_DEG
    : params.shiftKey
      ? SHIFT_OUTSIDE_STEP_DEG
      : FREE_STEP_DEG;
  const deltaDeg = wrapSignedDeg(Math.round(unwrappedDeg / step) * step);
  return { unwrappedDeg, deltaDeg, mode, step };
}

interface Pt2 {
  x: number;
  y: number;
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * Projects a curved double-headed rotation arrow in the plane perpendicular to `axisVec`,
 * scaled to a consistent readable size on screen while keeping curvature in edge-on views.
 */
export function buildCurvedArrow(
  project: ProjectFn,
  anchorWorld: Vec3,
  radial: Vec3,
  axisVec: Vec3,
  worldRadius: number,
): { arc: string; heads: string } {
  const tangent = cross3(axisVec, radial);
  const centre: Vec3 = [
    anchorWorld[0] - radial[0] * worldRadius,
    anchorWorld[1] - radial[1] * worldRadius,
    anchorWorld[2] - radial[2] * worldRadius,
  ];
  const origin = project(anchorWorld);
  const raw: Pt2[] = [];
  for (let i = 0; i <= ARROW_STEPS; i++) {
    const a = -ARROW_HALF_SPAN_RAD + (2 * ARROW_HALF_SPAN_RAD * i) / ARROW_STEPS;
    const ca = worldRadius * Math.cos(a);
    const sa = worldRadius * Math.sin(a);
    const p = project([
      centre[0] + radial[0] * ca + tangent[0] * sa,
      centre[1] + radial[1] * ca + tangent[1] * sa,
      centre[2] + radial[2] * ca + tangent[2] * sa,
    ]);
    raw.push({ x: p.x - origin.x, y: p.y - origin.y });
  }

  const first = raw[0];
  const last = raw[ARROW_STEPS];
  const chordLen = Math.hypot(last.x - first.x, last.y - first.y);
  const tangentScreen = project([anchorWorld[0] + tangent[0] * worldRadius, anchorWorld[1] + tangent[1] * worldRadius, anchorWorld[2] + tangent[2] * worldRadius]);
  const tangentSpan = Math.hypot(tangentScreen.x - origin.x, tangentScreen.y - origin.y);
  const maxRawExtent = raw.reduce((m, p) => Math.max(m, Math.hypot(p.x, p.y)), 0);
  const refLen = chordLen >= 4 ? chordLen : Math.max(4, tangentSpan * 1.6, maxRawExtent * 1.5);
  const scale = Math.min(2.5, Math.max(0.4, TARGET_ARROW_CHORD_PX / refLen));
  const scaled = raw.map((p) => ({ x: p.x * scale, y: p.y * scale }));

  const sFirst = scaled[0];
  const sLast = scaled[ARROW_STEPS];
  const sChord = { x: sLast.x - sFirst.x, y: sLast.y - sFirst.y };
  const travel = Math.hypot(sChord.x, sChord.y) >= 4 ? sChord : { x: tangentScreen.x - origin.x, y: tangentScreen.y - origin.y };
  const travelLen = Math.hypot(travel.x, travel.y);
  const along = travelLen > 1e-6 ? { x: travel.x / travelLen, y: travel.y / travelLen } : { x: 1, y: 0 };
  const normal = { x: -along.y, y: along.x };

  const sag = scaled.map((p) => (p.x - sFirst.x) * normal.x + (p.y - sFirst.y) * normal.y);
  const peak = sag.reduce((best, val) => (Math.abs(val) > Math.abs(best) ? val : best), 0);
  const outwardPt = project([anchorWorld[0] + radial[0] * worldRadius, anchorWorld[1] + radial[1] * worldRadius, anchorWorld[2] + radial[2] * worldRadius]);
  const outwardSign = (outwardPt.x - origin.x) * normal.x + (outwardPt.y - origin.y) * normal.y >= 0 ? 1 : -1;
  const bowSign = Math.abs(peak) > 0.4 ? Math.sign(peak) : outwardSign;
  const bow = Math.max(0, MIN_ARROW_SAGITTA_PX - Math.abs(peak));

  const arc = scaled.map((p, i) => {
    const lift = bow * Math.sin((Math.PI * i) / ARROW_STEPS) * bowSign;
    return { x: p.x + normal.x * lift, y: p.y + normal.y * lift };
  });

  // Re-center the curved arc around (0, 0) so the button hit target covers the glyph symmetrically.
  const mid = arc[ARROW_STEPS >> 1];
  const centered = arc.map((p) => ({ x: p.x - mid.x, y: p.y - mid.y }));

  const dir = (from: Pt2, to: Pt2): Pt2 => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  };
  const head = (base: Pt2, d: Pt2): Pt2[] => {
    const tip = { x: base.x + d.x * ARROW_HEAD_LEN, y: base.y + d.y * ARROW_HEAD_LEN };
    const side = { x: -d.y * ARROW_HEAD_HALF_W, y: d.x * ARROW_HEAD_HALF_W };
    return [tip, { x: base.x + side.x, y: base.y + side.y }, { x: base.x - side.x, y: base.y - side.y }];
  };
  const heads = [
    head(centered[0], dir(centered[1], centered[0])),
    head(centered[ARROW_STEPS], dir(centered[ARROW_STEPS - 1], centered[ARROW_STEPS])),
  ];
  const fmt = (p: Pt2) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  return {
    arc: `M${centered.map(fmt).join(' L')}`,
    heads: heads.map((tri) => `M${tri.map(fmt).join(' L')}Z`).join(' '),
  };
}

function clamp(v: number, lo: number, hi: number) {
  return hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
}

/** Computes the screen-space up direction and pixel scale for the vertical (+Y) lift axis. */
export function computeLiftAxis(project: ProjectFn, centerWorld: Vec3): LiftAxisScreen {
  const stepM = 0.05;
  const lo = project([centerWorld[0], centerWorld[1] - stepM, centerWorld[2]]);
  const hi = project([centerWorld[0], centerWorld[1] + stepM, centerWorld[2]]);
  const vx = (hi.x - lo.x) / (2 * stepM);
  const vy = (hi.y - lo.y) / (2 * stepM);
  const rawPxPerMeter = Math.hypot(vx, vy);
  const dirX = rawPxPerMeter > 1e-3 ? vx / rawPxPerMeter : 0;
  const dirY = rawPxPerMeter > 1e-3 ? vy / rawPxPerMeter : -1;
  const pxPerMeter = Math.max(rawPxPerMeter, 220);
  const angleDeg = (Math.atan2(dirY, dirX) * 180) / Math.PI + 90;
  return { dirX, dirY, pxPerMeter, angleDeg };
}

/** Projects a screen drag delta onto the vertical axis and snaps to 0.5cm (or 0.1cm with Shift). */
export function stepLiftDelta(params: { dx: number; dy: number; axis: LiftAxisScreen; shiftKey: boolean }): LiftDeltaResult {
  const projPx = params.dx * params.axis.dirX + params.dy * params.axis.dirY;
  const rawM = projPx / params.axis.pxPerMeter;
  const stepM = params.shiftKey ? LIFT_FINE_STEP_M : LIFT_SNAP_STEP_M;
  const snapped = Math.round(rawM / stepM) * stepM;
  const deltaM = Math.round(snapped * 10000) / 10000 + 0;
  return { deltaM, stepM };
}

/** Computes the vertical lift handle, all 3 rotation handles, and protractor planes for the selection. */
export function layoutRotationGizmo(params: {
  bounds: SelectionBounds;
  cameraPos: Vec3;
  width: number;
  height: number;
  project: ProjectFn;
  prevSides?: HandleSides;
}): GizmoLayout {
  const { bounds, cameraPos, width, height, project, prevSides } = params;
  const sides = chooseHandleSides(cameraPos, bounds.center, prevSides);
  const center = project(bounds.center);
  const camDist = Math.hypot(cameraPos[0] - bounds.center[0], cameraPos[1] - bounds.center[1], cameraPos[2] - bounds.center[2]);
  const worldRadius = Math.max(0.03, camDist * 0.045);

  const planes: Record<RotationAxis, ProtractorPlane> = {
    x: computeProtractorPlane(project, bounds.center, 'x', camDist, width, height),
    y: computeProtractorPlane(project, bounds.center, 'y', camDist, width, height),
    z: computeProtractorPlane(project, bounds.center, 'z', camDist, width, height),
  };

  const specs: { axis: RotationAxis; anchor: Vec3; radial: Vec3; pushOut: Vec3; fallbackDir: Pt2 }[] = [
    {
      axis: 'x',
      anchor: [sides.x === 'px' ? bounds.max[0] : bounds.min[0], bounds.max[1], bounds.center[2]],
      radial: [0, 1, 0],
      pushOut: [sides.x === 'px' ? 0.8 : -0.8, 0.55, 0],
      fallbackDir: { x: -0.7, y: -0.7 },
    },
    {
      axis: 'z',
      anchor: [bounds.center[0], bounds.max[1], sides.z === 'pz' ? bounds.max[2] : bounds.min[2]],
      radial: [0, 1, 0],
      pushOut: [0, 0.55, sides.z === 'pz' ? 0.8 : -0.8],
      fallbackDir: { x: 0.7, y: -0.7 },
    },
    {
      axis: 'y',
      anchor:
        sides.y === 'px'
          ? [bounds.max[0], bounds.min[1], bounds.center[2]]
          : sides.y === 'nx'
            ? [bounds.min[0], bounds.min[1], bounds.center[2]]
            : sides.y === 'pz'
              ? [bounds.center[0], bounds.min[1], bounds.max[2]]
              : [bounds.center[0], bounds.min[1], bounds.min[2]],
      radial: sides.y === 'px' ? [1, 0, 0] : sides.y === 'nx' ? [-1, 0, 0] : sides.y === 'pz' ? [0, 0, 1] : [0, 0, -1],
      pushOut: sides.y === 'px' ? [1, 0, 0] : sides.y === 'nx' ? [-1, 0, 0] : sides.y === 'pz' ? [0, 0, 1] : [0, 0, -1],
      fallbackDir: { x: 0, y: 1 },
    },
  ];

  const handles: RotateHandleView[] = specs.map((spec) => {
    const { axisVec } = axisBasis(spec.axis);
    const aScreen = project(spec.anchor);
    const outScreen = project([
      spec.anchor[0] + spec.pushOut[0] * 0.05,
      spec.anchor[1] + spec.pushOut[1] * 0.05,
      spec.anchor[2] + spec.pushOut[2] * 0.05,
    ]);
    let dx = outScreen.x - aScreen.x;
    let dy = outScreen.y - aScreen.y;
    let dLen = Math.hypot(dx, dy);
    if (dLen < 1e-4) {
      dx = aScreen.x - center.x;
      dy = aScreen.y - center.y;
      dLen = Math.hypot(dx, dy);
    }
    const dir = dLen >= 1e-4 ? { x: dx / dLen, y: dy / dLen } : spec.fallbackDir;
    let x = aScreen.x + dir.x * HANDLE_EDGE_OFFSET_PX;
    let y = aScreen.y + dir.y * HANDLE_EDGE_OFFSET_PX;

    const cDx = x - center.x;
    const cDy = y - center.y;
    const cDist = Math.hypot(cDx, cDy);
    if (cDist < MIN_HANDLE_CENTER_DIST_PX) {
      const pushDir = cDist >= 1e-4 ? { x: cDx / cDist, y: cDy / cDist } : dir;
      x = center.x + pushDir.x * MIN_HANDLE_CENTER_DIST_PX;
      y = center.y + pushDir.y * MIN_HANDLE_CENTER_DIST_PX;
    }

    const { arc, heads } = buildCurvedArrow(project, spec.anchor, spec.radial, axisVec, worldRadius);
    return {
      axis: spec.axis,
      x,
      y,
      arc,
      heads,
      visible: center.visible && aScreen.visible,
    };
  });

  const topScreen = project([bounds.center[0], bounds.max[1], bounds.center[2]]);
  const baseScreen = project([bounds.center[0], bounds.min[1], bounds.center[2]]);
  const liftAxis = computeLiftAxis(project, bounds.center);
  let liftX = topScreen.x + liftAxis.dirX * LIFT_EDGE_OFFSET_PX;
  let liftY = topScreen.y + liftAxis.dirY * LIFT_EDGE_OFFSET_PX;
  const lcDx = liftX - center.x;
  const lcDy = liftY - center.y;
  const lcDist = Math.hypot(lcDx, lcDy);
  if (lcDist < MIN_LIFT_CENTER_DIST_PX) {
    const pushDir = lcDist >= 1e-4 ? { x: lcDx / lcDist, y: lcDy / lcDist } : { x: liftAxis.dirX, y: liftAxis.dirY };
    liftX = center.x + pushDir.x * MIN_LIFT_CENTER_DIST_PX;
    liftY = center.y + pushDir.y * MIN_LIFT_CENTER_DIST_PX;
  }
  const lift: LiftHandleView = {
    x: liftX,
    y: liftY,
    visible: center.visible && topScreen.visible,
    axis: liftAxis,
    baseX: baseScreen.x,
    baseY: baseScreen.y,
  };

  // Push overlapping handles (lift + 3 rotation axes) apart when viewing very small pieces or zoomed way out.
  const all: { x: number; y: number; visible: boolean }[] = [lift, ...handles];
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i];
        const b = all[j];
        if (!a.visible || !b.visible) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= MIN_HANDLE_SEPARATION_PX) continue;
        const push = (MIN_HANDLE_SEPARATION_PX - dist) / 2;
        const ux = dist >= 1e-4 ? dx / dist : Math.cos((i + j) * 1.1);
        const uy = dist >= 1e-4 ? dy / dist : Math.sin((i + j) * 1.1);
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
      }
    }
  }

  for (const h of all) {
    h.x = clamp(h.x, VIEW_PAD_PX, width - VIEW_PAD_PX);
    h.y = clamp(h.y, VIEW_PAD_PX, height - VIEW_PAD_PX);
  }

  return { handles, lift, planes, sides, center };
}
