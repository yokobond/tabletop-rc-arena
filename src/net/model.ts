/**
 * The replicated model. Every participant runs this bit-identically: the reflector only
 * timestamps and forwards the view events (inputs, start, pause, ...), and the model's own
 * `future()` loop drives the Rapier world. Late joiners get a Croquet snapshot, in which the
 * Rapier world is stored as `world.takeSnapshot()` bytes (the Microverse PhysicsManager way).
 */
import * as Croquet from '@croquet/croquet';
import { CpuController } from '../game/ai';
import { FIXED_STEP } from '../game/constants';
import { GameEngine, type EngineSnapshot } from '../game/engine';
import { RAPIER } from '../game/physics';
import type { CarInput, CpuDifficulty, PlayerId, StagePreset } from '../game/types';
import { NO_INPUT } from '../game/types';

export const SCOPE = 'sumo';
/** One model tick per reflector tick (tps 60); each covers two fixed physics steps. */
const TICK_MS = 1000 / 60;
const STEPS_PER_TICK = Math.round(TICK_MS / 1000 / FIXED_STEP);
const PLAYERS: PlayerId[] = ['p1', 'p2'];

export interface OnlineRules {
  stagePreset: StagePreset;
  targetScore: number;
  cpuDifficulty: CpuDifficulty;
}

export interface InputMessage extends CarInput {
  viewId: string;
}

const clampAxis = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);

export class SumoModel extends Croquet.Model {
  // `declare` keeps TypeScript from emitting field initialisers: Croquet models use init().
  declare engine: GameEngine;
  declare rules: OnlineRules;
  declare seats: Record<PlayerId, string | null>;
  declare inputs: Record<PlayerId, CarInput>;
  declare cpus: Record<PlayerId, CpuController>;
  declare viewers: string[];
  declare paused: boolean;

  static types() {
    return {
      // Microverse style: the physics world is snapshotted by Rapier itself.
      'RAPIER.World': {
        cls: RAPIER.World,
        write: (world: RAPIER.World) => world.takeSnapshot(),
        read: (bytes: Uint8Array) => RAPIER.World.restoreSnapshot(bytes),
      },
      // Rule values and handles as one JSON string beside the world (the event queue is not stored).
      GameEngine: {
        cls: GameEngine,
        write: (engine: GameEngine) => engine.toSnapshot(),
        read: (snapshot: EngineSnapshot) => GameEngine.fromSnapshot(snapshot),
      },
      CpuController: {
        cls: CpuController,
        // The random source is a function and cannot be snapshotted; the model's Math.random is replicated.
        write: (cpu: CpuController) => Object.fromEntries(Object.entries(cpu).filter(([k]) => k !== 'rng')),
        read: (data: Record<string, unknown>) =>
          Object.assign(Object.create(CpuController.prototype), data, { rng: () => Math.random() }),
      },
    };
  }

  init() {
    this.rules = { stagePreset: 'standard', targetScore: 3, cpuDifficulty: 'normal' };
    this.engine = new GameEngine();
    this.engine.loadStage(this.rules.stagePreset);
    this.seats = { p1: null, p2: null };
    this.inputs = { p1: { ...NO_INPUT }, p2: { ...NO_INPUT } };
    this.cpus = this.makeCpus();
    this.viewers = [];
    this.paused = false;

    this.subscribe(this.sessionId, 'view-join', this.viewJoined);
    this.subscribe(this.sessionId, 'view-exit', this.viewExited);
    this.subscribe(SCOPE, 'input', this.onInput);
    this.subscribe(SCOPE, 'start', this.onStart);
    this.subscribe(SCOPE, 'pause', this.onPause);
    this.subscribe(SCOPE, 'title', this.onTitle);
    this.subscribe(SCOPE, 'rules', this.onRules);
    this.future(TICK_MS).tick();
  }

  private makeCpus() {
    const rng = () => Math.random();
    return {
      p1: new CpuController(this.rules.cpuDifficulty, 'p1', rng),
      p2: new CpuController(this.rules.cpuDifficulty, 'p2', rng),
    };
  }

  seatOf(viewId: string): PlayerId | null {
    return PLAYERS.find((id) => this.seats[id] === viewId) ?? null;
  }

  viewJoined(viewId: string) {
    if (!this.viewers.includes(viewId)) this.viewers.push(viewId);
    const free = PLAYERS.find((id) => this.seats[id] === null);
    if (free && !this.seatOf(viewId)) {
      this.seats[free] = viewId;
      this.inputs[free] = { ...NO_INPUT };
    }
  }

  viewExited(viewId: string) {
    this.viewers = this.viewers.filter((v) => v !== viewId);
    const seat = this.seatOf(viewId);
    if (!seat) return;
    this.seats[seat] = null;
    this.inputs[seat] = { ...NO_INPUT };
    // Hand the car to a waiting spectator, if any.
    const waiting = this.viewers.find((v) => !this.seatOf(v));
    if (waiting) this.seats[seat] = waiting;
  }

  onInput(msg: InputMessage) {
    const seat = this.seatOf(msg.viewId);
    if (!seat) return;
    this.inputs[seat] = { throttle: clampAxis(msg.throttle), steer: clampAxis(msg.steer), boost: msg.boost === true };
  }

  onStart() {
    this.engine.startMatch({ stage: this.rules.stagePreset, targetScore: this.rules.targetScore });
    this.cpus = this.makeCpus();
    this.paused = false;
    this.publish(SCOPE, 'match-started');
  }

  onPause() {
    const running = ['countdown', 'playing', 'finishing'].includes(this.engine.phase);
    if (running) this.paused = !this.paused;
  }

  onTitle() {
    this.engine.loadStage(this.rules.stagePreset);
    this.paused = false;
  }

  onRules(patch: Partial<OnlineRules>) {
    const next = { ...this.rules };
    if (patch.stagePreset === 'standard' || patch.stagePreset === 'ramps' || patch.stagePreset === 'sumo') next.stagePreset = patch.stagePreset;
    if (patch.targetScore === 0 || patch.targetScore === 3 || patch.targetScore === 5) next.targetScore = patch.targetScore;
    if (patch.cpuDifficulty === 'easy' || patch.cpuDifficulty === 'normal' || patch.cpuDifficulty === 'hard') next.cpuDifficulty = patch.cpuDifficulty;
    this.rules = next;
    if (this.engine.phase === 'idle') this.engine.loadStage(next.stagePreset);
    else this.onStart();
  }

  tick() {
    if (!this.paused && this.engine.phase !== 'idle') {
      const engine = this.engine;
      for (let i = 0; i < STEPS_PER_TICK; i++) {
        const live = engine.phase === 'playing' || engine.phase === 'finishing';
        const input = (id: PlayerId) =>
          this.seats[id] ? this.inputs[id] : live ? this.cpus[id].update(engine, FIXED_STEP) : NO_INPUT;
        engine.step(FIXED_STEP, { p1: input('p1'), p2: input('p2') });
      }
      const events = engine.drainEvents();
      if (events.length) this.publish(SCOPE, 'events', events);
    }
    this.future(TICK_MS).tick();
  }
}
SumoModel.register('SumoModel');
