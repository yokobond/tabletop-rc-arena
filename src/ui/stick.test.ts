import { describe, expect, it } from 'vitest';
import {
  STICK_BOOST_ARC_DEG,
  STICK_BOOST_OUTER,
  STICK_BOOST_REACH,
  STICK_DEAD_ZONE,
  STICK_KNOB_RING_LIMIT,
  evalStick,
} from './stick';

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Returns screen-normalized stick input at a given polar `(len, angleDeg)` where 0° is straight ahead (`-y`). */
const polar = (len: number, angleDeg: number, rotationDeg = 0) => {
  const th = rad(angleDeg);
  return evalStick(len * Math.sin(th), -len * Math.cos(th), rotationDeg);
};

describe('evalStick', () => {
  it('zeros steering and throttle inside the dead zone and does not boost', () => {
    const center = evalStick(0, 0, 0);
    expect(center).toEqual({ steer: 0, throttle: 0, boost: false, knob: { x: 0, y: 0 } });

    const edge = evalStick(STICK_DEAD_ZONE - 0.01, -(STICK_DEAD_ZONE - 0.01), 0);
    expect(edge.steer).toBe(0);
    expect(edge.throttle).toBe(0);
    expect(edge.boost).toBe(false);
  });

  it('does not boost during normal forward driving inside or near the stick ring', () => {
    for (const len of [0.85, 1.0, 1.3, STICK_BOOST_REACH - 0.01]) {
      const res = polar(len, 0);
      expect(res.boost).toBe(false);
      expect(res.steer).toBeCloseTo(0, 6);
      expect(res.throttle).toBeCloseTo(len >= 1 ? 1 : len, 6);
    }
  });

  it('boosts when pushed into the outer forward arc and clamps driving inputs to the unit circle', () => {
    for (const angleDeg of [0, STICK_BOOST_ARC_DEG - 0.01, -(STICK_BOOST_ARC_DEG - 0.01)]) {
      const res = polar(STICK_BOOST_REACH, angleDeg);
      expect(res.boost).toBe(true);
      expect(Math.hypot(res.steer, res.throttle)).toBeCloseTo(1, 6);
    }

    const straight = polar(STICK_BOOST_REACH + 0.3, 0);
    expect(straight.boost).toBe(true);
    expect(straight.throttle).toBeCloseTo(1, 6);
    expect(straight.steer).toBeCloseTo(0, 6);
  });

  it('does not boost outside the forward arc even at high reach', () => {
    for (const angleDeg of [STICK_BOOST_ARC_DEG + 1, -(STICK_BOOST_ARC_DEG + 1), 45, 90, -90, 180]) {
      const res = polar(STICK_BOOST_REACH + 0.4, angleDeg);
      expect(res.boost).toBe(false);
    }
  });

  it('rotates pad-local forward axes properly in facing layout (90deg and -90deg)', () => {
    // Player 1 rotated +90deg: pad "up" (-y) points right (+x) on screen.
    const p1Fwd = evalStick(STICK_BOOST_REACH, 0, 90);
    expect(p1Fwd.throttle).toBeCloseTo(1, 6);
    expect(p1Fwd.steer).toBeCloseTo(0, 6);
    expect(p1Fwd.boost).toBe(true);

    // Player 2 rotated -90deg: pad "up" (-y) points left (-x) on screen.
    const p2Fwd = evalStick(-STICK_BOOST_REACH, 0, -90);
    expect(p2Fwd.throttle).toBeCloseTo(1, 6);
    expect(p2Fwd.steer).toBeCloseTo(0, 6);
    expect(p2Fwd.boost).toBe(true);

    // Pushing toward screen-top on a +90deg rotated pad is actually steering left, not forward boost.
    const p1Side = evalStick(0, -STICK_BOOST_REACH, 90);
    expect(p1Side.boost).toBe(false);
    expect(p1Side.steer).toBeCloseTo(-1, 6);
    expect(p1Side.throttle).toBeCloseTo(0, 6);
  });

  it('extends knob smoothly into the forward boost zone and keeps it on the ring elsewhere', () => {
    const ringEdge = polar(1.0, 0);
    expect(Math.hypot(ringEdge.knob.x, ringEdge.knob.y)).toBeCloseTo(STICK_KNOB_RING_LIMIT, 6);

    const maxForward = polar(STICK_BOOST_OUTER + 0.5, 0);
    expect(Math.hypot(maxForward.knob.x, maxForward.knob.y)).toBeCloseTo(
      STICK_KNOB_RING_LIMIT + (STICK_BOOST_OUTER - 1),
      6,
    );

    const sideOver = polar(STICK_BOOST_OUTER, 90);
    expect(Math.hypot(sideOver.knob.x, sideOver.knob.y)).toBeCloseTo(STICK_KNOB_RING_LIMIT, 6);

    const backOver = polar(STICK_BOOST_OUTER, 180);
    expect(Math.hypot(backOver.knob.x, backOver.knob.y)).toBeCloseTo(STICK_KNOB_RING_LIMIT, 6);

    // Smooth monotonic transition between STICK_BOOST_ARC_DEG (25°) and 45°.
    const angles = [25, 28, 32, 35, 39, 43, 45];
    const dists = angles.map((deg) => {
      const { knob } = polar(STICK_BOOST_OUTER, deg);
      return Math.hypot(knob.x, knob.y);
    });
    expect(dists[0]).toBeCloseTo(STICK_KNOB_RING_LIMIT + (STICK_BOOST_OUTER - 1), 6);
    expect(dists[dists.length - 1]).toBeCloseTo(STICK_KNOB_RING_LIMIT, 6);
    for (let i = 1; i < dists.length; i++) {
      expect(dists[i]).toBeLessThan(dists[i - 1]);
    }
  });
});
