export const STICK_DEAD_ZONE = 0.14;
/** Pushing the stick this far past the ring edge, within STICK_BOOST_ARC of straight ahead, boosts. */
export const STICK_BOOST_REACH = 1.55;
/** Outer visual edge of the boost zone, in units of the stick ring radius. */
export const STICK_BOOST_OUTER = 1.9;
export const STICK_BOOST_ARC_DEG = 25;
export const STICK_BOOST_ARC = (STICK_BOOST_ARC_DEG * Math.PI) / 180;
/** Angular transition band past STICK_BOOST_ARC where knob over-travel eases back to the ring edge. */
export const STICK_PULL_BLEND = (20 * Math.PI) / 180;
/** Knob center offset (in stick ring radii) when the input reaches the ring edge (`len = 1`). */
export const STICK_KNOB_RING_LIMIT = 0.54;

export interface StickEval {
  steer: number;
  throttle: number;
  boost: boolean;
  knob: { x: number; y: number };
}

/**
 * Evaluates raw stick pointer coordinates (normalized by stick ring radius, screen axes)
 * into driving inputs, boost state, and visual knob offset (in stick ring radii).
 */
export function evalStick(sx: number, sy: number, rotationDeg: number): StickEval {
  // A turned pad (facing layout) has its own "up": undo the CSS rotation to get pad-local axes.
  const a = (rotationDeg * Math.PI) / 180;
  const rx = sx * Math.cos(a) + sy * Math.sin(a);
  const ry = -sx * Math.sin(a) + sy * Math.cos(a);
  const len = Math.hypot(rx, ry);

  const cx = len > 1 ? rx / len : rx;
  const cy = len > 1 ? ry / len : ry;
  const steer = Math.abs(cx) < STICK_DEAD_ZONE ? 0 : cx;
  const throttle = Math.abs(cy) < STICK_DEAD_ZONE ? 0 : -cy;

  // Forward is -y in pad-local axes.
  const angle = len > 0 ? Math.abs(Math.atan2(rx, -ry)) : Math.PI;
  const boost = len >= STICK_BOOST_REACH && angle <= STICK_BOOST_ARC;

  if (len === 0) {
    return { steer, throttle, boost, knob: { x: 0, y: 0 } };
  }

  let dist: number;
  if (len <= 1) {
    dist = len * STICK_KNOB_RING_LIMIT;
  } else {
    const t = Math.max(0, Math.min(1, 1 - (angle - STICK_BOOST_ARC) / STICK_PULL_BLEND));
    const pull = t * t * (3 - 2 * t);
    const over = Math.min(len - 1, STICK_BOOST_OUTER - 1);
    dist = STICK_KNOB_RING_LIMIT + over * pull;
  }

  return {
    steer,
    throttle,
    boost,
    knob: { x: (rx / len) * dist, y: (ry / len) * dist },
  };
}
