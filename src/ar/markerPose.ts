// Camera pose from one square marker lying on the table. No DOM and no three.js here, so it can be tested.
//
// Arena coordinates are the simulation's: the table surface is y = 0 and the marker's centre is the
// origin. The printed marker's right is +x, its top is -z (away from the front edge), its face is +y.

export type Vec3 = [number, number, number];

/** A camera in arena coordinates. `right`, `up` and `back` are its local x, y and z axes. */
export interface CameraPose {
  position: Vec3;
  right: Vec3;
  up: Vec3;
  back: Vec3;
}

export interface PoseCandidate {
  /** Reprojection error in pixels. */
  error: number;
  pose: CameraPose;
}

/** The subset of js-aruco2's POS.Posit that is used here. */
export interface PositLike {
  pose(points: { x: number; y: number }[]): {
    bestError: number;
    bestRotation: number[][];
    bestTranslation: number[];
    alternativeError: number;
    alternativeRotation: number[][];
    alternativeTranslation: number[];
  };
}

/**
 * Browsers do not report a camera's lens, so this assumes the field of view of a phone's main rear
 * camera along the long side of the frame. The same value is used to estimate the pose and to draw
 * the scene, so the overlay lines up at the marker either way; an error only shows towards the edges.
 */
export const CAMERA_LONG_FOV_DEG = 63;

/** Focal length in pixels for a frame of this size. */
export function focalLength(width: number, height: number) {
  return Math.max(width, height) / 2 / Math.tan((CAMERA_LONG_FOV_DEG * Math.PI) / 360);
}

/** Vertical field of view, in degrees, of the part of the video left visible by `object-fit: cover`. */
export function coverFov(videoWidth: number, videoHeight: number, viewAspect: number, focal: number) {
  const visibleHeight = videoWidth / videoHeight > viewAspect ? videoHeight : videoWidth / viewAspect;
  return (2 * Math.atan(visibleHeight / 2 / focal) * 180) / Math.PI;
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (a: Vec3): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};
/** Marker coordinates (x right, y up the sheet, z out of it) to arena coordinates. */
const toArena = (v: Vec3): Vec3 => [v[0], v[2], -v[1]];

/**
 * POSIT gives the marker's pose as seen by the camera (x right, y up, z into the picture):
 * `rotation` maps marker coordinates to camera coordinates and `translation` is the marker's centre.
 * This turns it around into where the camera is, in arena coordinates.
 */
export function cameraFromMarker(rotation: number[][], translation: number[]): CameraPose {
  // To three.js camera coordinates, which look down -z.
  const x = normalize([rotation[0][0], rotation[1][0], -rotation[2][0]]);
  const yRaw: Vec3 = [rotation[0][1], rotation[1][1], -rotation[2][1]];
  const z = normalize(cross(x, yRaw));
  const y = cross(z, x);
  const centre: Vec3 = [translation[0], translation[1], -translation[2]];
  return {
    position: toArena([-dot(x, centre), -dot(y, centre), -dot(z, centre)]),
    right: toArena([x[0], y[0], z[0]]),
    up: toArena([x[1], y[1], z[1]]),
    back: toArena([x[2], y[2], z[2]]),
  };
}

/**
 * Both poses POSIT finds for these corners. `corners` are in image pixels, clockwise from the
 * marker's top-left, as js-aruco2's detector returns them.
 */
export function poseCandidates(corners: { x: number; y: number }[], width: number, height: number, posit: PositLike): PoseCandidate[] {
  const centred = corners.map((c) => ({ x: c.x - width / 2, y: height / 2 - c.y }));
  const found = posit.pose(centred);
  const candidates: PoseCandidate[] = [];
  const add = (error: number, rotation: number[][], translation: number[]) => {
    // POSIT reports a solution it rejected with a negative error.
    if (!(error >= 0) || !(translation[2] > 0)) return;
    const pose = cameraFromMarker(rotation, translation);
    // A camera under the table cannot see the marker.
    if (pose.position[1] > 0 && pose.position.every(Number.isFinite)) candidates.push({ error, pose });
  };
  add(found.bestError, found.bestRotation, found.bestTranslation);
  add(found.alternativeError, found.alternativeRotation, found.alternativeTranslation);
  return candidates;
}

/**
 * A square seen nearly head-on or from far away fits two tilts almost equally well, and noise makes
 * the better fit flip between them. When the fits are close, stay with the one nearer to the last pose.
 */
export function pickPose(candidates: PoseCandidate[], previous: CameraPose | null): CameraPose | null {
  if (candidates.length === 0) return null;
  const [a, b] = [...candidates].sort((p, q) => p.error - q.error);
  if (!b || !previous || b.error > a.error * 2 + 0.5) return a.pose;
  const distance = (p: CameraPose) =>
    Math.hypot(p.position[0] - previous.position[0], p.position[1] - previous.position[1], p.position[2] - previous.position[2]);
  return distance(b.pose) < distance(a.pose) ? b.pose : a.pose;
}
