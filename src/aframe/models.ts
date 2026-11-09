import type { CarPartId } from '../game/carParts';
import type { BoxObstacle, CylinderObstacle, PlayerId, PropDefinition, RampObstacle } from '../game/types';
import { rulerTexture } from './textures';
import { applyCanvasTexture } from './helpers';

export interface EntitySpec {
  geometry?: string;
  material?: string;
  position?: string;
  rotation?: string;
  scale?: string;
  /** Casts a shadow unless false. */
  cast?: boolean;
  receive?: boolean;
  id?: string;
}

export function ent(parent: Element, spec: EntitySpec = {}) {
  const el = document.createElement('a-entity');
  if (spec.geometry) el.setAttribute('geometry', spec.geometry);
  if (spec.material) el.setAttribute('material', spec.material);
  if (spec.position) el.setAttribute('position', spec.position);
  if (spec.rotation) el.setAttribute('rotation', spec.rotation);
  if (spec.scale) el.setAttribute('scale', spec.scale);
  if (spec.geometry && (spec.cast !== false || spec.receive)) {
    el.setAttribute('shadow', `cast: ${spec.cast !== false}; receive: ${Boolean(spec.receive)}`);
  }
  if (spec.id) el.setAttribute('data-part', spec.id);
  parent.appendChild(el);
  return el;
}

const box = (w: number, h: number, d: number) => `primitive: box; width: ${w}; height: ${h}; depth: ${d}`;
const cyl = (r: number, h: number, seg = 18) =>
  `primitive: cylinder; radius: ${r}; height: ${h}; segmentsRadial: ${seg}`;
const mat = (color: string, roughness = 0.6, metalness = 0, extra = '') =>
  `color: ${color}; roughness: ${roughness}; metalness: ${metalness}; ${extra}`;

export const CAR_COLORS: Record<PlayerId, { body: string; accent: string; dark: string; hex: number }> = {
  p1: { body: '#EF4444', accent: '#FFFFFF', dark: '#991B1B', hex: 0xef4444 },
  p2: { body: '#06B6D4', accent: '#FACC15', dark: '#0E7490', hex: 0x06b6d4 },
};

export interface CarParts {
  body: Element;
  /** One group per physics part (see carParts.ts), in car coordinates. */
  partEls: Record<CarPartId, Element>;
  wheels: Element[];
  frontPivots: Element[];
  flame: Element;
  shield: Element;
}

/** RC buggy built from primitives. The nose points to +Z and the wheels rest on y = 0. */
export function buildCar(root: Element, player: PlayerId): CarParts {
  const c = CAR_COLORS[player];
  const body = ent(root);
  // Every group has its origin at the car origin, so the shapes keep their car coordinates.
  const group = () => ent(body);
  const partEls = {
    chassis: group(),
    shell: group(),
    frontBumper: group(),
    rearBumper: group(),
    spoiler: group(),
    wheelFL: group(),
    wheelFR: group(),
    wheelRL: group(),
    wheelRR: group(),
  } satisfies Record<CarPartId, Element>;
  const { chassis, shell, frontBumper, rearBumper, spoiler } = partEls;

  // Chassis tub and floor pan.
  ent(chassis, { geometry: box(0.27, 0.035, 0.46), material: mat('#1F2937', 0.8), position: '0 0.05 0' });
  ent(shell, { geometry: box(0.23, 0.06, 0.4), material: mat(c.body, 0.35, 0.1), position: '0 0.095 -0.005' });
  // Sloped nose.
  ent(shell, { geometry: box(0.21, 0.035, 0.13), material: mat(c.body, 0.35, 0.1), position: '0 0.11 0.2', rotation: '14 0 0' });
  // Racing stripes.
  ent(shell, { geometry: box(0.05, 0.004, 0.41), material: mat(c.accent, 0.5), position: '0 0.127 -0.005', cast: false });
  ent(shell, { geometry: box(0.05, 0.004, 0.125), material: mat(c.accent, 0.5), position: '0 0.13 0.2', rotation: '14 0 0', cast: false });

  // Cabin with dark glass and the roof bumper.
  ent(shell, { geometry: box(0.155, 0.07, 0.17), material: mat('#0F172A', 0.12, 0.35), position: '0 0.16 -0.035' });
  ent(shell, { geometry: box(0.165, 0.016, 0.13), material: mat(c.body, 0.35, 0.1), position: '0 0.2 -0.045' });
  ent(shell, { geometry: box(0.12, 0.018, 0.035), material: mat('#E5E7EB', 0.3, 0.75), position: '0 0.215 -0.015' });

  // Front push bumper.
  ent(frontBumper, { geometry: box(0.29, 0.042, 0.03), material: mat('#111827', 0.55, 0.3), position: '0 0.075 0.245' });
  ent(frontBumper, { geometry: box(0.09, 0.03, 0.012), material: mat(c.accent, 0.5), position: '0 0.08 0.262', cast: false });

  // Headlights.
  for (const side of [-0.075, 0.075]) {
    ent(shell, {
      geometry: 'primitive: sphere; radius: 0.019; segmentsWidth: 10; segmentsHeight: 8',
      material: 'color: #FEF9C3; emissive: #FEF08A; emissiveIntensity: 1.5; roughness: 0.3',
      position: `${side} 0.108 0.236`,
      cast: false,
    });
  }
  // Rear bumper with the tail lights.
  ent(rearBumper, { geometry: box(0.24, 0.036, 0.024), material: mat('#111827', 0.55, 0.3), position: '0 0.09 -0.22' });
  for (const side of [-0.08, 0.08]) {
    ent(rearBumper, {
      geometry: box(0.04, 0.018, 0.006),
      material: 'color: #7F1D1D; emissive: #DC2626; emissiveIntensity: 0.9',
      position: `${side} 0.105 -0.233`,
      cast: false,
    });
  }

  // Rear wing.
  for (const side of [-0.07, 0.07]) {
    ent(spoiler, { geometry: box(0.012, 0.075, 0.03), material: mat('#111827', 0.6), position: `${side} 0.165 -0.185` });
  }
  ent(spoiler, { geometry: box(0.27, 0.012, 0.075), material: mat(c.accent, 0.45), position: '0 0.208 -0.195', rotation: '-6 0 0' });
  for (const side of [-0.135, 0.135]) {
    ent(spoiler, { geometry: box(0.008, 0.042, 0.082), material: mat(c.dark, 0.5), position: `${side} 0.208 -0.195` });
  }

  // Antenna with a player-colored tip.
  ent(shell, { geometry: cyl(0.0035, 0.24, 6), material: mat('#111827', 0.4), position: '0.095 0.235 -0.14', rotation: '-8 0 0' });
  ent(shell, {
    geometry: 'primitive: sphere; radius: 0.013; segmentsWidth: 8; segmentsHeight: 6',
    material: `color: ${c.body}; emissive: ${c.body}; emissiveIntensity: 0.6`,
    position: '0.095 0.355 -0.157',
  });

  // Wheels. Each one has a tire and a hub so that the spin is visible.
  const wheels: Element[] = [];
  const frontPivots: Element[] = [];
  const wheelAt = (part: Element, x: number, z: number, front: boolean) => {
    const pivot = ent(part, { position: `${x} 0.058 ${z}` });
    if (front) frontPivots.push(pivot);
    const spin = ent(pivot);
    wheels.push(spin);
    ent(spin, { geometry: cyl(0.058, 0.05, 14), material: mat('#111827', 0.95), rotation: '0 0 90' });
    ent(spin, { geometry: cyl(0.027, 0.054, 8), material: mat(c.accent, 0.35, 0.5), rotation: '0 0 90', cast: false });
    ent(spin, { geometry: box(0.054, 0.09, 0.016), material: mat('#374151', 0.8), cast: false });
  };
  wheelAt(partEls.wheelFL, -0.145, 0.145, true);
  wheelAt(partEls.wheelFR, 0.145, 0.145, true);
  wheelAt(partEls.wheelRL, -0.145, -0.145, false);
  wheelAt(partEls.wheelRR, 0.145, -0.145, false);

  // Boost flame: scaled and shown by the car component.
  const flame = ent(body, {
    geometry: 'primitive: cone; radiusBottom: 0.05; radiusTop: 0; height: 0.2; segmentsRadial: 10',
    material: 'color: #F97316; emissive: #F59E0B; emissiveIntensity: 2; transparent: true; opacity: 0.9; shader: standard',
    position: '0 0.09 -0.3',
    rotation: '-90 0 0',
    cast: false,
  });
  flame.setAttribute('visible', 'false');

  // Invulnerability bubble.
  const shield = ent(root, {
    geometry: 'primitive: sphere; radius: 0.33; segmentsWidth: 18; segmentsHeight: 12',
    material: `color: ${c.body}; emissive: ${c.body}; emissiveIntensity: 0.4; transparent: true; opacity: 0.13; side: double; depthWrite: false`,
    position: '0 0.12 0',
    cast: false,
  });
  shield.setAttribute('visible', 'false');

  return { body, partEls, wheels, frontPivots, flame, shield };
}

export function buildMug(parent: Element, o: CylinderObstacle, color: string) {
  const root = ent(parent, { position: `${o.x} 0 ${o.z}`, rotation: `0 ${(o.rotation * 180) / Math.PI} 0` });
  const midY = o.height / 2;
  ent(root, {
    geometry: `primitive: cylinder; radius: ${o.radius}; height: ${o.height}; segmentsRadial: 28; openEnded: true`,
    material: mat('#F8FAFC', 0.22, 0, 'side: double'),
    position: `0 ${midY} 0`,
  });
  // Colored band and rim.
  ent(root, {
    geometry: `primitive: cylinder; radius: ${o.radius + 0.002}; height: 0.075; segmentsRadial: 28; openEnded: true`,
    material: mat(color, 0.3, 0, 'side: double'),
    position: `0 ${o.height * 0.55} 0`,
    cast: false,
  });
  ent(root, {
    geometry: `primitive: torus; radius: ${o.radius - 0.004}; radiusTubular: 0.009; segmentsRadial: 8; segmentsTubular: 34`,
    material: mat('#F8FAFC', 0.2),
    position: `0 ${o.height} 0`,
    rotation: '90 0 0',
    cast: false,
  });
  // Coffee.
  ent(root, {
    geometry: `primitive: circle; radius: ${o.radius - 0.004}; segments: 28`,
    material: mat('#3B1F0F', 0.15),
    position: `0 ${o.height - 0.04} 0`,
    rotation: '-90 0 0',
    cast: false,
  });
  // Foot, closes the bottom of the open cylinder.
  ent(root, {
    geometry: `primitive: cylinder; radius: ${o.radius}; height: 0.02; segmentsRadial: 28`,
    material: mat('#E2E8F0', 0.4),
    position: '0 0.01 0',
  });
  // Handle.
  ent(root, {
    geometry: 'primitive: torus; radius: 0.09; radiusTubular: 0.021; segmentsRadial: 10; segmentsTubular: 22; arc: 200',
    material: mat('#F8FAFC', 0.22),
    position: `${o.radius + 0.01} ${midY} 0`,
    rotation: '0 0 -100',
  });
}

const BOOK_COVERS = ['#7C2D12', '#1E3A8A', '#14532D', '#7F1D1D', '#134E4A'];

export function buildBooks(parent: Element, o: BoxObstacle, seed: number) {
  const root = ent(parent, { position: `${o.x} 0 ${o.z}`, rotation: `0 ${(o.rotation * 180) / Math.PI} 0` });
  const count = o.height > 0.28 ? 3 : 2;
  const each = o.height / count;
  const w = o.halfX * 2;
  const d = o.halfZ * 2;
  for (let i = 0; i < count; i++) {
    // Upper books are smaller and sit within the collision footprint.
    const shrink = i * 0.012;
    const bw = w - shrink;
    const bd = d - shrink;
    const color = BOOK_COVERS[(seed + i * 2) % BOOK_COVERS.length];
    const book = ent(root, { position: `0 ${each * i} 0`, rotation: `0 ${i === 1 ? 1.2 : i === 2 ? -0.9 : 0} 0` });
    const cover = 0.012;
    ent(book, { geometry: box(bw, cover, bd), material: mat(color, 0.7), position: `0 ${cover / 2} 0`, receive: true });
    ent(book, { geometry: box(bw, cover, bd), material: mat(color, 0.7), position: `0 ${each - cover / 2} 0`, receive: true });
    // Page block with a stripe of paper shadow lines is enough at this scale.
    ent(book, { geometry: box(bw - 0.03, each - cover * 2, bd - 0.02), material: mat('#F5EFD8', 0.95), position: `0.01 ${each / 2} 0` });
    // Spine, on the -X side, with a gold label.
    ent(book, { geometry: box(0.02, each, bd), material: mat(color, 0.6), position: `${-bw / 2 + 0.01} ${each / 2} 0` });
    ent(book, {
      geometry: box(0.003, each * 0.4, bd * 0.35),
      material: 'color: #EAB308; metalness: 0.7; roughness: 0.35',
      position: `${-bw / 2 - 0.001} ${each / 2} 0`,
      cast: false,
    });
  }
}

export function buildRamp(parent: Element, o: RampObstacle) {
  const root = ent(parent, { position: `${o.x} 0 ${o.z}`, rotation: `0 ${(o.rotation * 180) / Math.PI} 0` });
  const run = o.halfX * 2;
  const length = Math.hypot(run, o.height);
  const angle = (Math.atan2(o.height, run) * 180) / Math.PI;
  const ruler = ent(root, {
    geometry: box(length, 0.018, o.halfZ * 2),
    material: mat('#FFFFFF', 0.4),
    position: `0 ${o.height / 2 - 0.009} 0`,
    rotation: `0 0 ${angle}`,
    receive: true,
  });
  applyCanvasTexture(ruler, rulerTexture());
  // Wedge props under the high end: an eraser block and a thin riser.
  const propW = 0.12;
  ent(root, {
    geometry: box(propW, o.height * 0.92, o.halfZ * 1.75),
    material: mat('#475569', 0.7),
    position: `${o.halfX - propW / 2 - 0.01} ${(o.height * 0.92) / 2} 0`,
  });
  ent(root, {
    geometry: box(propW + 0.002, o.height * 0.3, o.halfZ * 1.77),
    material: mat('#F59E0B', 0.55),
    position: `${o.halfX - propW / 2 - 0.01} ${o.height * 0.5} 0`,
    cast: false,
  });
}

/** The returned element's rotation.x is the roll of a pencil around its axis. */
export function buildProp(parent: Element, def: PropDefinition) {
  const root = ent(parent, { position: `${def.x} 0 ${def.z}` });
  if (def.kind === 'eraser') {
    const spin = ent(root, { position: '0 0 0' });
    ent(spin, { geometry: box(0.22, 0.082, 0.12), material: mat('#F8FAFC', 0.9), position: '0 0.041 0' });
    ent(spin, { geometry: box(0.125, 0.09, 0.128), material: mat('#2563EB', 0.55), position: '-0.03 0.041 0' });
    ent(spin, { geometry: box(0.05, 0.092, 0.13), material: mat('#FACC15', 0.55), position: '-0.03 0.041 0', cast: false });
    return { root, spin };
  }
  const spin = ent(root, { position: '0 0.045 0' });
  const bodyLen = 0.56;
  // Hexagonal barrel along X.
  ent(spin, {
    geometry: `primitive: cylinder; radius: 0.042; height: ${bodyLen}; segmentsRadial: 6`,
    material: mat('#F59E0B', 0.45),
    rotation: '0 0 90',
    position: '-0.01 0 0',
  });
  ent(spin, {
    geometry: 'primitive: cone; radiusBottom: 0.042; radiusTop: 0.012; height: 0.1; segmentsRadial: 6',
    material: mat('#E8C9A0', 0.8),
    rotation: '0 0 -90',
    position: `${bodyLen / 2 + 0.04} 0 0`,
  });
  ent(spin, {
    geometry: 'primitive: cone; radiusBottom: 0.012; radiusTop: 0; height: 0.03; segmentsRadial: 6',
    material: mat('#1F2937', 0.4),
    rotation: '0 0 -90',
    position: `${bodyLen / 2 + 0.105} 0 0`,
    cast: false,
  });
  ent(spin, {
    geometry: 'primitive: cylinder; radius: 0.044; height: 0.04; segmentsRadial: 10',
    material: mat('#CBD5E1', 0.3, 0.8),
    rotation: '0 0 90',
    position: `${-bodyLen / 2 - 0.02} 0 0`,
  });
  ent(spin, {
    geometry: 'primitive: cylinder; radius: 0.042; height: 0.05; segmentsRadial: 10',
    material: mat('#FB7185', 0.85),
    rotation: '0 0 90',
    position: `${-bodyLen / 2 - 0.065} 0 0`,
  });
  return { root, spin };
}
