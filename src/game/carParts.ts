/**
 * The car as an assembly of parts. Each part is one collider on the chassis body; a later
 * version can break a part off (`PhysicsWorld.detachPart`) once a hit exceeds `breakImpulse`.
 * Coordinates are car-local: the nose points to +Z and the wheels rest on y = 0.
 */
export type PartShape =
  | { kind: 'cuboid'; hx: number; hy: number; hz: number; round?: number }
  | { kind: 'ball'; r: number };

export type CarPartId =
  | 'chassis'
  | 'shell'
  | 'frontBumper'
  | 'rearBumper'
  | 'spoiler'
  | 'wheelFL'
  | 'wheelFR'
  | 'wheelRL'
  | 'wheelRR';

export interface CarPartSpec {
  id: CarPartId;
  shape: PartShape;
  offset: [number, number, number];
  mass: number;
  /** Contact force that tears the part off. Infinity keeps it attached. */
  breakImpulse: number;
  isWheel?: boolean;
}

export const WHEEL_RADIUS = 0.058;
export const WHEEL_X = 0.145;
export const WHEEL_Z = 0.145;

const wheel = (id: CarPartId, x: number, z: number): CarPartSpec => ({
  id,
  shape: { kind: 'ball', r: WHEEL_RADIUS },
  offset: [x, WHEEL_RADIUS, z],
  mass: 0.04,
  breakImpulse: Infinity,
  isWheel: true,
});

/** Masses add up to 1, the unit the arcade tuning was made for. */
export const CAR_PARTS: CarPartSpec[] = [
  { id: 'chassis', shape: { kind: 'cuboid', hx: 0.135, hy: 0.025, hz: 0.23, round: 0.01 }, offset: [0, 0.08, 0], mass: 0.45, breakImpulse: Infinity },
  { id: 'shell', shape: { kind: 'cuboid', hx: 0.11, hy: 0.05, hz: 0.19 }, offset: [0, 0.15, -0.01], mass: 0.25, breakImpulse: Infinity },
  { id: 'frontBumper', shape: { kind: 'cuboid', hx: 0.145, hy: 0.021, hz: 0.015 }, offset: [0, 0.075, 0.245], mass: 0.05, breakImpulse: Infinity },
  { id: 'rearBumper', shape: { kind: 'cuboid', hx: 0.12, hy: 0.018, hz: 0.012 }, offset: [0, 0.09, -0.22], mass: 0.05, breakImpulse: Infinity },
  { id: 'spoiler', shape: { kind: 'cuboid', hx: 0.135, hy: 0.006, hz: 0.0375 }, offset: [0, 0.208, -0.195], mass: 0.04, breakImpulse: Infinity },
  wheel('wheelFL', -WHEEL_X, WHEEL_Z),
  wheel('wheelFR', WHEEL_X, WHEEL_Z),
  wheel('wheelRL', -WHEEL_X, -WHEEL_Z),
  wheel('wheelRR', WHEEL_X, -WHEEL_Z),
];

export const CAR_PART_IDS = CAR_PARTS.map((p) => p.id);
