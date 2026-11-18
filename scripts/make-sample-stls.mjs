/**
 * Sample STL files for trying the part maker (public/samples/): binary STL, millimeters, Z up as
 * 3D printers expect. Run from the repository root to make them again:
 *
 *   node scripts/make-sample-stls.mjs
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'public/samples';
const TAU = Math.PI * 2;

function save(name, tris) {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write(`sample ${name}`.padEnd(80, ' '), 0, 'ascii');
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => {
    const at = 84 + i * 50;
    const [a, b, c] = t;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n) || 1;
    n.forEach((x, k) => buf.writeFloatLE(x / len, at + k * 4));
    t.flat().forEach((x, k) => buf.writeFloatLE(x, at + 12 + k * 4));
  });
  writeFileSync(join(out, name), buf);
  console.log(name, tris.length, 'triangles', buf.length, 'bytes');
}

/** A closed box from `min` to `max`, faces outward. */
function box([x0, y0, z0], [x1, y1, z1]) {
  const c = (i) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  return quads.flatMap(([a, b, d, e]) => [[c(a), c(b), c(d)], [c(a), c(d), c(e)]]);
}

/** A solid turned around Z from a profile of [radius, z] points, bottom to top. */
function lathe(profile, n = 48) {
  const tris = [];
  const at = (r, z, i) => [Math.cos((i / n) * TAU) * r, Math.sin((i / n) * TAU) * r, z];
  for (let k = 0; k < profile.length - 1; k++) {
    const [r0, z0] = profile[k];
    const [r1, z1] = profile[k + 1];
    for (let i = 0; i < n; i++) {
      const a = at(r0, z0, i), b = at(r0, z0, i + 1), c = at(r1, z1, i + 1), d = at(r1, z1, i);
      if (r0 > 0) tris.push([a, b, c]);
      if (r1 > 0) tris.push([a, c, d]);
    }
  }
  const [rb, zb] = profile[0];
  const [rt, zt] = profile[profile.length - 1];
  for (let i = 0; i < n; i++) {
    if (rb > 0) tris.push([[0, 0, zb], at(rb, zb, i + 1), at(rb, zb, i)]);
    if (rt > 0) tris.push([[0, 0, zt], at(rt, zt, i), at(rt, zt, i + 1)]);
  }
  return tris;
}

/** Points turned so that Z goes along X (for things lying on the bed). */
const lieAlongX = (tris) => tris.map((t) => t.map(([x, y, z]) => [z, x, y + 0]));
const lift = (tris, dz) => tris.map((t) => t.map(([x, y, z]) => [x, y, z + dz]));

// 1. ロケット: a body tube, a nose cone and four fins, lying on its side.
{
  const r = 12;
  const body = lathe([[0, 0], [r, 0], [r, 110], [r * 0.7, 125], [r * 0.3, 140], [0, 148]]);
  const fins = [];
  for (let f = 0; f < 4; f++) {
    const a = (f * TAU) / 4;
    const fin = box([-1.2, r - 2, 0], [1.2, 30, 32]);
    fins.push(...fin.map((t) => t.map(([x, y, z]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z])));
  }
  save('rocket.stl', lift(lieAlongX([...body, ...fins]), 30));
}

// 2. ケーキフォーク: thin and bent; the fitted box is poor, so it is the one to fix by hand.
{
  const N = 60, len = 160, th = 3;
  const tris = [];
  const width = (t) => (t > 0.72 ? 16 : t > 0.62 ? 6 + ((t - 0.62) / 0.1) * 10 : 6);
  const st = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const y = t * len;
    const z = 3 + 14 * Math.sin(t * Math.PI) ** 1.5;
    const h = width(t) / 2;
    st.push([[-h, y, z - th / 2], [h, y, z - th / 2], [h, y, z + th / 2], [-h, y, z + th / 2]]);
  }
  for (let i = 0; i < N; i++)
    for (let c = 0; c < 4; c++) {
      const a = st[i][c], b = st[i][(c + 1) % 4], a2 = st[i + 1][c], b2 = st[i + 1][(c + 1) % 4];
      tris.push([a, b, b2], [a, b2, a2]);
    }
  const [s0, s1] = [st[0], st[N]];
  tris.push([s0[0], s0[2], s0[1]], [s0[0], s0[3], s0[2]], [s1[0], s1[1], s1[2]], [s1[0], s1[2], s1[3]]);
  save('cakefork.stl', tris);
}

// 3. ボール: a ball 6 cm across.
{
  const R = 30, rings = 24, segs = 40;
  const at = (i, j) => {
    const t = (i / rings) * Math.PI, p = (j / segs) * TAU;
    return [Math.sin(t) * Math.cos(p) * R, Math.sin(t) * Math.sin(p) * R, R - Math.cos(t) * R];
  };
  const tris = [];
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < segs; j++) {
      if (i > 0) tris.push([at(i, j), at(i, j + 1), at(i + 1, j)]);
      if (i < rings - 1) tris.push([at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)]);
    }
  save('ball.stl', tris);
}

// 4. あきかん: a can with a rim, standing.
save('can.stl', lathe([[0, 0], [24, 0], [26, 4], [26, 116], [24, 120], [20, 122], [0, 122]]));

// 5. チェスのポーン: round and narrow at once; a tube or a ball, depending on the size.
save('pawn.stl', lathe([[0, 0], [16, 0], [16, 5], [13, 8], [9, 12], [6, 22], [5, 30], [9, 32], [9, 34], [5, 36], [7, 39], [8.5, 43], [8, 47], [6, 50], [3, 52], [0, 52.5]], 40));

// 6. L字アングル: two plates at a right angle; only part of it fits in one box.
save('angle.stl', [...box([0, 0, 0], [80, 30, 4]), ...box([0, 0, 0], [4, 30, 50])]);
