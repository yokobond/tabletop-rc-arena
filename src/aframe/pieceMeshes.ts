/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The garage pieces as plain three.js groups, used both in the garage's own renderer and on the
 * cars in the arena. Each group is in the piece's own frame: centered, a cylinder along local Y.
 */
import { orientationQuat, specOf, type Bond, type PartType, type PieceShape as PartShape, type PieceKind, type Quat } from '../game/bodyParts';
import type { PlayerId } from '../game/types';
import { THREE } from './helpers';
import { CAR_COLORS } from './models';
import { meshFor } from '../runtime/meshStore';
import { rulerTexture } from './textures';

const materials = new Map<string, any>();
function mat(color: string, roughness = 0.6, metalness = 0, extra: Record<string, unknown> = {}) {
  const key = `${color}|${roughness}|${metalness}|${JSON.stringify(extra)}`;
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
    materials.set(key, m);
  }
  return m;
}

let rulerMat: any = null;
function rulerMaterial() {
  if (!rulerMat) {
    const texture = new THREE.CanvasTexture(rulerTexture());
    texture.colorSpace = THREE.SRGBColorSpace;
    rulerMat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.4 });
  }
  return rulerMat;
}

function mesh(parent: any, geometry: any, material: any, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

const boxGeo = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);
const cylGeo = (r: number, h: number, seg = 20, rTop = r) => new THREE.CylinderGeometry(rTop, r, h, seg);

export function buildPieceMesh(type: PartType | PieceKind, player: PlayerId) {
  const g = new THREE.Group();
  const spec = specOf(type);
  const color = CAR_COLORS[player];
  switch (spec.kind) {
    case 'eraser': {
      const [x, y, z] = (spec.shape as { size: [number, number, number] }).size;
      mesh(g, boxGeo(x, y, z), mat('#F8FAFC', 0.9));
      mesh(g, boxGeo(x * 0.56, y + 0.003, z + 0.003), mat('#2563EB', 0.55), -x * 0.12, 0, 0);
      mesh(g, boxGeo(x * 0.18, y + 0.004, z + 0.004), mat('#FACC15', 0.55), -x * 0.12, 0, 0);
      break;
    }
    case 'brick': {
      const [x, y, z] = (spec.shape as { size: [number, number, number] }).size;
      const plastic = mat(color.body, 0.3, 0.05);
      mesh(g, boxGeo(x, y, z), plastic);
      const stud = cylGeo(0.0095, 0.009, 16);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) mesh(g, stud, plastic, (i - 1.5) * (x / 4), y / 2 + 0.0045, (j - 0.5) * (z / 2));
      break;
    }
    case 'cube': {
      const s = (spec.shape as { size: [number, number, number] }).size[0];
      mesh(g, boxGeo(s, s, s), mat('#E3B074', 0.75));
      // A painted letter panel on two sides, like a child's block.
      mesh(g, boxGeo(s * 0.6, s * 0.6, 0.002), mat(color.body, 0.5), 0, 0, s / 2 + 0.001);
      mesh(g, boxGeo(0.002, s * 0.6, s * 0.6), mat('#22C55E', 0.5), s / 2 + 0.001, 0, 0);
      break;
    }
    case 'matchbox': {
      const [x, y, z] = (spec.shape as { size: [number, number, number] }).size;
      mesh(g, boxGeo(x, y, z), mat('#F5E6C8', 0.85));
      mesh(g, boxGeo(x * 0.98, y + 0.002, z * 0.9), mat('#DC2626', 0.6));
      mesh(g, boxGeo(x * 0.5, y + 0.003, z * 0.5), mat('#FDE68A', 0.6));
      for (const side of [-1, 1]) mesh(g, boxGeo(x * 0.98, y * 0.7, 0.002), mat('#57290F', 0.95), 0, 0, side * (z * 0.45 + 0.001));
      break;
    }
    case 'ruler': {
      const [x, y, z] = (spec.shape as { size: [number, number, number] }).size;
      const top = rulerMaterial();
      const side = mat('#EAB308', 0.4);
      const m = mesh(g, boxGeo(x, y, z), [side, side, top, top, side, side]);
      m.castShadow = true;
      break;
    }
    case 'pencil': {
      const { r, h } = spec.shape as { r: number; h: number };
      const body = h - 0.07;
      mesh(g, cylGeo(r, body, 6), mat('#F59E0B', 0.45), 0, -0.01, 0);
      mesh(g, cylGeo(r, 0.045, 6, 0.006), mat('#E8C9A0', 0.8), 0, body / 2 + 0.0125, 0);
      mesh(g, cylGeo(0.006, 0.012, 6, 0.0005), mat('#1F2937', 0.4), 0, body / 2 + 0.041, 0);
      mesh(g, cylGeo(r * 1.04, 0.02, 12), mat('#CBD5E1', 0.3, 0.8), 0, -body / 2 - 0.02, 0);
      mesh(g, cylGeo(r, 0.02, 12), mat('#FB7185', 0.85), 0, -body / 2 - 0.04, 0);
      break;
    }
    case 'cap': {
      const { r, h } = spec.shape as { r: number; h: number };
      mesh(g, cylGeo(r, h, 28), mat('#16A34A', 0.35));
      mesh(g, cylGeo(r * 0.82, 0.002, 24), mat('#4ADE80', 0.3), 0, h / 2 + 0.001, 0);
      break;
    }
    case 'battery': {
      const { r, h } = spec.shape as { r: number; h: number };
      mesh(g, cylGeo(r, h * 0.66, 24), mat('#111827', 0.5, 0.2), 0, -h * 0.17, 0);
      mesh(g, cylGeo(r, h * 0.3, 24), mat('#D97706', 0.3, 0.6), 0, h * 0.33, 0);
      mesh(g, cylGeo(r * 1.01, 0.006, 24), mat('#F8FAFC', 0.5), 0, h * 0.16, 0);
      mesh(g, cylGeo(r * 0.3, 0.006, 12), mat('#CBD5E1', 0.25, 0.9), 0, h / 2 + 0.003, 0);
      break;
    }
    case 'cup': {
      const { r, h } = spec.shape as { r: number; h: number };
      const wall = new THREE.CylinderGeometry(r, r * 0.74, h, 28, 1, true);
      mesh(g, wall, mat('#FFFFFF', 0.7, 0, { side: THREE.DoubleSide }));
      mesh(g, new THREE.CylinderGeometry(r * 0.94, r * 0.84, h * 0.3, 28, 1, true), mat(color.body, 0.6, 0, { side: THREE.DoubleSide }), 0, h * 0.05, 0).scale.set(1.012, 1, 1.012);
      mesh(g, cylGeo(r * 0.74, 0.003, 24), mat('#F1F5F9', 0.7), 0, -h / 2 + 0.0015, 0);
      mesh(g, new THREE.TorusGeometry(r, 0.003, 6, 32), mat('#FFFFFF', 0.6), 0, h / 2, 0).rotation.x = Math.PI / 2;
      break;
    }
    case 'ball': {
      const { r } = spec.shape as { r: number };
      mesh(g, new THREE.SphereGeometry(r, 24, 16), mat('#FFF7ED', 0.35));
      break;
    }
    case 'made': {
      const look = typeof type === 'object' && type.made?.mesh ? lookGeometry(type.made.mesh) : null;
      if (look) mesh(g, look, mat(spec.color ?? '#94A3B8', 0.55, 0, { flatShading: true, side: THREE.DoubleSide }));
      else buildMadeMesh(g, spec.shape, spec.color ?? '#94A3B8');
      break;
    }
  }
  return g;
}

const lookGeometries = new Map<string, any>();

/** The look of a part made from an STL file, or null while it has not arrived (its plain shape stands in). */
function lookGeometry(id: string) {
  let geometry = lookGeometries.get(id);
  if (geometry) return geometry;
  // The maker makes a new look at every slider step: only the latest few are kept.
  if (lookGeometries.size >= 48) lookGeometries.delete(lookGeometries.keys().next().value!);
  const look = meshFor(id);
  if (!look) return null;
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.BufferAttribute(look.pos, 3));
  indexed.setIndex(new THREE.BufferAttribute(look.idx, 1));
  // Facets, not smoothed: a thinned mesh looks better cut than melted.
  geometry = indexed.toNonIndexed();
  geometry.computeVertexNormals();
  lookGeometries.set(id, geometry);
  return geometry;
}

/** Red lines around the shape a part bumps with, drawn through the part (the maker shows it over an STL look). */
export function shapeOutline(shape: PartShape) {
  const material = new THREE.LineBasicMaterial({ color: '#F43F5E', depthTest: false, transparent: true, opacity: 0.95 });
  if (shape.kind === 'box') {
    const lines = new THREE.LineSegments(new THREE.EdgesGeometry(boxGeo(...shape.size)), material);
    lines.renderOrder = 10;
    return lines;
  }
  const points: number[] = [];
  const ring = (r: number, plane: (a: number, b: number) => [number, number, number]) => {
    const n = 40;
    for (let i = 0; i < n; i++) {
      const t0 = (i / n) * Math.PI * 2;
      const t1 = ((i + 1) / n) * Math.PI * 2;
      points.push(...plane(Math.cos(t0) * r, Math.sin(t0) * r), ...plane(Math.cos(t1) * r, Math.sin(t1) * r));
    }
  };
  if (shape.kind === 'cylinder') {
    const { r, h } = shape;
    for (const y of [-h / 2, h / 2]) ring(r, (a, b) => [a, y, b]);
    for (const [x, z] of [[r, 0], [-r, 0], [0, r], [0, -r]]) points.push(x, -h / 2, z, x, h / 2, z);
  } else {
    ring(shape.r, (a, b) => [a, b, 0]);
    ring(shape.r, (a, b) => [0, a, b]);
    ring(shape.r, (a, b) => [a, 0, b]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  const lines = new THREE.LineSegments(geometry, material);
  lines.renderOrder = 10;
  return lines;
}

/** A made-up part: its plain shape in its color, with a slightly darker rim so its edges read. */
function buildMadeMesh(g: any, shape: PartShape, color: string) {
  const body = mat(color, 0.5);
  const rim = new THREE.Color(color).multiplyScalar(0.72);
  if (shape.kind === 'box') {
    const [x, y, z] = shape.size;
    mesh(g, boxGeo(x, y, z), body);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(boxGeo(x, y, z)), new THREE.LineBasicMaterial({ color: rim }));
    g.add(edges);
  } else if (shape.kind === 'cylinder') {
    mesh(g, cylGeo(shape.r, shape.h, 28), body);
    for (const end of [-1, 1]) mesh(g, cylGeo(shape.r * 0.999, 0.0015, 28), mat(`#${rim.getHexString()}`, 0.5), 0, end * (shape.h / 2 - 0.0006), 0);
  } else {
    mesh(g, new THREE.SphereGeometry(shape.r, 24, 16), body);
  }
}

/** A piece at its place on the car (`x, y, z`, turned by `rot`). */
export function placedPiece(piece: PartType & { x: number; y: number; z: number; rot: Quat }, player: PlayerId) {
  const g = buildPieceMesh(piece, player);
  const q = orientationQuat(piece.rot);
  g.position.set(piece.x, piece.y, piece.z);
  g.quaternion.set(q.x, q.y, q.z, q.w);
  return g;
}

/** What superglue and hot glue look like: a thin glossy clear-blue film, or a milky blob filling the gap. */
export function buildBondMesh(bond: Bond) {
  const [hx, hy, hz] = bond.half;
  const q = orientationQuat(bond.rot);
  if (bond.kind === 'superglue') {
    // Slightly wider than the contact footprint so the thin film catches the light at the seam.
    const pad = 0.002;
    const thin = (h: number) => (h < 0.002 ? 0.0014 : h + pad);
    const m = new THREE.Mesh(
      boxGeo(thin(hx) * 2, thin(hy) * 2, thin(hz) * 2),
      mat('#DBEAFE', 0.1, 0.1, { transparent: true, opacity: 0.85, emissive: '#60A5FA', emissiveIntensity: 0.3 }),
    );
    m.position.set(...bond.center);
    m.quaternion.set(q.x, q.y, q.z, q.w);
    return m;
  }
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    mat('#FDF4FF', 0.2, 0, { transparent: true, opacity: 0.78, emissive: '#F9A8D4', emissiveIntensity: 0.2 }),
  );
  m.scale.set(hx * 1.15 + 0.004, hy * 1.15 + 0.004, hz * 1.15 + 0.004);
  m.position.set(...bond.center);
  m.quaternion.set(q.x, q.y, q.z, q.w);
  m.castShadow = true;
  return m;
}

/** The chassis without a body: tub, bumpers and wheels (as `buildCar` draws them). */
export function buildBaseMesh(player: PlayerId) {
  const c = CAR_COLORS[player];
  const g = new THREE.Group();
  mesh(g, boxGeo(0.27, 0.05, 0.46), mat('#1F2937', 0.8), 0, 0.08, 0);
  // A deck plate in the team color, where things get stuck.
  mesh(g, boxGeo(0.25, 0.001, 0.42), mat(c.dark, 0.6), 0, 0.1052, 0);
  mesh(g, boxGeo(0.29, 0.042, 0.03), mat('#111827', 0.55, 0.3), 0, 0.075, 0.245);
  mesh(g, boxGeo(0.09, 0.03, 0.012), mat(c.accent, 0.5), 0, 0.08, 0.262);
  mesh(g, boxGeo(0.24, 0.036, 0.024), mat('#111827', 0.55, 0.3), 0, 0.09, -0.22);
  for (const side of [-0.08, 0.08]) {
    mesh(g, boxGeo(0.04, 0.018, 0.006), new THREE.MeshStandardMaterial({ color: '#7F1D1D', emissive: '#DC2626', emissiveIntensity: 0.9 }), side, 0.105, -0.233);
  }
  for (const x of [-0.145, 0.145]) {
    for (const z of [-0.145, 0.145]) {
      const tire = mesh(g, cylGeo(0.058, 0.05, 20), mat('#111827', 0.95), x, 0.058, z);
      tire.rotation.z = Math.PI / 2;
      const hub = mesh(g, cylGeo(0.027, 0.054, 10), mat(c.accent, 0.35, 0.5), x, 0.058, z);
      hub.rotation.z = Math.PI / 2;
    }
  }
  return g;
}
