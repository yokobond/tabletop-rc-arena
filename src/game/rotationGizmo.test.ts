import { describe, expect, it } from 'vitest';
import { IDENTITY, pieceHalf, type BodyPiece, type Vec3 } from './bodyParts';
import {
  axisBasis,
  buildCurvedArrow,
  chooseHandleSides,
  computeLiftAxis,
  computeProtractorPlane,
  layoutRotationGizmo,
  pointerOnProtractor,
  selectionBounds,
  stepDragAngle,
  stepLiftDelta,
  type ProjectFn,
} from './rotationGizmo';

const piece = (id: string, x: number, y: number, z: number): BodyPiece => ({
  id,
  kind: 'cube',
  x,
  y,
  z,
  rot: IDENTITY,
  adhesive: 'tape',
});

/** Simple right-handed perspective camera looking at `target`. */
function makeCamera(pos: Vec3, target: Vec3 = [0, 0.14, 0], width = 1000, height = 800): ProjectFn {
  const norm = (v: Vec3): Vec3 => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const fwd = norm([target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]]);
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const f = 1 / Math.tan((34 * Math.PI) / 360);
  const aspect = width / height;

  return (p: Vec3) => {
    const rel: Vec3 = [p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]];
    const cx = dot(rel, right);
    const cy = dot(rel, up);
    const cz = dot(rel, fwd);
    const ndcX = (cx * f) / aspect / Math.max(0.01, cz);
    const ndcY = (cy * f) / Math.max(0.01, cz);
    return {
      x: ((ndcX + 1) / 2) * width,
      y: ((1 - ndcY) / 2) * height,
      visible: cz > 0.01,
    };
  };
}

describe('selectionBounds', () => {
  it('computes combined car-local bounds and center for one or more pieces', () => {
    expect(selectionBounds([])).toBeNull();
    const h = pieceHalf('cube', IDENTITY);
    const a = piece('a', -0.05, 0.14, 0);
    const b = piece('b', 0.05, 0.21, 0.1);
    const bounds = selectionBounds([a, b])!;
    expect(bounds.min[0]).toBeCloseTo(-0.05 - h[0], 6);
    expect(bounds.max[0]).toBeCloseTo(0.05 + h[0], 6);
    expect(bounds.min[1]).toBeCloseTo(0.14 - h[1], 6);
    expect(bounds.max[1]).toBeCloseTo(0.21 + h[1], 6);
    expect(bounds.center[0]).toBeCloseTo(0, 6);
    expect(bounds.center[2]).toBeCloseTo(0.05, 6);
  });
});

describe('chooseHandleSides', () => {
  const center: Vec3 = [0, 0.14, 0];

  it('places X/Z on far edges and Y on the nearest horizontal edge in every quadrant', () => {
    const q1 = chooseHandleSides([1, 0.5, 1.2], center);
    expect(q1).toEqual({ x: 'nx', y: 'pz', z: 'nz' });
    const q2 = chooseHandleSides([-1.2, 0.5, -1], center);
    expect(q2).toEqual({ x: 'px', y: 'nx', z: 'pz' });
  });

  it('keeps previous sides within the hysteresis band to prevent flicker', () => {
    const start = chooseHandleSides([0.5, 0.5, 1], center);
    const slightlyAcross = chooseHandleSides([-0.05, 0.5, 1], center, start);
    expect(slightlyAcross.x).toBe(start.x);
  });
});

describe('protractor plane and inverse mapping', () => {
  it('preserves handedness and round-trips angles from both front and back camera views', () => {
    const center: Vec3 = [0, 0.14, 0];
    for (const cam of [
      [1.1, 0.95, 1.1] as Vec3,
      [-1.1, 0.95, -1.1] as Vec3,
    ]) {
      const project = makeCamera(cam, center);
      const dist = Math.hypot(cam[0] - center[0], cam[1] - center[1], cam[2] - center[2]);
      for (const axis of ['x', 'y', 'z'] as const) {
        const plane = computeProtractorPlane(project, center, axis, dist, 1000, 800);
        const { u, v } = axisBasis(axis);
        for (const deg of [-135, -45, 0, 30, 110]) {
          const rad = (deg * Math.PI) / 180;
          const worldPt: Vec3 = [
            center[0] + (u[0] * Math.cos(rad) + v[0] * Math.sin(rad)) * 0.05,
            center[1] + (u[1] * Math.cos(rad) + v[1] * Math.sin(rad)) * 0.05,
            center[2] + (u[2] * Math.cos(rad) + v[2] * Math.sin(rad)) * 0.05,
          ];
          const sc = project(worldPt);
          const mapped = pointerOnProtractor(plane, sc.x, sc.y)!;
          expect(mapped).not.toBeNull();
          // Signed angular error must be near zero (same winding direction from every camera).
          const diff = Math.atan2(Math.sin(((mapped.angleDeg - deg) * Math.PI) / 180), Math.cos(((mapped.angleDeg - deg) * Math.PI) / 180));
          expect(Math.abs((diff * 180) / Math.PI)).toBeLessThan(1.5);
        }
      }
    }
  });

  it('never degenerates to a zero-area ellipse even when viewed strictly edge-on', () => {
    const center: Vec3 = [0, 0.14, 0];
    // Camera sits right in the Y=0.14 plane looking horizontally along +Z: X and Z planes face edge-on.
    const cam: Vec3 = [0, 0.14, 1.4];
    const project = makeCamera(cam, center);
    const planeX = computeProtractorPlane(project, center, 'x', 1.4, 1000, 800);
    const det = Math.abs(planeX.a * planeX.d - planeX.b * planeX.c);
    expect(det).toBeGreaterThan(0.1);
    const mapped = pointerOnProtractor(planeX, planeX.cx + 40, planeX.cy - 30);
    expect(mapped).not.toBeNull();
  });
});

describe('stepDragAngle', () => {
  it('snaps to 15° inside the ring (5° with Shift) and 1° outside (45° with Shift)', () => {
    expect(stepDragAngle({ prevAngleDeg: 0, currAngleDeg: 14, prevUnwrappedDeg: 0, radiusNorm: 0.85, shiftKey: false })).toEqual({
      unwrappedDeg: 14,
      deltaDeg: 15,
      mode: 'snap',
      step: 15,
    });
    expect(stepDragAngle({ prevAngleDeg: 0, currAngleDeg: 14, prevUnwrappedDeg: 0, radiusNorm: 0.85, shiftKey: true })).toEqual({
      unwrappedDeg: 14,
      deltaDeg: 15,
      mode: 'snap',
      step: 5,
    });
    expect(stepDragAngle({ prevAngleDeg: 0, currAngleDeg: 7, prevUnwrappedDeg: 0, radiusNorm: 0.85, shiftKey: true }).deltaDeg).toBe(5);
    expect(stepDragAngle({ prevAngleDeg: 0, currAngleDeg: 13, prevUnwrappedDeg: 0, radiusNorm: 1.35, shiftKey: false })).toEqual({
      unwrappedDeg: 13,
      deltaDeg: 13,
      mode: 'fine',
      step: 1,
    });
    expect(stepDragAngle({ prevAngleDeg: 0, currAngleDeg: 35, prevUnwrappedDeg: 0, radiusNorm: 1.35, shiftKey: true })).toEqual({
      unwrappedDeg: 35,
      deltaDeg: 45,
      mode: 'fine',
      step: 45,
    });
  });

  it('tracks angles continuously across the ±180° boundary', () => {
    const s1 = stepDragAngle({ prevAngleDeg: 170, currAngleDeg: -175, prevUnwrappedDeg: 170, radiusNorm: 1.3, shiftKey: false });
    expect(s1.unwrappedDeg).toBe(185);
    expect(s1.deltaDeg).toBe(-175);
    const s2 = stepDragAngle({ prevAngleDeg: -175, currAngleDeg: 170, prevUnwrappedDeg: s1.unwrappedDeg, radiusNorm: 1.3, shiftKey: false });
    expect(s2.unwrappedDeg).toBe(170);
    expect(s2.deltaDeg).toBe(170);
  });
});

describe('computeLiftAxis and stepLiftDelta', () => {
  it('points upward on screen for angled views and keeps a usable scale from straight above', () => {
    const center: Vec3 = [0, 0.14, 0];
    const angled = computeLiftAxis(makeCamera([1.0, 0.8, 1.0], center), center);
    expect(angled.dirY).toBeLessThan(-0.9);
    expect(angled.pxPerMeter).toBeGreaterThan(220);

    // Camera directly overhead: cross(fwd, [0,1,0]) is degenerate unless handled, so test near-zenith view.
    const topDown = computeLiftAxis(makeCamera([0, 1.5, 0.001], center), center);
    expect(topDown.pxPerMeter).toBeGreaterThanOrEqual(220);
    expect(Math.hypot(topDown.dirX, topDown.dirY)).toBeCloseTo(1, 5);
  });

  it('snaps drag motion along the vertical axis to 0.5cm (or 0.1cm with Shift) without sign errors', () => {
    const axis = { dirX: 0, dirY: -1, pxPerMeter: 500, angleDeg: 0 };
    // Moving 6px up (dy = -6) is +0.012m -> snaps to +0.01m (1cm) in 0.5cm mode, +0.012m in 0.1cm mode.
    expect(stepLiftDelta({ dx: 0, dy: -6, axis, shiftKey: false })).toEqual({ deltaM: 0.01, stepM: 0.005 });
    expect(stepLiftDelta({ dx: 0, dy: -6, axis, shiftKey: true })).toEqual({ deltaM: 0.012, stepM: 0.001 });
    // Moving down gives negative deltaM, and 0 avoids -0.
    expect(stepLiftDelta({ dx: 0, dy: 5, axis, shiftKey: false })).toEqual({ deltaM: -0.01, stepM: 0.005 });
    expect(Object.is(stepLiftDelta({ dx: 0, dy: 0, axis, shiftKey: false }).deltaM, -0)).toBe(false);
  });
});

describe('buildCurvedArrow and layoutRotationGizmo', () => {
  it('keeps curved arrow legible even in edge-on camera angles', () => {
    const project = makeCamera([0, 0.14, 1.5], [0, 0.14, 0]);
    const arrow = buildCurvedArrow(project, [0, 0.175, 0], [0, 1, 0], [1, 0, 0], 0.05);
    expect(arrow.arc.startsWith('M')).toBe(true);
    expect(arrow.heads.includes('Z')).toBe(true);
  });

  it('separates all 4 handles (lift + 3 rotation axes) cleanly even for tiny parts viewed from afar', () => {
    const tiny: BodyPiece = {
      id: 't',
      kind: 'made',
      made: { name: 'tiny', shape: { kind: 'box', size: [0.01, 0.01, 0.01] }, mass: 0.01, color: '#3B82F6' },
      x: 0,
      y: 0.11,
      z: 0,
      rot: IDENTITY,
      adhesive: 'tape',
    };
    const bounds = selectionBounds([tiny])!;
    const cam: Vec3 = [-1.8, 1.2, 2.0];
    const layout = layoutRotationGizmo({
      bounds,
      cameraPos: cam,
      width: 1000,
      height: 800,
      project: makeCamera(cam, bounds.center, 1000, 800),
    });
    expect(layout.handles).toHaveLength(3);
    expect(layout.lift.visible).toBe(true);
    const all = [layout.lift, ...layout.handles];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i];
        const b = all[j];
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(41.9);
      }
    }
  });
});
