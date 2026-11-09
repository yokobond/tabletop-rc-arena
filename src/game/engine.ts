/**
 * Match rules on top of the Rapier world (`physics.ts`).
 *
 * The physics state lives only in Rapier; the car and prop objects below mirror it after
 * every step (`syncFromBodies`) so that the CPU and the views can read plain numbers.
 * A snapshot is `toState()`: rule values plus the Rapier world, restored with `fromState()`.
 */
import { CAR_PARTS, WHEEL_RADIUS } from './carParts';
import * as C from './constants';
import { GROUP, PhysicsWorld, RAPIER, type PhysicsState, type Pose, yawQuat } from './physics';
import { STAGES } from './stages';
import { CAR_RULE_KEYS, NO_INPUT } from './types';
import type { CarInput, CarState, GameEvent, MatchPhase, PlayerId, PropState, StagePreset } from './types';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const PLAYERS: PlayerId[] = ['p1', 'p2'];
const other = (id: PlayerId): PlayerId => (id === 'p1' ? 'p2' : 'p1');

export function isOverTable(x: number, z: number) {
  return Math.abs(x) <= C.TABLE_HALF_X && Math.abs(z) <= C.TABLE_HALF_Z;
}

export function edgeDistance(x: number, z: number) {
  return Math.min(C.TABLE_HALF_X - Math.abs(x), C.TABLE_HALF_Z - Math.abs(z));
}

/** Forward vector (sin heading, cos heading) of a rotation, flattened onto the table. */
function headingOf(q: { qx: number; qy: number; qz: number; qw: number }) {
  const fx = 2 * (q.qx * q.qz + q.qw * q.qy);
  const fz = 1 - 2 * (q.qx * q.qx + q.qy * q.qy);
  return Math.atan2(fx, fz);
}

const WHEEL_OFFSETS = CAR_PARTS.filter((p) => p.isWheel).map((p) => p.offset);
/** Ray length below a wheel center that still counts as touching the ground. */
const GROUND_PROBE = WHEEL_RADIUS + 0.035;

export interface MatchOptions {
  stage: StagePreset;
  /** 0 means free practice. */
  targetScore: number;
}

export interface EngineState {
  phase: MatchPhase;
  stageId: StagePreset;
  targetScore: number;
  scores: Record<PlayerId, number>;
  winner: PlayerId | null;
  countdown: number;
  finishTimer: number;
  crashCooldown: number;
  lastCountdownValue: number;
  cars: Record<PlayerId, Partial<CarState>>;
  props: { falling: boolean; respawnTimer: number }[];
  physics: PhysicsState;
}

export interface EngineSnapshot {
  world: RAPIER.World;
  rules: string;
}

/** JSON that keeps -0 (plain JSON turns it into 0, which could change later float results). */
function encodeExact(value: unknown) {
  return JSON.stringify(value, (_k, v) => (typeof v === 'number' && Object.is(v, -0) ? '\u0000-0' : v));
}
function decodeExact(text: string): unknown {
  return JSON.parse(text, (_k, v) => (v === '\u0000-0' ? -0 : v));
}

export class GameEngine {
  phase: MatchPhase = 'idle';
  stageId: StagePreset = 'standard';
  targetScore = 3;
  scores: Record<PlayerId, number> = { p1: 0, p2: 0 };
  winner: PlayerId | null = null;
  countdown = 0;
  cars: Record<PlayerId, CarState>;
  props: PropState[] = [];
  physics: PhysicsWorld;

  private events: GameEvent[] = [];
  private finishTimer = 0;
  private crashCooldown = 0;
  private lastCountdownValue = 0;
  /** Horizontal velocity each car had going into the current step (for hit strength). */
  private preVel: Record<PlayerId, { x: number; y: number; z: number }> = { p1: { x: 0, y: 0, z: 0 }, p2: { x: 0, y: 0, z: 0 } };

  constructor() {
    this.physics = PhysicsWorld.create(this.stage);
    this.cars = { p1: this.createCar('p1'), p2: this.createCar('p2') };
    this.props = this.stage.props.map((home) => this.createProp(home));
    this.syncFromBodies();
  }

  get stage() {
    return STAGES[this.stageId];
  }

  // -------------------------------------------------------------------------
  // Snapshots.
  // -------------------------------------------------------------------------
  toState(): EngineState {
    const rules = (car: CarState) =>
      Object.fromEntries(CAR_RULE_KEYS.map((k) => [k, car[k]])) as Partial<CarState>;
    return {
      phase: this.phase,
      stageId: this.stageId,
      targetScore: this.targetScore,
      scores: { ...this.scores },
      winner: this.winner,
      countdown: this.countdown,
      finishTimer: this.finishTimer,
      crashCooldown: this.crashCooldown,
      lastCountdownValue: this.lastCountdownValue,
      cars: { p1: rules(this.cars.p1), p2: rules(this.cars.p2) },
      props: this.props.map((p) => ({ falling: p.falling, respawnTimer: p.respawnTimer })),
      physics: this.physics.toState(),
    };
  }

  static fromState(state: EngineState) {
    const engine = Object.create(GameEngine.prototype) as GameEngine;
    engine.events = [];
    engine.preVel = { p1: { x: 0, y: 0, z: 0 }, p2: { x: 0, y: 0, z: 0 } };
    engine.phase = state.phase;
    engine.stageId = state.stageId;
    engine.targetScore = state.targetScore;
    engine.scores = { ...state.scores };
    engine.winner = state.winner;
    engine.countdown = state.countdown;
    engine.finishTimer = state.finishTimer;
    engine.crashCooldown = state.crashCooldown;
    engine.lastCountdownValue = state.lastCountdownValue;
    engine.physics = PhysicsWorld.fromState(state.physics);
    engine.cars = {
      p1: { ...engine.createCar('p1'), ...state.cars.p1 },
      p2: { ...engine.createCar('p2'), ...state.cars.p2 },
    };
    engine.props = engine.stage.props.map((home, i) => ({ ...engine.createProp(home), ...state.props[i] }));
    engine.syncFromBodies();
    return engine;
  }

  /**
   * The snapshot form: the Rapier world (stored by its own `takeSnapshot()`) next to one JSON
   * string with the rule values and the body/collider handles. Both are flat on purpose, so a
   * reader gets them complete in one go (Croquet fills nested objects in later).
   */
  toSnapshot(): EngineSnapshot {
    const { physics, ...rules } = this.toState();
    const { world, ...handles } = physics;
    return { world, rules: encodeExact({ rules, handles }) };
  }

  static fromSnapshot(snapshot: EngineSnapshot) {
    const { rules, handles } = decodeExact(snapshot.rules) as {
      rules: Omit<EngineState, 'physics'>;
      handles: Omit<PhysicsState, 'world'>;
    };
    return GameEngine.fromState({ ...rules, physics: { ...handles, world: snapshot.world } });
  }

  /** A copy made the way a late joiner gets it: rule JSON plus Rapier's snapshot bytes. */
  cloneViaSnapshot() {
    const { world, rules } = this.toSnapshot();
    return GameEngine.fromSnapshot({ rules, world: RAPIER.World.restoreSnapshot(world.takeSnapshot()) });
  }

  // -------------------------------------------------------------------------
  // Match flow.
  // -------------------------------------------------------------------------
  /** Lays out a stage without starting a match. */
  loadStage(stage: StagePreset) {
    this.physics?.free();
    this.stageId = stage;
    this.physics = PhysicsWorld.create(this.stage);
    this.cars = { p1: this.createCar('p1'), p2: this.createCar('p2') };
    this.props = this.stage.props.map((home) => this.createProp(home));
    this.phase = 'idle';
    this.scores = { p1: 0, p2: 0 };
    this.winner = null;
    this.events = [];
    this.syncFromBodies();
  }

  startMatch(options: MatchOptions) {
    this.loadStage(options.stage);
    this.targetScore = options.targetScore;
    this.phase = 'countdown';
    this.countdown = C.COUNTDOWN_SECONDS;
    this.lastCountdownValue = C.COUNTDOWN_SECONDS + 1;
    this.finishTimer = 0;
  }

  drainEvents() {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  step(dt: number, inputs: Record<PlayerId, CarInput>) {
    if (this.phase === 'idle') return;
    this.crashCooldown = Math.max(0, this.crashCooldown - dt);

    if (this.phase === 'countdown') {
      this.countdown -= dt;
      const value = Math.ceil(this.countdown);
      if (value !== this.lastCountdownValue && value > 0) {
        this.lastCountdownValue = value;
        this.events.push({ type: 'countdown', value });
      }
      if (this.countdown <= 0) {
        this.phase = 'playing';
        this.events.push({ type: 'go' });
      }
    }

    const canDrive = this.phase === 'playing' || this.phase === 'finishing';
    for (const id of PLAYERS) this.beforeStep(this.cars[id], canDrive ? inputs[id] : NO_INPUT, dt);

    this.physics.step(
      (h1, h2, started) => started && this.onContact(h1, h2),
      (h1, h2, force) => this.onPartForce(h1, h2, force, dt),
    );

    this.syncFromBodies();
    for (const id of PLAYERS) this.afterStep(this.cars[id], dt);
    for (let i = 0; i < this.props.length; i++) this.updateProp(i, dt);

    if (this.phase === 'finishing') {
      this.finishTimer -= dt;
      if (this.finishTimer <= 0) {
        this.phase = 'finished';
        if (this.winner) this.events.push({ type: 'win', player: this.winner });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Mirrors of the rigid bodies.
  // -------------------------------------------------------------------------
  private createCar(id: PlayerId): CarState {
    const spawn = this.stage.spawns[id];
    const q = yawQuat(spawn.heading);
    return {
      id,
      x: spawn.x,
      y: 0,
      z: spawn.z,
      vx: 0,
      vy: 0,
      vz: 0,
      heading: spawn.heading,
      pitch: 0,
      roll: 0,
      steer: 0,
      boost: 100,
      boosting: false,
      grounded: true,
      status: 'driving',
      stateTimer: 0,
      respawnIn: 0,
      invulnerable: 0,
      hitStun: 0,
      wheelSpin: 0,
      spawnX: spawn.x,
      spawnZ: spawn.z,
      airTime: 0,
      flipTime: 0,
      qx: q.x,
      qy: q.y,
      qz: q.z,
      qw: q.w,
    };
  }

  private createProp(home: PropState['home']): PropState {
    const q = yawQuat(home.angle);
    return { ...home, y: 0, vx: 0, vy: 0, vz: 0, qx: q.x, qy: q.y, qz: q.z, qw: q.w, falling: false, respawnTimer: 0, home };
  }

  /** Copies poses and velocities out of Rapier. Call after a step or a restore. */
  syncFromBodies() {
    for (const id of PLAYERS) {
      const body = this.physics.carBody(id);
      if (!body) continue;
      const car = this.cars[id];
      Object.assign(car, PhysicsWorld.poseOf(body));
      const v = body.linvel();
      car.vx = v.x;
      car.vy = v.y;
      car.vz = v.z;
      car.heading = headingOf(car);
      // Nose-down pitch and right-down roll, for anyone who wants Euler angles.
      const fy = 2 * (car.qy * car.qz - car.qw * car.qx);
      const ry = 2 * (car.qx * car.qy + car.qw * car.qz);
      car.pitch = Math.asin(clamp(-fy, -1, 1));
      car.roll = Math.asin(clamp(ry, -1, 1));
    }
    this.props.forEach((p, i) => {
      const body = this.physics.propBody(i);
      if (!body) return;
      Object.assign(p, PhysicsWorld.poseOf(body));
      const v = body.linvel();
      p.vx = v.x;
      p.vy = v.y;
      p.vz = v.z;
      // The long axis is local +X; angle is its direction on the table (matches rotation.y).
      const ax = 1 - 2 * (p.qy * p.qy + p.qz * p.qz);
      const az = 2 * (p.qx * p.qz - p.qw * p.qy);
      p.angle = Math.atan2(-az, ax);
    });
  }

  /** Puts a car somewhere (tests, tools). Physics stays authoritative. */
  placeCar(id: PlayerId, at: { x?: number; y?: number; z?: number; heading?: number; vx?: number; vy?: number; vz?: number }) {
    const car = this.cars[id];
    const body = this.physics.carBody(id);
    body.setTranslation({ x: at.x ?? car.x, y: at.y ?? car.y, z: at.z ?? car.z }, true);
    if (at.heading !== undefined) {
      body.setRotation(yawQuat(at.heading), true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    body.setLinvel({ x: at.vx ?? car.vx, y: at.vy ?? car.vy, z: at.vz ?? car.vz }, true);
    this.syncFromBodies();
  }

  placeProp(index: number, at: { x?: number; y?: number; z?: number; vx?: number; vz?: number }) {
    const p = this.props[index];
    const body = this.physics.propBody(index);
    body.setTranslation({ x: at.x ?? p.x, y: at.y ?? p.y, z: at.z ?? p.z }, true);
    body.setLinvel({ x: at.vx ?? p.vx, y: p.vy, z: at.vz ?? p.vz }, true);
    this.syncFromBodies();
  }

  // -------------------------------------------------------------------------
  // Cars.
  // -------------------------------------------------------------------------
  private beforeStep(car: CarState, input: CarInput, dt: number) {
    const body = this.physics.carBody(car.id);
    this.preVel[car.id] = { x: car.vx, y: car.vy, z: car.vz };
    if (car.status === 'falling') return;
    if (car.status === 'respawning') {
      // Hover in place, facing the opponent.
      const rival = this.cars[other(car.id)];
      car.stateTimer -= dt;
      car.respawnIn = Math.max(0, car.stateTimer);
      body.setTranslation({ x: car.spawnX, y: C.RESPAWN_HOVER_Y, z: car.spawnZ }, true);
      body.setRotation(yawQuat(Math.atan2(rival.x - car.spawnX, rival.z - car.spawnZ)), true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      if (car.stateTimer <= 0) {
        car.status = 'driving';
        car.respawnIn = 0;
        car.invulnerable = C.INVULNERABLE_SECONDS;
        car.hitStun = 0;
        car.grounded = false;
        body.setGravityScale(1, true);
        body.setLinvel({ x: 0, y: -0.5, z: 0 }, true);
      }
      return;
    }

    if (car.invulnerable > 0) {
      car.invulnerable = Math.max(0, car.invulnerable - dt);
      if (car.invulnerable === 0) this.physics.setCarFilter(car.id, GROUP.ALL);
    }
    car.hitStun = Math.max(0, car.hitStun - dt);
    this.updateBoost(car, input, dt);
    body.setAdditionalMass(car.boosting ? C.BOOST_MASS - 1 : 0, true);

    car.steer += (input.steer - car.steer) * Math.min(1, C.STEER_RESPONSE * dt);
    car.grounded = this.isGrounded(car, body);
    if (!car.grounded) return;

    const stunned = car.hitStun > 0;
    const control = stunned ? 0.25 : 1;
    const fx = Math.sin(car.heading);
    const fz = Math.cos(car.heading);
    let forward = car.vx * fx + car.vz * fz;
    let lateral = car.vx * fz - car.vz * fx;

    const throttle = input.throttle * control;
    const boosting = car.boosting;
    const limit = boosting ? C.MAX_BOOST_SPEED : C.MAX_SPEED;
    if (boosting) {
      if (forward < limit) forward += C.BOOST_ACCELERATION * Math.max(throttle, 0.6) * control * dt;
    } else if (throttle > 0) {
      if (forward < 0) forward += C.BRAKE * throttle * dt;
      else if (forward < limit) forward += C.ACCELERATION * throttle * dt;
    } else if (throttle < 0) {
      if (forward > 0) forward += C.BRAKE * throttle * dt;
      else if (forward > -C.MAX_REVERSE_SPEED) forward += C.ACCELERATION * 0.7 * throttle * dt;
    }
    // Speed above the current limit (a knockback, a finished boost) bleeds off faster.
    const drag = Math.abs(forward) > limit ? C.OVERSPEED_DRAG : throttle === 0 && !boosting ? C.COAST_DRAG : C.ROLLING_DRAG;
    forward *= Math.exp(-drag * dt);
    const grip = stunned ? C.STUN_GRIP : boosting ? C.BOOST_GRIP : C.GRIP;
    lateral *= Math.exp(-grip * dt);

    const speedFactor = clamp(Math.abs(forward) / 1.6, 0, 1);
    const pivot = input.throttle !== 0 || boosting ? 0.28 : 0;
    const direction = forward < -0.05 ? -1 : 1;
    const yawRate = -car.steer * C.STEER_RATE * Math.max(speedFactor, pivot) * direction * (stunned ? 0.6 : 1);

    // The wheels carry the velocity round with the nose, like the arcade model always did.
    const h = car.heading + yawRate * dt;
    const nfx = Math.sin(h);
    const nfz = Math.cos(h);
    const v = body.linvel();
    body.setLinvel({ x: nfx * forward + nfz * lateral, y: v.y, z: nfz * forward - nfx * lateral }, true);
    const w = body.angvel();
    body.setAngvel({ x: w.x, y: yawRate, z: w.z }, true);
    car.wheelSpin += (forward / 0.055) * dt;
  }

  /** At least two wheels close to something solid underneath. */
  private isGrounded(car: CarState, body: ReturnType<PhysicsWorld['carBody']>) {
    const r = body.rotation();
    let hits = 0;
    for (const [ox, oy, oz] of WHEEL_OFFSETS) {
      // Rotate the wheel offset by the body rotation.
      const ix = r.w * ox + r.y * oz - r.z * oy;
      const iy = r.w * oy + r.z * ox - r.x * oz;
      const iz = r.w * oz + r.x * oy - r.y * ox;
      const iw = -r.x * ox - r.y * oy - r.z * oz;
      const wx = ix * r.w + iw * -r.x + iy * -r.z - iz * -r.y;
      const wy = iy * r.w + iw * -r.y + iz * -r.x - ix * -r.z;
      const wz = iz * r.w + iw * -r.z + ix * -r.y - iy * -r.x;
      const toi = this.physics.castDown(car.x + wx, car.y + wy, car.z + wz, GROUND_PROBE, body);
      if (toi !== null) hits++;
    }
    return hits >= 2;
  }

  private updateBoost(car: CarState, input: CarInput, dt: number) {
    const wants = input.boost && input.throttle >= 0;
    if (wants && !car.boosting && car.boost >= C.BOOST_RESTART) {
      car.boosting = true;
      this.events.push({ type: 'boost', player: car.id });
    }
    if (car.boosting) {
      car.boost -= C.BOOST_DRAIN * dt;
      if (!wants || car.boost <= 0) {
        car.boosting = false;
        car.boost = Math.max(0, car.boost);
      }
    } else {
      car.boost = Math.min(100, car.boost + C.BOOST_REGEN * dt);
    }
  }

  private afterStep(car: CarState, dt: number) {
    if (car.status === 'falling') return this.updateFallingCar(car, dt);
    if (car.status !== 'driving') return;

    // Airtime, jumps and landings.
    const wasAir = car.airTime;
    if (car.grounded) {
      if (wasAir > 0.12 && -car.vy > 0.7) {
        this.events.push({ type: 'land', player: car.id, x: car.x, y: car.y, z: car.z, strength: -car.vy });
      }
      car.airTime = 0;
    } else {
      if (wasAir === 0 && car.vy > 0.6 && car.y > 0.02) this.events.push({ type: 'jump', player: car.id });
      car.airTime += dt;
    }

    // Stuck on its side or roof on the table: set it back on its wheels.
    const upY = 1 - 2 * (car.qx * car.qx + car.qz * car.qz);
    const resting = Math.hypot(car.vx, car.vy, car.vz) < 0.4;
    car.flipTime = upY < 0.5 && resting && isOverTable(car.x, car.z) ? car.flipTime + dt : 0;
    if (car.flipTime > 0.7) {
      car.flipTime = 0;
      const body = this.physics.carBody(car.id);
      body.setTranslation({ x: car.x, y: Math.max(car.y, 0) + 0.12, z: car.z }, true);
      body.setRotation(yawQuat(car.heading), true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }

    this.checkFall(car);
  }

  private checkFall(car: CarState) {
    if (car.y >= C.FALL_SCORE_Y || isOverTable(car.x, car.z)) return;
    car.status = 'falling';
    car.grounded = false;
    car.boosting = false;
    car.stateTimer = C.FALL_SECONDS;
    car.respawnIn = C.RESPAWN_TOTAL_SECONDS;
    const body = this.physics.carBody(car.id);
    body.setAdditionalMass(0, true);
    // Topple away from the table: a spin around the edge it went over.
    const outX = Math.max(0, Math.abs(car.x) - C.TABLE_HALF_X) * Math.sign(car.x);
    const outZ = Math.max(0, Math.abs(car.z) - C.TABLE_HALF_Z) * Math.sign(car.z);
    const len = Math.hypot(outX, outZ) || 1;
    const w = body.angvel();
    body.setAngvel({ x: w.x + (outZ / len) * 5, y: w.y, z: w.z - (outX / len) * 5 }, true);

    const opponent = other(car.id);
    const scores = this.phase === 'playing';
    if (scores) this.scores[opponent] += 1;
    this.events.push({ type: 'fall', player: car.id, x: car.x, y: 0, z: car.z, scoredBy: scores ? opponent : null });

    if (scores && this.targetScore > 0 && this.scores[opponent] >= this.targetScore) {
      this.winner = opponent;
      this.phase = 'finishing';
      this.finishTimer = C.FINISH_DELAY_SECONDS;
    }
  }

  private updateFallingCar(car: CarState, dt: number) {
    car.stateTimer -= dt;
    car.respawnIn = Math.max(0, car.respawnIn - dt);
    if (car.stateTimer > 0 || this.phase === 'finished' || this.phase === 'finishing') return;
    const spot = this.pickRespawnPoint(car);
    const rival = this.cars[other(car.id)];
    const heading = Math.atan2(rival.x - spot.x, rival.z - spot.z);
    const body = this.physics.rebuildCar(car.id, spot.x, C.RESPAWN_HOVER_Y, spot.z, heading);
    body.setGravityScale(0, true);
    this.physics.setCarFilter(car.id, GROUP.ALL & ~(car.id === 'p1' ? GROUP.P2 : GROUP.P1));
    car.status = 'respawning';
    car.stateTimer = C.RESPAWN_HOVER_SECONDS;
    car.spawnX = spot.x;
    car.spawnZ = spot.z;
    car.steer = 0;
    car.airTime = 0;
    car.boost = Math.max(car.boost, 45);
    this.events.push({ type: 'respawn', player: car.id });
    this.syncFromBodies();
  }

  /** The candidate farthest from the opponent that no prop is lying on. */
  private pickRespawnPoint(car: CarState) {
    const rival = this.cars[other(car.id)];
    let best = this.stage.respawnPoints[0];
    let bestScore = -Infinity;
    for (const p of this.stage.respawnPoints) {
      let score = Math.hypot(p.x - rival.x, p.z - rival.z);
      for (const prop of this.props) {
        if (Math.hypot(p.x - prop.x, p.z - prop.z) < 0.35) score -= 1;
      }
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Contacts: Rapier resolves them, the rules add the arcade on top.
  // -------------------------------------------------------------------------
  private onContact(h1: number, h2: number) {
    const a = this.physics.info(h1);
    const b = this.physics.info(h2);
    if (!a || !b) return;
    if (a.kind === 'car' && b.kind === 'car' && a.owner && b.owner && a.owner !== b.owner) {
      return this.carHit(a.owner === 'p1' ? this.cars.p1 : this.cars.p2, a.owner === 'p1' ? this.cars.p2 : this.cars.p1);
    }
    const [carInfo, otherInfo] = a.kind === 'car' ? [a, b] : b.kind === 'car' ? [b, a] : [null, null];
    if (!carInfo?.owner || !otherInfo) return;
    const car = this.cars[carInfo.owner];
    if (otherInfo.kind === 'floor') {
      if (car.status === 'falling' && this.preVel[car.id].y < -1) this.events.push({ type: 'floor', x: car.x, y: car.y, z: car.z });
      return;
    }
    if (car.status !== 'driving') return;
    if (otherInfo.kind === 'mug') return this.mugHit(car);
    if (otherInfo.kind === 'books') {
      const pre = this.preVel[car.id];
      const strength = Math.hypot(pre.x, pre.z);
      if (strength > 0.5) {
        car.hitStun = Math.max(car.hitStun, 0.08);
        this.events.push({ type: 'bump', x: car.x, y: car.y + 0.08, z: car.z, strength, surface: 'books' });
      }
      return;
    }
    if (otherInfo.kind === 'prop' && otherInfo.prop !== undefined) {
      const p = this.props[otherInfo.prop];
      const pre = this.preVel[car.id];
      const strength = Math.hypot(pre.x - p.vx, pre.z - p.vz);
      if (strength > 0.7) this.events.push({ type: 'bump', x: p.x, y: 0.06, z: p.z, strength: strength * 0.5, surface: 'prop' });
    }
  }

  private mugHit(car: CarState) {
    const mug = this.stage.obstacles
      .filter((o) => o.kind === 'mug')
      .reduce((best, o) => (Math.hypot(o.x - car.x, o.z - car.z) < Math.hypot(best.x - car.x, best.z - car.z) ? o : best));
    const dx = car.x - mug.x;
    const dz = car.z - mug.z;
    const d = Math.hypot(dx, dz) || 1;
    const nx = dx / d;
    const nz = dz / d;
    const pre = this.preVel[car.id];
    const vn = pre.x * nx + pre.z * nz;
    if (vn >= -0.2) return;
    // A bumper: bounce back harder than the wood would.
    const kick = Math.min(1.1, -vn * 0.35 + 0.2);
    const body = this.physics.carBody(car.id);
    const v = body.linvel();
    body.setLinvel({ x: v.x + nx * kick, y: v.y, z: v.z + nz * kick }, true);
    if (-vn > 0.5) {
      car.hitStun = Math.max(car.hitStun, 0.16);
      this.events.push({
        type: 'bump',
        x: car.x - nx * C.CAR_RADIUS,
        y: car.y + 0.08,
        z: car.z - nz * C.CAR_RADIUS,
        strength: -vn,
        surface: 'mug',
      });
    }
  }

  private carHit(a: CarState, b: CarState) {
    if (a.status !== 'driving' || b.status !== 'driving') return;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    const nx = dist > 1e-5 ? dx / dist : 1;
    const nz = dist > 1e-5 ? dz / dist : 0;
    const va = this.preVel[a.id];
    const vb = this.preVel[b.id];
    const closingA = va.x * nx + va.z * nz;
    const closingB = -(vb.x * nx + vb.z * nz);
    const closing = closingA + closingB;
    if (closing <= 0.05) return;

    // The arcade part: whoever came in harder sends the other one flying.
    const aIsHitter = closingA >= closingB;
    const hitter = aIsHitter ? a : b;
    const victim = aIsHitter ? b : a;
    const sign = aIsHitter ? 1 : -1;
    const extra = closing * C.KNOCKBACK_FACTOR * 2 + (hitter.boosting ? C.BOOST_KNOCKBACK * 1.6 : 0);
    const body = this.physics.carBody(victim.id);
    const v = body.linvel();
    let vx = v.x + nx * sign * extra;
    let vz = v.z + nz * sign * extra;
    const speed = Math.hypot(vx, vz);
    if (speed > C.MAX_VELOCITY) {
      vx *= C.MAX_VELOCITY / speed;
      vz *= C.MAX_VELOCITY / speed;
    }
    body.setLinvel({ x: vx, y: v.y, z: vz }, true);
    victim.hitStun = Math.max(victim.hitStun, 0.18 + Math.min(0.32, closing * 0.07));
    hitter.hitStun = Math.max(hitter.hitStun, 0.06);

    if (closing > 0.5 && this.crashCooldown <= 0) {
      this.crashCooldown = 0.12;
      this.events.push({
        type: 'crash',
        x: a.x + nx * C.CAR_RADIUS,
        y: Math.max(a.y, b.y) + 0.09,
        z: a.z + nz * C.CAR_RADIUS,
        strength: closing,
        boosted: hitter.boosting,
      });
    }
    this.syncFromBodies();
  }

  /** Contact forces on car parts: the hook for parts breaking off. */
  private onPartForce(h1: number, h2: number, force: number, dt: number) {
    for (const handle of [h1, h2]) {
      const entry = this.physics.partEntry(handle);
      if (!entry?.attached) continue;
      if (force * dt > this.physics.partSpec(entry.partId).breakImpulse) this.physics.detachPart(handle);
    }
  }

  // -------------------------------------------------------------------------
  // Props.
  // -------------------------------------------------------------------------
  private updateProp(index: number, dt: number) {
    const p = this.props[index];
    if (!p.falling) {
      if (!isOverTable(p.x, p.z) && p.y < -0.05) {
        p.falling = true;
        p.respawnTimer = C.PROP_RESPAWN_SECONDS;
      }
      return;
    }
    p.respawnTimer -= dt;
    if (p.respawnTimer > 0) return;
    const clear = PLAYERS.every((id) => Math.hypot(this.cars[id].x - p.home.x, this.cars[id].z - p.home.z) > 0.7);
    if (!clear) return;
    const body = this.physics.propBody(index);
    body.setTranslation({ x: p.home.x, y: 0.001, z: p.home.z }, true);
    body.setRotation(yawQuat(p.home.angle), true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    p.falling = false;
    this.syncFromBodies();
  }

  /** Poses of every car part, attached or not (for the views). */
  partPoses(owner: PlayerId): { partId: string; attached: boolean; pose: Pose }[] {
    const out: { partId: string; attached: boolean; pose: Pose }[] = [];
    for (const entry of this.physics.parts) {
      if (entry.owner !== owner) continue;
      const pose = this.physics.partPose(entry);
      if (pose) out.push({ partId: entry.partId, attached: entry.attached, pose });
    }
    return out;
  }
}
