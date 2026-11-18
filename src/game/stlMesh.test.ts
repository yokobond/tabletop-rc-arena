import { describe, expect, it } from 'vitest';
import { emptyDesign, IDENTITY, LYING, putPiece, readMadePart, rotationMatrix, sanitizeDesign, specOf, turnMatrix, type Vec3 } from './bodyParts';
import {
  bakeMesh,
  bestFit,
  decodeMesh,
  fitShapes,
  MAX_MESH_TRIANGLES,
  measureMesh,
  meshIdOf,
  readStl,
  StlError,
  thinMesh,
  unbakeMesh,
} from './stlMesh';

type P = [number, number, number];
type Tri = [P, P, P];

/** A binary STL of the triangles (file coordinates: Z up). */
function binaryStl(tris: Tri[]) {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const view = new DataView(buf);
  view.setUint32(80, tris.length, true);
  tris.forEach((t, i) => t.flat().forEach((v, k) => view.setFloat32(84 + i * 50 + 12 + k * 4, v, true)));
  return buf;
}

function textStl(tris: Tri[]) {
  const facets = tris.map((t) => `facet normal 0 0 0\n outer loop\n${t.map((p) => `  vertex ${p.join(' ')}`).join('\n')}\n endloop\nendfacet`);
  return new TextEncoder().encode(`solid test\n${facets.join('\n')}\nendsolid test\n`).buffer as ArrayBuffer;
}

/** A box from 0 to (x, y, z), faces outward. */
function boxTris(x: number, y: number, z: number): Tri[] {
  const c = (i: number): P => [i & 1 ? x : 0, i & 2 ? y : 0, i & 4 ? z : 0];
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  return quads.flatMap(([a, b, d, e]) => [[c(a), c(b), c(d)], [c(a), c(d), c(e)]] as Tri[]);
}

/** A closed tube along the file's Z (or X), `n` sides. */
function tubeTris(r: number, h: number, n = 32, along: 'z' | 'x' = 'z'): Tri[] {
  const at = (i: number, top: boolean): P => {
    const a = (i / n) * Math.PI * 2;
    const p: P = [Math.cos(a) * r, Math.sin(a) * r, top ? h : 0];
    return along === 'z' ? p : [p[2], p[0], p[1]];
  };
  const bottom: P = along === 'z' ? [0, 0, 0] : [0, 0, 0];
  const top: P = along === 'z' ? [0, 0, h] : [h, 0, 0];
  const out: Tri[] = [];
  for (let i = 0; i < n; i++) {
    out.push([at(i, false), at(i + 1, false), at(i + 1, true)], [at(i, false), at(i + 1, true), at(i, true)]);
    out.push([bottom, at(i + 1, false), at(i, false)], [top, at(i, true), at(i + 1, true)]);
  }
  return out;
}

function ballTris(r: number, rings = 16, segs = 24): Tri[] {
  const at = (i: number, j: number): P => {
    const t = (i / rings) * Math.PI;
    const p = (j / segs) * Math.PI * 2;
    return [Math.sin(t) * Math.cos(p) * r, Math.sin(t) * Math.sin(p) * r, Math.cos(t) * r];
  };
  const out: Tri[] = [];
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < segs; j++) {
      if (i > 0) out.push([at(i, j), at(i + 1, j), at(i, j + 1)]);
      if (i < rings - 1) out.push([at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
    }
  return out;
}

const extents = (pos: Float32Array) =>
  [0, 1, 2].map((k) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = k; i < pos.length; i += 3) {
      lo = Math.min(lo, pos[i]);
      hi = Math.max(hi, pos[i]);
    }
    return hi - lo;
  });

describe('reading STL files', () => {
  it('reads binary and text files alike, stands Z up as Y and welds the corners', () => {
    const tris = boxTris(80, 60, 40);
    for (const buf of [binaryStl(tris), textStl(tris)]) {
      const mesh = readStl(buf);
      expect(mesh.pos.length / 3).toBe(8);
      expect(mesh.idx.length / 3).toBe(12);
      const m = measureMesh(mesh);
      expect(m.size.map((v) => Math.round(v))).toEqual([80, 40, 60]);
      expect(m.volume).toBeCloseTo(80 * 60 * 40, 0);
    }
  });

  it('refuses what is not a mesh', () => {
    expect(() => readStl(new TextEncoder().encode('hello').buffer as ArrayBuffer)).toThrow(StlError);
    expect(() => readStl(binaryStl([]))).toThrow(StlError);
  });

  it('thins a dense mesh to what a part may carry', () => {
    const dense = readStl(binaryStl(ballTris(30, 90, 120)));
    expect(dense.idx.length / 3).toBeGreaterThan(MAX_MESH_TRIANGLES * 5);
    const thin = thinMesh(dense);
    const tris = thin.idx.length / 3;
    expect(tris).toBeLessThanOrEqual(MAX_MESH_TRIANGLES);
    expect(tris).toBeGreaterThan(MAX_MESH_TRIANGLES / 4);
    expect(extents(thin.pos)[1]).toBeGreaterThan(55);
  });
});

describe('fitting a plain shape inside', () => {
  const fitOf = (tris: Tri[], scale = 0.001) => {
    const mesh = readStl(binaryStl(tris));
    const m = measureMesh(mesh);
    const fits = fitShapes(m, scale);
    return { mesh, m, fits, best: bestFit(fits) };
  };
  /** Inside, but not by much: within `slack` (a few cells of the grid it is found in). */
  const near = (v: number, outer: number, slack: number) => {
    expect(v).toBeLessThanOrEqual(outer + 1e-9);
    expect(v).toBeGreaterThanOrEqual(outer - slack);
  };
  const moved = (tris: Tri[], [dx, dy, dz]: P): Tri[] => tris.map((t) => t.map(([x, y, z]) => [x + dx, y + dy, z + dz]) as Tri);

  it('a box gets a box a little smaller than it', () => {
    const { fits, best } = fitOf(boxTris(80, 60, 40));
    expect(best).toBe('box');
    const [x, y, z] = (fits.box!.shape as { size: number[] }).size;
    near(x, 0.08, 0.004);
    near(y, 0.04, 0.004);
    near(z, 0.06, 0.004);
    // Its middle is the box's middle.
    fits.box!.center.forEach((v, k) => expect(v).toBeCloseTo([40, 20, -30][k], 0));
  });

  it('a can gets a tube and a ball gets a ball, each inside', () => {
    const can = fitOf(tubeTris(20, 60));
    expect(can.best).toBe('cylinder');
    expect(can.fits.cylinder!.axis).toBe(1);
    const { r, h } = can.fits.cylinder!.shape as { r: number; h: number };
    near(r, 0.02, 0.003);
    near(h, 0.06, 0.004);
    const ball = fitOf(ballTris(25));
    expect(ball.best).toBe('ball');
    near((ball.fits.ball!.shape as { r: number }).r, 0.025, 0.003);
  });

  it('leaves out what sticks out: a can with a wide thin fin is still a can', () => {
    const fin = moved(boxTris(2, 50, 80), [-1, 0, 10]);
    const { fits, best } = fitOf([...tubeTris(15, 100), ...fin]);
    expect(best).toBe('cylinder');
    const { r, h } = fits.cylinder!.shape as { r: number; h: number };
    near(r, 0.015, 0.003);
    near(h, 0.1, 0.006);
  });

  it('a thin plate gets the thinnest box a part may be', () => {
    const { fits, best } = fitOf(boxTris(100, 100, 2));
    expect(best).toBe('box');
    const [x, y, z] = (fits.box!.shape as { size: number[] }).size;
    near(x, 0.1, 0.005);
    expect(y).toBe(0.01);
    near(z, 0.1, 0.005);
  });

  it('makes a shape that would be too big smaller, so it is still inside', () => {
    const { fits } = fitOf(ballTris(100));
    expect((fits.ball!.shape as { r: number }).r).toBe(0.08);
    expect((fits.cylinder!.shape as { r: number }).r).toBeLessThanOrEqual(0.08);
  });

  it('a tube lying down is baked standing, comes out lying, and looks as it did', () => {
    const { mesh, fits, best } = fitOf(tubeTris(10, 150, 24, 'x'));
    expect(best).toBe('cylinder');
    expect(fits.cylinder!.axis).toBe(0);
    const { bytes, lying } = bakeMesh(thinMesh(mesh), 0.001, fits.cylinder!);
    expect(lying).toBe(true);
    const look = decodeMesh(bytes)!;
    // In the part's own frame the tube stands along Y, like every tube.
    const [x, y, z] = extents(look.pos);
    expect(y).toBeCloseTo(0.15, 3);
    expect(x).toBeCloseTo(0.02, 3);
    expect(z).toBeCloseTo(0.02, 3);
    // Put on lying, it lies along the car again.
    const L = rotationMatrix(LYING);
    const shown = new Float32Array(look.pos.length);
    for (let i = 0; i < shown.length; i += 3)
      for (let r = 0; r < 3; r++) shown[i + r] = L[r * 3] * look.pos[i] + L[r * 3 + 1] * look.pos[i + 1] + L[r * 3 + 2] * look.pos[i + 2];
    expect(extents(shown)[2]).toBeCloseTo(0.15, 3);
    // And made again from the part, it is the lying tube the player had.
    const again = measureMesh(unbakeMesh(look, true));
    expect(again.size[2]).toBeCloseTo(0.15, 3);
  });
});

describe('a part look as bytes', () => {
  const baked = () => {
    const mesh = readStl(binaryStl(boxTris(80, 60, 40)));
    return bakeMesh(mesh, 0.001, fitShapes(measureMesh(mesh), 0.001).box!).bytes;
  };

  it('comes back to 0.1 mm, centered, and has a name of its own', () => {
    const bytes = baked();
    const look = decodeMesh(bytes)!;
    expect(look.idx.length).toBe(36);
    // Centered on its box, which the grid it is found in puts within a cell of the middle.
    expect(Math.abs(Math.max(...look.pos) - 0.04)).toBeLessThan(0.001);
    expect(Math.abs(Math.min(...look.pos) + 0.04)).toBeLessThan(0.001);
    expect(extents(look.pos)[0]).toBeCloseTo(0.08, 4);
    expect(meshIdOf(bytes)).toMatch(/^m[0-9a-f]{16}$/);
    expect(meshIdOf(bytes)).toBe(meshIdOf(baked()));
    const other = baked();
    other[10] ^= 1;
    expect(meshIdOf(other)).not.toBe(meshIdOf(bytes));
  });

  it('is refused when broken', () => {
    const bytes = baked();
    expect(decodeMesh(bytes.subarray(0, bytes.length - 2))).toBeNull();
    const bad = bytes.slice();
    bad[bad.length - 2] = 200; // a triangle naming a vertex that is not there
    expect(decodeMesh(bad)).toBeNull();
  });
});

describe('parts with a look', () => {
  const look = 'm0123456789abcdef';
  const tube = { name: 'ロケット', shape: { kind: 'cylinder', r: 0.01, h: 0.15 }, mass: 0.03, color: '#ff0000', mesh: look, lying: false };

  it('keep their look, and lie only when they say so', () => {
    const standing = readMadePart(tube)!;
    expect(standing.mesh).toBe(look);
    expect(specOf({ kind: 'made', made: standing }).lying).toBe(false);
    const lying = readMadePart({ ...tube, lying: true })!;
    expect(specOf({ kind: 'made', made: lying }).lying).toBe(true);
    // Without a look the long tube lies, as before.
    const { mesh: _mesh, lying: _lying, ...plain } = tube;
    expect(specOf({ kind: 'made', made: readMadePart(plain)! }).lying).toBe(true);
    expect(readMadePart({ ...tube, shape: { kind: 'box', size: [0.05, 0.05, 0.05] }, lying: true })!.lying).toBe(false);
  });

  it('are refused with a look that is not named right, and travel in designs', () => {
    expect(readMadePart({ ...tube, mesh: 'x' })).toBeNull();
    expect(readMadePart({ ...tube, mesh: 42 })).toBeNull();
    const made = readMadePart(tube)!;
    // Standing on the deck (its top is at y = 0.105).
    const { design } = putPiece(emptyDesign(), { id: 'a', kind: 'made', made, x: 0, y: 0.105 + 0.075, z: 0, rot: IDENTITY, adhesive: 'hotglue' });
    expect(design).not.toBeNull();
    const again = sanitizeDesign(JSON.parse(JSON.stringify(design)));
    expect(again).toEqual(design);
    expect(again?.pieces[0].made?.mesh).toBe(look);
  });
});

describe('a box tilted against its look', () => {
  /** A bar 8 × 1 × 1 cm turned 30° around Y (up). */
  const slanted = () => {
    const mesh = readStl(binaryStl(boxTris(80, 10, 10)));
    const m = turnMatrix([0, 30, 0]);
    for (let i = 0; i < mesh.pos.length; i += 3) {
      const [x, y, z] = [mesh.pos[i], mesh.pos[i + 1], mesh.pos[i + 2]];
      for (let r = 0; r < 3; r++) mesh.pos[i + r] = m[r * 3] * x + m[r * 3 + 1] * y + m[r * 3 + 2] * z;
    }
    return mesh;
  };

  it('turns the look back, so the box is square with the part', () => {
    const mesh = slanted();
    const mid = measureMesh(mesh).mid;
    const fit = { shape: { kind: 'box' as const, size: [0.08, 0.01, 0.01] as Vec3 }, center: mid, axis: 1 as const, volume: 0 };
    const look = decodeMesh(bakeMesh(mesh, 0.001, fit, [0, 30, 0]).bytes)!;
    const [x, y, z] = extents(look.pos);
    expect(x).toBeCloseTo(0.08, 3);
    expect(y).toBeCloseTo(0.01, 3);
    expect(z).toBeCloseTo(0.01, 3);
    // Untilted, the same box would not hold it.
    expect(extents(decodeMesh(bakeMesh(mesh, 0.001, fit).bytes)!.pos)[2]).toBeGreaterThan(0.04);
    // And made again from the part, the look is slanted as it was.
    const again = measureMesh(unbakeMesh(look, false, [0, 30, 0]));
    expect(again.size[2]).toBeCloseTo(measureMesh(mesh).size[2] / 1000, 3);
  });

  it('keeps the tilt on a box with a look, in whole degrees', () => {
    const box = { name: 'ぼう', shape: { kind: 'box', size: [0.08, 0.01, 0.01] }, mass: 0.02, color: '#00ff00', mesh: 'm0123456789abcdef' };
    expect(readMadePart({ ...box, turn: [0.4, 30.2, -200] })!.turn).toEqual([0, 30, -180]);
    expect(readMadePart({ ...box, turn: [0, 0, 0] })!.turn).toBeUndefined();
    expect(readMadePart({ ...box, turn: 'x' })!.turn).toBeUndefined();
    expect(readMadePart({ ...box, shape: { kind: 'ball', r: 0.02 }, turn: [0, 30, 0] })!.turn).toBeUndefined();
    const { mesh: _mesh, ...plain } = box;
    expect(readMadePart({ ...plain, turn: [0, 30, 0] })!.turn).toBeUndefined();
  });
});
