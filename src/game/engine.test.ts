import { beforeAll, describe, expect, it } from 'vitest';
import { CpuController } from './ai';
import { FIXED_STEP, RESPAWN_TOTAL_SECONDS, TABLE_HALF_X } from './constants';
import { GameEngine } from './engine';
import { initPhysics } from './physics';
import { STAGES } from './stages';
import type { CarInput, GameEvent, PlayerId, StagePreset } from './types';

const IDLE: CarInput = { throttle: 0, steer: 0, boost: false };

beforeAll(async () => {
  await initPhysics();
});

function startPlaying(stage: StagePreset = 'sumo', targetScore = 3) {
  const engine = new GameEngine();
  engine.startMatch({ stage, targetScore });
  run(engine, 3.05);
  expect(engine.phase).toBe('playing');
  engine.drainEvents();
  return engine;
}

type Inputs = Partial<Record<PlayerId, CarInput>>;

function run(engine: GameEngine, seconds: number, inputs: Inputs | ((i: number) => Inputs) = {}) {
  const events: GameEvent[] = [];
  const steps = Math.round(seconds / FIXED_STEP);
  for (let i = 0; i < steps; i++) {
    const current = typeof inputs === 'function' ? inputs(i) : inputs;
    engine.step(FIXED_STEP, { p1: current.p1 ?? IDLE, p2: current.p2 ?? IDLE });
    events.push(...engine.drainEvents());
  }
  return events;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** A scripted, varied input stream: driving, steering, boosting and a crash or two. */
const script = (i: number): Inputs => ({
  p1: { throttle: 1, steer: Math.sin(i / 40), boost: i % 300 < 60 },
  p2: { throttle: i % 200 < 150 ? 1 : -1, steer: Math.cos(i / 55), boost: i % 240 > 200 },
});

describe('replicated simulation', () => {
  it('is deterministic: the same inputs give bit-identical Rapier snapshots', () => {
    const a = startPlaying('standard');
    const b = startPlaying('standard');
    run(a, 4, script);
    run(b, 4, script);
    expect(sameBytes(a.physics.takeSnapshot(), b.physics.takeSnapshot())).toBe(true);
    expect(a.toState().cars).toEqual(b.toState().cars);
  });

  it('a copy restored from the Rapier snapshot continues exactly like the original', () => {
    const original = startPlaying('ramps');
    run(original, 2, script);
    const joiner = original.cloneViaSnapshot();
    expect(joiner.cars.p1.x).toBe(original.cars.p1.x);
    const later = (i: number) => script(i + 240);
    run(original, 3, later);
    run(joiner, 3, later);
    expect(sameBytes(original.physics.takeSnapshot(), joiner.physics.takeSnapshot())).toBe(true);
    expect(joiner.toState().cars).toEqual(original.toState().cars);
    expect(joiner.scores).toEqual(original.scores);
  });
});

describe('driving', () => {
  it('accelerates, respects the speed limit and turns to the correct side', () => {
    const engine = startPlaying();
    engine.placeCar('p1', { x: -2.2, z: 0, heading: Math.PI / 2 });
    run(engine, 1, { p1: { throttle: 1, steer: 0, boost: false } });
    const car = engine.cars.p1;
    const speed = Math.hypot(car.vx, car.vz);
    expect(speed).toBeGreaterThan(2);
    expect(speed).toBeLessThan(3.1);

    // Going +X, a right turn seen from above bends towards +Z (the camera side).
    const engine2 = startPlaying();
    engine2.placeCar('p1', { x: -1, z: 0, heading: Math.PI / 2 });
    run(engine2, 0.6, { p1: { throttle: 1, steer: 1, boost: false } });
    expect(engine2.cars.p1.z).toBeGreaterThan(0.05);
  });

  it('boost drains the gauge, goes faster and refills afterwards', () => {
    const engine = startPlaying();
    engine.placeCar('p1', { x: -2.2, z: 0, heading: Math.PI / 2 });
    const events = run(engine, 0.8, { p1: { throttle: 1, steer: 0, boost: true } });
    const car = engine.cars.p1;
    expect(events.some((e) => e.type === 'boost')).toBe(true);
    expect(Math.hypot(car.vx, car.vz)).toBeGreaterThan(3.2);
    const low = car.boost;
    expect(low).toBeLessThan(70);
    engine.placeCar('p1', { x: 0, vx: 0, vz: 0 });
    run(engine, 1);
    expect(engine.cars.p1.boost).toBeGreaterThan(low);
  });

  it('stays on its wheels while driving around', () => {
    const engine = startPlaying('standard');
    run(engine, 6, script);
    for (const id of ['p1', 'p2'] as PlayerId[]) {
      const car = engine.cars[id];
      if (car.status !== 'driving') continue;
      const upY = 1 - 2 * (car.qx * car.qx + car.qz * car.qz);
      expect(upY).toBeGreaterThan(0.5);
    }
  });
});

describe('sumo', () => {
  it('a boosted hit knocks the victim much harder than the hitter recoils', () => {
    const engine = startPlaying();
    engine.placeCar('p1', { x: -0.9, z: 0, heading: Math.PI / 2 });
    engine.placeCar('p2', { x: 0.2, z: 0, heading: Math.PI / 2 });
    const events: GameEvent[] = [];
    for (let i = 0; i < 300 && !events.some((e) => e.type === 'crash'); i++) {
      events.push(...run(engine, FIXED_STEP, { p1: { throttle: 1, steer: 0, boost: true } }));
    }
    run(engine, FIXED_STEP * 2, { p1: { throttle: 1, steer: 0, boost: true } });
    const { p1, p2 } = engine.cars;
    expect(events.find((e) => e.type === 'crash')).toBeDefined();
    expect(p2.vx).toBeGreaterThan(p1.vx + 2);
    expect(p2.vx).toBeGreaterThan(4);
    expect(p2.hitStun).toBeGreaterThan(0);
  });

  it('falling off scores for the opponent, respawns safely and ends with invulnerability', () => {
    const engine = startPlaying();
    engine.placeCar('p1', { x: TABLE_HALF_X - 0.05, z: 0, heading: Math.PI / 2, vx: 2 });
    const events = run(engine, 1, { p1: { throttle: 1, steer: 0, boost: false } });
    expect(events.find((e) => e.type === 'fall')).toMatchObject({ player: 'p1', scoredBy: 'p2' });
    expect(engine.scores).toEqual({ p1: 0, p2: 1 });
    expect(engine.cars.p1.status).toBe('falling');

    const later = [...events, ...run(engine, RESPAWN_TOTAL_SECONDS)];
    expect(later.some((e) => e.type === 'floor')).toBe(true);
    expect(later.some((e) => e.type === 'respawn')).toBe(true);
    const car = engine.cars.p1;
    expect(car.status).toBe('driving');
    expect(car.invulnerable).toBeGreaterThan(0);
    expect(Math.abs(car.x)).toBeLessThan(TABLE_HALF_X);
    run(engine, 0.6);
    expect(engine.cars.p1.y).toBeGreaterThan(-0.01);

    // A ghost car is not pushed around: the rival drives straight through it.
    const ghost = engine.cars.p1;
    const before = { x: ghost.x, z: ghost.z };
    engine.placeCar('p2', { x: ghost.x - 0.5, z: ghost.z, heading: Math.PI / 2, vx: 2.5, vz: 0 });
    run(engine, 0.3, { p2: { throttle: 1, steer: 0, boost: false } });
    expect(Math.hypot(engine.cars.p1.x - before.x, engine.cars.p1.z - before.z)).toBeLessThan(0.05);
  });

  it('declares a winner at the target score and only once', () => {
    const engine = startPlaying('sumo', 1);
    engine.placeCar('p2', { x: TABLE_HALF_X + 0.3, y: 0.1 });
    const events = run(engine, 3);
    expect(engine.phase).toBe('finished');
    expect(engine.winner).toBe('p1');
    expect(events.filter((e) => e.type === 'win')).toHaveLength(1);
    expect(engine.scores.p1).toBe(1);
  });

  it('free practice never ends', () => {
    const engine = startPlaying('sumo', 0);
    for (let i = 0; i < 4; i++) {
      engine.placeCar('p2', { x: TABLE_HALF_X + 0.3, y: 0.1 });
      run(engine, 5);
    }
    expect(engine.scores.p1).toBe(4);
    expect(engine.phase).toBe('playing');
  });
});

describe('stage geometry', () => {
  it('a ruler ramp launches a car into the air', () => {
    const engine = startPlaying('standard');
    const ramp = STAGES.standard.obstacles.find((o) => o.kind === 'ramp')!;
    engine.placeCar('p1', { x: ramp.x - 0.85, z: ramp.z, heading: Math.PI / 2 });
    let peak = 0;
    let airborne = 0;
    const events: GameEvent[] = [];
    for (let i = 0; i < 180; i++) {
      events.push(...run(engine, FIXED_STEP, { p1: { throttle: 1, steer: 0, boost: true } }));
      peak = Math.max(peak, engine.cars.p1.y);
      if (!engine.cars.p1.grounded) airborne += FIXED_STEP;
    }
    expect(events.some((e) => e.type === 'jump')).toBe(true);
    expect(peak).toBeGreaterThan(0.35);
    expect(airborne).toBeGreaterThan(0.25);
  });

  it('book stacks stop cars from the side but carry them from a ramp', () => {
    const engine = startPlaying('ramps');
    engine.placeCar('p1', { x: 0, z: -0.9, heading: 0 });
    run(engine, 0.8, { p1: { throttle: 1, steer: 0, boost: false } });
    expect(engine.cars.p1.z).toBeLessThan(-0.6);
    expect(engine.cars.p1.y).toBeLessThan(0.05);

    // Up the left ramp and onto the plateau.
    const engine2 = startPlaying('ramps');
    engine2.placeCar('p1', { x: -1.95, z: 0, heading: Math.PI / 2 });
    let reached = false;
    for (let i = 0; i < 240 && !reached; i++) {
      run(engine2, FIXED_STEP, { p1: { throttle: 0.75, steer: 0, boost: false } });
      reached = Math.abs(engine2.cars.p1.x) < 0.3 && engine2.cars.p1.y > 0.25;
    }
    expect(reached).toBe(true);
  });

  it('mugs bounce a car back', () => {
    const engine = startPlaying('standard');
    const mug = STAGES.standard.obstacles.find((o) => o.kind === 'mug')!;
    engine.placeCar('p1', { x: mug.x - 0.9, z: mug.z, heading: Math.PI / 2 });
    const events = run(engine, 0.8, { p1: { throttle: 1, steer: 0, boost: false } });
    expect(events.some((e) => e.type === 'bump' && e.surface === 'mug')).toBe(true);
    expect(engine.cars.p1.x).toBeLessThan(mug.x - 0.3);
  });

  it('props can be pushed off the table and come back', () => {
    const engine = startPlaying('standard');
    const index = engine.props.findIndex((p) => p.kind === 'eraser');
    engine.placeProp(index, { x: 2.33, vx: 1.5 });
    run(engine, 0.8);
    expect(engine.props[index].falling).toBe(true);
    run(engine, 3.5);
    const eraser = engine.props[index];
    expect(eraser.falling).toBe(false);
    expect(eraser.x).toBeCloseTo(eraser.home.x, 2);
  });

  it.each(['standard', 'ramps', 'sumo'] as StagePreset[])('%s: spawn points are clear of obstacles', (id) => {
    const stage = STAGES[id];
    for (const p of [stage.spawns.p1, stage.spawns.p2, ...stage.respawnPoints]) {
      const engine = startPlaying(id);
      engine.placeCar('p2', { x: 0, z: 5, y: -3 }); // Out of the way, below the table.
      engine.placeCar('p1', { x: p.x, z: p.z, y: 0.002, heading: 0, vx: 0, vz: 0 });
      run(engine, 0.3);
      const car = engine.cars.p1;
      expect(Math.hypot(car.x - p.x, car.z - p.z)).toBeLessThan(0.03);
      expect(car.y).toBeLessThan(0.02);
    }
  });
});

describe('car parts', () => {
  it('a part can break off into its own body, survive a snapshot and be rebuilt', () => {
    const engine = startPlaying('sumo');
    run(engine, 0.5, { p1: { throttle: 1, steer: 0, boost: false } });
    const spoiler = engine.physics.parts.find((p) => p.owner === 'p1' && p.partId === 'spoiler')!;
    const chassis = spoiler.bodyHandle;
    engine.physics.detachPart(spoiler.colliderHandle, { x: 0, y: 0.05, z: 0 });
    expect(spoiler.attached).toBe(false);
    expect(spoiler.bodyHandle).not.toBe(chassis);
    expect(engine.physics.info(spoiler.colliderHandle)?.kind).toBe('debris');

    const joiner = engine.cloneViaSnapshot();
    run(engine, 1, script);
    run(joiner, 1, script);
    expect(sameBytes(engine.physics.takeSnapshot(), joiner.physics.takeSnapshot())).toBe(true);
    const flying = engine.partPoses('p1').find((p) => p.partId === 'spoiler')!;
    expect(flying.attached).toBe(false);

    engine.physics.rebuildCar('p1', 0, 0.01, 0, 0);
    const parts = engine.physics.parts.filter((p) => p.owner === 'p1');
    expect(parts.every((p) => p.attached)).toBe(true);
    expect(new Set(parts.map((p) => p.bodyHandle)).size).toBe(1);
  });
});

describe('CPU', () => {
  function duel(stage: StagePreset, difficulty: 'easy' | 'normal' | 'hard', seed: number, p1Driver?: CpuController) {
    let s = seed;
    const rng = () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
    const engine = startPlaying(stage, 5);
    const cpu = new CpuController(difficulty, 'p2', rng);
    for (let t = 0; t < 90 && engine.phase === 'playing'; t += FIXED_STEP) {
      const p1 = p1Driver ? p1Driver.update(engine, FIXED_STEP) : IDLE;
      engine.step(FIXED_STEP, { p1, p2: cpu.update(engine, FIXED_STEP) });
    }
    engine.drainEvents();
    return engine;
  }

  it.each(['standard', 'ramps', 'sumo'] as StagePreset[])('hard pushes a passive car off on %s without much self-destruction', (stage) => {
    const engine = duel(stage, 'hard', 7);
    expect(engine.scores.p2).toBeGreaterThanOrEqual(1);
    expect(engine.scores.p1).toBeLessThanOrEqual(1);
  });

  it('even easy eventually scores and rarely drives itself off', () => {
    const engine = duel('sumo', 'easy', 11);
    expect(engine.scores.p2).toBeGreaterThanOrEqual(1);
    expect(engine.scores.p1).toBeLessThanOrEqual(engine.scores.p2 + 3);
  });

  it('difficulty ordering holds: hard beats easy over several matches', () => {
    let hard = 0;
    let easy = 0;
    for (const seed of [3, 5, 17, 23, 31]) {
      let s = seed * 101;
      const rng = () => {
        s = (s * 16807) % 2147483647;
        return s / 2147483647;
      };
      const engine = duel('standard', 'hard', seed, new CpuController('easy', 'p1', rng));
      hard += engine.scores.p2;
      easy += engine.scores.p1;
    }
    expect(hard).toBeGreaterThan(easy);
  });
});
