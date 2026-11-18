/**
 * The replicated model. Every participant runs this bit-identically: the reflector only
 * timestamps and forwards the view events (inputs, start, pause, ...), and the model's own
 * `future()` loop drives the Rapier world. Late joiners get a Croquet snapshot, in which the
 * Rapier world is stored as `world.takeSnapshot()` bytes (the Microverse PhysicsManager way).
 */
import * as Croquet from '@croquet/croquet';
import { CpuController } from '../game/ai';
import { applyArenaEdit, type ArenaEdit } from '../game/arena';
import { MESH_ID, sanitizeDesign, type CarDesign } from '../game/bodyParts';
import { FIXED_STEP } from '../game/constants';
import { GameEngine, type EngineSnapshot } from '../game/engine';
import { RAPIER } from '../game/physics';
import type { CarInput, CpuDifficulty, PlayerId } from '../game/types';
import { NO_INPUT } from '../game/types';

export const SCOPE = 'sumo';
/** One model tick per reflector tick (tps 60); each covers two fixed physics steps. */
const TICK_MS = 1000 / 60;
const STEPS_PER_TICK = Math.round(TICK_MS / 1000 / FIXED_STEP);
const PLAYERS: PlayerId[] = ['p1', 'p2'];

/** Rules anyone in the session may change. The arena is not one of them: see `canEditArena`. */
export interface OnlineRules {
  targetScore: number;
  cpuDifficulty: CpuDifficulty;
}

export interface InputMessage extends CarInput {
  viewId: string;
}

/** Passed to `Session.join`: a name for the device that outlives a reload, unlike the view id. */
export interface ViewData {
  device: string;
}

interface ViewInfo {
  viewId: string;
  viewData?: Partial<ViewData>;
}

export interface ArenaEditMessage {
  viewId: string;
  edit: ArenaEdit;
}

export interface DesignMessage {
  viewId: string;
  /** The body this participant built in the garage, or null for the classic car. */
  design: CarDesign | null;
}

/** Where on the session's file server the look of a part made from an STL file is. */
export interface MeshRefMessage {
  id: string;
  ref: string;
}

/** Looks kept track of; the oldest are forgotten first. */
const MAX_MESH_REFS = 256;

export interface ArenaAccessMessage {
  viewId: string;
  /** Let everybody edit the arena, or only the master. */
  open?: boolean;
  /** The view id of the participant who becomes the master. */
  master?: string;
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
  /** Device of each view that is here. */
  declare devices: Record<string, string>;
  /** The arena master's device: whoever came first, until the role is handed over. */
  declare arenaMaster: string | null;
  /** True when every participant may edit the arena. */
  declare arenaOpen: boolean;
  /** The garage body of each view that is here; a car is built from its driver's. */
  declare designs: Record<string, CarDesign | null>;
  /** Where the looks of made-up parts are on the file server, by look id. */
  declare meshRefs: Record<string, string>;

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
    this.rules = { targetScore: 3, cpuDifficulty: 'normal' };
    this.engine = new GameEngine();
    this.seats = { p1: null, p2: null };
    this.inputs = { p1: { ...NO_INPUT }, p2: { ...NO_INPUT } };
    this.cpus = this.makeCpus();
    this.viewers = [];
    this.paused = false;
    this.devices = {};
    this.arenaMaster = null;
    this.arenaOpen = false;
    this.designs = {};
    this.meshRefs = {};

    this.subscribe(this.sessionId, 'view-join', this.viewJoined);
    this.subscribe(this.sessionId, 'view-exit', this.viewExited);
    this.subscribe(SCOPE, 'input', this.onInput);
    this.subscribe(SCOPE, 'start', this.onStart);
    this.subscribe(SCOPE, 'pause', this.onPause);
    this.subscribe(SCOPE, 'title', this.onTitle);
    this.subscribe(SCOPE, 'rules', this.onRules);
    this.subscribe(SCOPE, 'arena-edit', this.onArenaEdit);
    this.subscribe(SCOPE, 'arena-access', this.onArenaAccess);
    this.subscribe(SCOPE, 'design', this.onDesign);
    this.subscribe(SCOPE, 'mesh-ref', this.onMeshRef);
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

  /**
   * The view acting as arena master: the master's own device while it is here, otherwise whoever
   * has been here longest, so that the arena never ends up locked behind someone who left.
   */
  arenaMasterView(): string | null {
    return this.viewers.find((v) => this.devices[v] === this.arenaMaster) ?? this.viewers[0] ?? null;
  }

  isArenaMaster(viewId: string) {
    const master = this.arenaMasterView();
    if (master === null || !this.viewers.includes(viewId)) return false;
    // The same device in two tabs is the master in both.
    return viewId === master || this.devices[viewId] === this.devices[master];
  }

  canEditArena(viewId: string) {
    return this.viewers.includes(viewId) && (this.arenaOpen || this.isArenaMaster(viewId));
  }

  viewJoined(info: ViewInfo | string) {
    const viewId = typeof info === 'string' ? info : info.viewId;
    const given = typeof info === 'string' ? undefined : info.viewData?.device;
    const device = typeof given === 'string' && given.length > 0 && given.length <= 64 ? given : viewId;
    if (!this.viewers.includes(viewId)) this.viewers.push(viewId);
    this.devices[viewId] = device;
    this.arenaMaster ??= device;
    const free = PLAYERS.find((id) => this.seats[id] === null);
    if (free && !this.seatOf(viewId)) {
      this.seats[free] = viewId;
      this.inputs[free] = { ...NO_INPUT };
    }
    this.seatDesigns();
  }

  viewExited(info: ViewInfo | string) {
    const viewId = typeof info === 'string' ? info : info.viewId;
    this.viewers = this.viewers.filter((v) => v !== viewId);
    delete this.devices[viewId];
    const seat = this.seatOf(viewId);
    if (!seat) return;
    this.seats[seat] = null;
    this.inputs[seat] = { ...NO_INPUT };
    // Hand the car to a waiting spectator, if any.
    const waiting = this.viewers.find((v) => !this.seatOf(v));
    if (waiting) this.seats[seat] = waiting;
    delete this.designs[viewId];
    this.seatDesigns();
  }

  /** A participant's garage body; it goes on whichever car they drive, now or later. */
  onDesign(msg: DesignMessage) {
    if (!msg || typeof msg.viewId !== 'string' || !this.viewers.includes(msg.viewId)) return;
    const design = msg.design === null ? null : sanitizeDesign(msg.design);
    if (msg.design !== null && !design) return;
    this.designs[msg.viewId] = design;
    this.seatDesigns();
  }

  /** A look somebody put on the file server. Only its place is kept: the model never draws. */
  onMeshRef(msg: MeshRefMessage) {
    if (!msg || typeof msg.id !== 'string' || !MESH_ID.test(msg.id) || typeof msg.ref !== 'string' || !msg.ref || msg.ref.length > 2048) return;
    // Snapshots from before looks existed have none.
    this.meshRefs ??= {};
    if (this.meshRefs[msg.id]) return;
    const ids = Object.keys(this.meshRefs);
    if (ids.length >= MAX_MESH_REFS) delete this.meshRefs[ids[0]];
    this.meshRefs[msg.id] = msg.ref;
  }

  /** Each car wears its driver's body; a car the CPU drives is the classic one. */
  private seatDesigns() {
    for (const id of PLAYERS) {
      const driver = this.seats[id];
      const wanted = (driver && this.designs[driver]) ?? null;
      if (JSON.stringify(wanted) !== JSON.stringify(this.engine.designs[id])) this.engine.setDesign(id, wanted);
    }
  }

  onInput(msg: InputMessage) {
    const seat = this.seatOf(msg.viewId);
    if (!seat) return;
    this.inputs[seat] = { throttle: clampAxis(msg.throttle), steer: clampAxis(msg.steer), boost: msg.boost === true };
  }

  onStart() {
    this.engine.startMatch({ targetScore: this.rules.targetScore });
    this.cpus = this.makeCpus();
    this.paused = false;
    this.publish(SCOPE, 'match-started');
  }

  onPause() {
    const running = ['countdown', 'playing', 'finishing'].includes(this.engine.phase);
    if (running) this.paused = !this.paused;
  }

  onTitle() {
    this.engine.loadStage();
    this.paused = false;
  }

  onRules(patch: Partial<OnlineRules>) {
    const next = { ...this.rules };
    if (patch.targetScore === 0 || patch.targetScore === 3 || patch.targetScore === 5) next.targetScore = patch.targetScore;
    if (patch.cpuDifficulty === 'easy' || patch.cpuDifficulty === 'normal' || patch.cpuDifficulty === 'hard') next.cpuDifficulty = patch.cpuDifficulty;
    this.rules = next;
    if (this.engine.phase !== 'idle') this.onStart();
  }

  /**
   * One change to the arena, from someone allowed to make it. The table is rearranged on the
   * title screen only; loading a whole arena also works mid-match and restarts it, like a rule change.
   */
  onArenaEdit(msg: ArenaEditMessage) {
    if (!msg || !this.canEditArena(msg.viewId)) return;
    const idle = this.engine.phase === 'idle';
    if (!idle && msg.edit?.op !== 'load') return;
    const next = applyArenaEdit(this.engine.stage, msg.edit);
    if (!next) return;
    this.engine.loadStage(next);
    if (!idle) this.onStart();
  }

  onArenaAccess(msg: ArenaAccessMessage) {
    if (!msg || !this.isArenaMaster(msg.viewId)) return;
    if (typeof msg.open === 'boolean') this.arenaOpen = msg.open;
    if (typeof msg.master === 'string' && this.viewers.includes(msg.master)) this.arenaMaster = this.devices[msg.master];
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
