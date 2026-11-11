import { describe, expect, it } from 'vitest';
import { MARKER_DICTIONARY, MARKER_ID, loadAruco } from './marker';
import { coverFov, focalLength, pickPose, poseCandidates, type CameraPose, type Vec3 } from './markerPose';

const W = 640;
const H = 480;
const MARKER = 0.8;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

function lookAt(position: Vec3, target: Vec3): CameraPose {
  const back = unit(sub(position, target));
  const right = unit(cross([0, 1, 0], back));
  return { position, right, up: cross(back, right), back };
}

/** Draws the marker lying at the arena's origin as this camera would see it. */
function render(camera: CameraPose, code: string, cells: number, focal: number) {
  const data = new Uint8ClampedArray(W * H * 4);
  const shade = (px: number, py: number) => {
    const dx = (px - W / 2) / focal;
    const dy = (H / 2 - py) / focal;
    const dir: Vec3 = [
      camera.right[0] * dx + camera.up[0] * dy - camera.back[0],
      camera.right[1] * dx + camera.up[1] * dy - camera.back[1],
      camera.right[2] * dx + camera.up[2] * dy - camera.back[2],
    ];
    if (dir[1] >= 0) return 90;
    const t = -camera.position[1] / dir[1];
    const col = Math.floor(((camera.position[0] + dir[0] * t) / MARKER + 0.5) * cells);
    const row = Math.floor(((camera.position[2] + dir[2] * t) / MARKER + 0.5) * cells);
    // One cell of white paper around the black square, then the table.
    if (col < -1 || row < -1 || col > cells || row > cells) return 120;
    if (col < 0 || row < 0 || col >= cells || row >= cells) return 245;
    if (col === 0 || row === 0 || col === cells - 1 || row === cells - 1) return 15;
    return code[(row - 1) * (cells - 2) + (col - 1)] === '1' ? 245 : 15;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = (shade(x + 0.25, y + 0.25) + shade(x + 0.75, y + 0.25) + shade(x + 0.25, y + 0.75) + shade(x + 0.75, y + 0.75)) / 4;
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

describe('marker pose', () => {
  const views: [string, Vec3][] = [
    ['from the front edge', [0.2, 2.2, 3]],
    ['from the right side', [3.2, 2.4, -0.3]],
    ['from the far side', [-0.4, 2.6, -2.8]],
    ['from above a corner', [-1.6, 3.4, 1.4]],
  ];
  it.each(views)('recovers a camera %s', async (_name, position) => {
    const { AR, POS } = await loadAruco();
    const dictionary = new AR.Dictionary(MARKER_DICTIONARY);
    const focal = focalLength(W, H);
    const truth = lookAt(position, [0.1, 0, -0.1]);

    const markers = new AR.Detector({ dictionaryName: MARKER_DICTIONARY }).detect(
      render(truth, dictionary.codeList[MARKER_ID], dictionary.markSize, focal),
    );
    const marker = markers.find((m) => m.id === MARKER_ID);
    expect(marker).toBeDefined();

    const pose = pickPose(poseCandidates(marker!.corners, W, H, new POS.Posit(MARKER, focal)), null);
    expect(pose).not.toBeNull();
    const distance = Math.hypot(...position);
    expect(Math.hypot(...sub(pose!.position, truth.position))).toBeLessThan(distance * 0.06);
    expect(dot(pose!.right, truth.right)).toBeGreaterThan(0.99);
    expect(dot(pose!.up, truth.up)).toBeGreaterThan(0.99);
    expect(dot(pose!.back, truth.back)).toBeGreaterThan(0.99);
  });

  it('stays with the pose nearer to the last one when two fits are close', () => {
    const near = lookAt([0, 2, 3], [0, 0, 0]);
    const flipped = lookAt([0, 2, -3], [0, 0, 0]);
    const candidates = [
      { error: 1.0, pose: flipped },
      { error: 1.2, pose: near },
    ];
    expect(pickPose(candidates, null)).toBe(flipped);
    expect(pickPose(candidates, near)).toBe(near);
    expect(pickPose([{ error: 0.2, pose: flipped }, { error: 3, pose: near }], near)).toBe(flipped);
    expect(pickPose([], near)).toBeNull();
  });
});

describe('coverFov', () => {
  const focal = focalLength(1280, 720);
  it('keeps the full height when the sides are cropped', () => {
    expect(coverFov(1280, 720, 4 / 3, focal)).toBeCloseTo((2 * Math.atan(360 / focal) * 180) / Math.PI);
  });
  it('narrows when the top and bottom are cropped', () => {
    const wide = coverFov(1280, 720, 2, focal);
    expect(wide).toBeCloseTo((2 * Math.atan(320 / focal) * 180) / Math.PI);
    expect(wide).toBeLessThan(coverFov(1280, 720, 16 / 9, focal));
  });
  it('uses the long side for a portrait frame', () => {
    expect(focalLength(720, 1280)).toBe(focal);
  });
});
