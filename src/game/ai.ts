import { BRAKE, TABLE_HALF_X, TABLE_HALF_Z } from './constants';
import { edgeDistance, type GameEngine } from './engine';
import type { CarInput, CarState, CpuDifficulty, PlayerId, StaticObstacle } from './types';

interface CpuProfile {
  /** Seconds between decisions; the car keeps its last input in between. */
  reaction: number;
  throttle: number;
  /** Clearance to the table edge that triggers a recovery. */
  edgeMargin: number;
  /** How far ahead the current velocity is projected when checking the edge. */
  lookAhead: number;
  /** Random heading error in radians. */
  aimNoise: number;
  boostChance: number;
  /** Lines up behind the opponent so that the hit drives them towards the edge. */
  flanks: boolean;
  /** Dodges a charge when cornered. */
  evades: boolean;
  avoidsObstacles: boolean;
}

export const CPU_PROFILES: Record<CpuDifficulty, CpuProfile> = {
  easy: {
    reaction: 0.24,
    throttle: 0.62,
    edgeMargin: 0.72,
    lookAhead: 0.5,
    aimNoise: 0.4,
    boostChance: 0.05,
    flanks: false,
    evades: false,
    avoidsObstacles: false,
  },
  normal: {
    reaction: 0.13,
    throttle: 0.9,
    edgeMargin: 0.62,
    lookAhead: 0.42,
    aimNoise: 0.14,
    boostChance: 0.45,
    flanks: true,
    evades: false,
    avoidsObstacles: true,
  },
  hard: {
    reaction: 0.04,
    throttle: 1,
    edgeMargin: 0.72,
    lookAhead: 0.52,
    aimNoise: 0.03,
    boostChance: 0.95,
    flanks: true,
    evades: true,
    avoidsObstacles: true,
  },
};

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class CpuController {
  private profile: CpuProfile;
  private output: CarInput = { throttle: 0, steer: 0, boost: false };
  private timer = 0;
  private stuckTime = 0;
  private reverseTime = 0;
  private reverseSteer = 0;
  private recovering = false;
  private lastDesired = 0;

  constructor(
    difficulty: CpuDifficulty,
    private readonly self: PlayerId = 'p2',
    private readonly rng: () => number = Math.random,
  ) {
    this.profile = CPU_PROFILES[difficulty];
  }

  update(engine: GameEngine, dt: number): CarInput {
    const me = engine.cars[this.self];
    const opponent = engine.cars[this.self === 'p1' ? 'p2' : 'p1'];

    this.trackStuck(me, dt);
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = this.profile.reaction;
      this.output = this.decide(engine, me, opponent);
    }
    return this.output;
  }

  private trackStuck(me: CarState, dt: number) {
    this.reverseTime = Math.max(0, this.reverseTime - dt);
    const trying = this.output.throttle > 0.2;
    const moving = Math.hypot(me.vx, me.vz) > 0.15;
    this.stuckTime = trying && !moving && me.status === 'driving' ? this.stuckTime + dt : 0;
    if (this.stuckTime > 0.8) {
      this.stuckTime = 0;
      this.reverseTime = 0.7;
      // Reversing swings the nose the opposite way to the steering wheel, which the engine accounts for.
      this.reverseSteer = wrapAngle(this.lastDesired - me.heading) >= 0 ? 1 : -1;
    }
  }

  private decide(engine: GameEngine, me: CarState, opponent: CarState): CarInput {
    if (me.status !== 'driving') return { throttle: 0, steer: 0, boost: false };
    if (this.reverseTime > 0) return { throttle: -1, steer: this.reverseSteer, boost: false };

    const p = this.profile;
    const forwardSpeed = me.vx * Math.sin(me.heading) + me.vz * Math.cos(me.heading);
    const px = me.x + me.vx * p.lookAhead;
    const pz = me.z + me.vz * p.lookAhead;
    const clearance = edgeDistance(px, pz);

    const edgeNow = edgeDistance(me.x, me.z);
    if (this.recovering) {
      // Hysteresis: get well clear before attacking again, or the car dithers at the edge.
      if (edgeNow < p.edgeMargin + 0.4 && clearance < p.edgeMargin + 0.6) return this.recover(me, forwardSpeed);
      this.recovering = false;
    }
    // A finishing blow may run close to the edge: the hit itself stops this car.
    const committed = this.isFinishingBlow(me, opponent);
    const speed = Math.hypot(me.vx, me.vz);
    const stoppingDistance = 0.18 + (speed * speed) / (2 * BRAKE);
    if (committed ? edgeNow < stoppingDistance : clearance < p.edgeMargin || edgeNow < p.edgeMargin * 0.55) {
      this.recovering = true;
      return this.recover(me, forwardSpeed);
    }

    if (p.evades && opponent.status === 'driving' && this.shouldEvade(me, opponent)) {
      const away = Math.atan2(-me.x, -me.z);
      const side = wrapAngle(Math.atan2(opponent.x - me.x, opponent.z - me.z) - me.heading) > 0 ? -1 : 1;
      return {
        throttle: 1,
        steer: this.steerTowards(me, away + side * 0.9, forwardSpeed),
        boost: me.boost > 30,
      };
    }

    const { x: tx, z: tz, aligned } = this.pickTarget(me, opponent);
    const noise = (this.rng() - 0.5) * 2 * p.aimNoise;
    let desired = Math.atan2(tx - me.x, tz - me.z) + noise;
    this.lastDesired = desired;
    if (p.avoidsObstacles) desired += this.avoidance(engine, me, desired);

    const steer = this.steerTowards(me, desired, forwardSpeed);
    const error = Math.abs(wrapAngle(desired - me.heading));
    // Slow down for sharp turns, otherwise the drift carries the car off the table.
    const throttle = Math.min(p.throttle, error > 1.9 ? 0.6 : error > 1.1 ? 0.75 : 1);

    const dist = Math.hypot(opponent.x - me.x, opponent.z - me.z);
    const opponentEdge = edgeDistance(opponent.x, opponent.z);
    const lined = aligned && error < 0.3 && opponent.status === 'driving' && opponent.invulnerable <= 0;
    const inRange = dist < 1.5 && dist > 0.35;
    // Never boost towards the void from close by; the stopping distance would not fit.
    const myEdge = edgeDistance(me.x, me.z);
    const worthIt = myEdge > 1.15 || (myEdge > 0.75 && opponentEdge < 0.6 && dist < 0.7);
    const boost = lined && inRange && worthIt && me.boost > 20 && this.rng() < p.boostChance + (me.boosting ? 0.5 : 0);

    return { throttle, steer, boost };
  }

  private isFinishingBlow(me: CarState, opponent: CarState) {
    if (opponent.status !== 'driving' || opponent.invulnerable > 0) return false;
    const dx = opponent.x - me.x;
    const dz = opponent.z - me.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 1.9) return false;
    if (edgeDistance(opponent.x, opponent.z) >= edgeDistance(me.x, me.z)) return false;
    // The farther the charge, the straighter it has to be.
    return Math.abs(wrapAngle(Math.atan2(dx, dz) - me.heading)) < (dist < 0.9 ? 0.55 : 0.3);
  }

  private recover(me: CarState, forwardSpeed: number): CarInput {
    const toCenter = Math.atan2(-me.x, -me.z);
    const error = wrapAngle(toCenter - me.heading);
    if (Math.abs(error) < Math.PI / 2) {
      return { throttle: Math.abs(error) > 1 ? 0.6 : 1, steer: this.steerTowards(me, toCenter, forwardSpeed), boost: false };
    }
    // Nose towards the void: stop and back away while swinging the nose around.
    const speedOut = forwardSpeed > 0.4;
    return { throttle: -1, steer: speedOut ? 0 : this.steerTowards(me, toCenter, -1), boost: false };
  }

  private steerTowards(me: CarState, desired: number, forwardSpeed: number) {
    const steer = clamp(-wrapAngle(desired - me.heading) * 2.6, -1, 1);
    return forwardSpeed < -0.05 ? -steer : steer;
  }

  private shouldEvade(me: CarState, opponent: CarState) {
    if (edgeDistance(me.x, me.z) > 1.05) return false;
    const dx = me.x - opponent.x;
    const dz = me.z - opponent.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 1.3 || dist < 0.01) return false;
    const incoming = (opponent.vx * dx + opponent.vz * dz) / dist;
    return incoming > 1.6;
  }

  private pickTarget(me: CarState, opponent: CarState) {
    if (opponent.status !== 'driving') {
      // Nobody to fight: hold the middle, ideally next to the respawn marker.
      return { x: opponent.spawnX * 0.4, z: opponent.spawnZ * 0.4, aligned: false };
    }
    const lead = 0.22;
    const ox = opponent.x + opponent.vx * lead;
    const oz = opponent.z + opponent.vz * lead;
    if (!this.profile.flanks) return { x: ox, z: oz, aligned: true };

    // Push along the axis with the closest edge.
    const toX = TABLE_HALF_X - Math.abs(ox);
    const toZ = TABLE_HALF_Z - Math.abs(oz);
    const ux = toX < toZ ? Math.sign(ox) || 1 : 0;
    const uz = toX < toZ ? 0 : Math.sign(oz) || 1;
    const rx = me.x - ox;
    const rz = me.z - oz;
    const beyond = rx * ux + rz * uz;
    const dist = Math.hypot(rx, rz);

    if (beyond > -0.15) {
      // Standing between the opponent and the edge is the worst spot: swing around.
      const sideX = -uz;
      const sideZ = ux;
      const side = rx * sideX + rz * sideZ >= 0 ? 1 : -1;
      return {
        x: clamp(ox + sideX * side * 0.75 - ux * 0.45, -TABLE_HALF_X + 0.75, TABLE_HALF_X - 0.75),
        z: clamp(oz + sideZ * side * 0.75 - uz * 0.45, -TABLE_HALF_Z + 0.75, TABLE_HALF_Z - 0.75),
        aligned: false,
      };
    }
    if (dist > 1.1) {
      return {
        x: clamp(ox - ux * 0.5, -TABLE_HALF_X + 0.75, TABLE_HALF_X - 0.75),
        z: clamp(oz - uz * 0.5, -TABLE_HALF_Z + 0.75, TABLE_HALF_Z - 0.75),
        aligned: true,
      };
    }
    return { x: ox, z: oz, aligned: true };
  }

  /** Angle offset that steers around whatever is straight ahead. */
  private avoidance(engine: GameEngine, me: CarState, desired: number) {
    const fx = Math.sin(me.heading);
    const fz = Math.cos(me.heading);
    let correction = 0;
    for (const o of engine.stage.obstacles) {
      const distance = probeObstacle(o, me.x, me.z, fx, fz);
      if (distance === null) continue;
      const side = fx * (o.z - me.z) - fz * (o.x - me.x);
      // A positive heading change turns left; move away from the side the obstacle is on.
      // Head-on there is no such side, so go around on the side nearer to the goal.
      const away = Math.abs(side) < 0.15 ? wrapAngle(desired - me.heading) : side;
      const weight = 1.25 * (1 - distance / 0.95);
      correction += (away >= 0 ? 1 : -1) * weight;
    }
    return clamp(correction, -1.4, 1.4);
  }
}

function probeObstacle(o: StaticObstacle, x: number, z: number, fx: number, fz: number) {
  for (const d of [0.25, 0.45, 0.65, 0.85]) {
    const px = x + fx * d;
    const pz = z + fz * d;
    if (o.kind === 'mug') {
      if (Math.hypot(px - o.x, pz - o.z) < o.radius + 0.22) return d;
      continue;
    }
    const dx = px - o.x;
    const dz = pz - o.z;
    const c = Math.cos(o.rotation);
    const s = Math.sin(o.rotation);
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    if (Math.abs(lx) < o.halfX + 0.22 && Math.abs(lz) < o.halfZ + 0.22) return d;
  }
  return null;
}
