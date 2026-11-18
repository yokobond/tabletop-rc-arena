/**
 * Rapier wrapper, modelled on Croquet Microverse's PhysicsManager / PhysicsWorld.
 *
 * The Rapier World is the single source of truth for every body: positions, rotations,
 * velocities, contacts and sleep state. Snapshots are `world.takeSnapshot()` bytes; this
 * class only adds plain bookkeeping (body and collider handles) next to them, so that a
 * world restored with `RAPIER.World.restoreSnapshot` is complete.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { BASE, connectedToBase, specOf, jointBond, jointStrength, localHalf, orientationQuat, type Adhesive, type CarDesign, type Vec3 } from './bodyParts';
import { CAR_PARTS, type CarPartId, type CarPartSpec, type PartShape } from './carParts';
import { FIXED_STEP, FLOOR_Y, GRAVITY, TABLE_HALF_X, TABLE_HALF_Z, TABLE_THICKNESS } from './constants';
import type { PlayerId, PropDefinition, StageDefinition, StaticObstacle } from './types';

export { RAPIER };

let ready: Promise<void> | null = null;
/** Loads the WebAssembly module once. Await before creating any world (Microverse's asyncStart). */
export function initPhysics() {
  ready ??= RAPIER.init();
  return ready;
}

export type ColliderKind = 'table' | 'floor' | 'mug' | 'books' | 'ramp' | 'car' | 'prop' | 'debris';

export interface ColliderInfo {
  kind: ColliderKind;
  owner?: PlayerId;
  /** A chassis part (carParts.ts) or a body piece (bodyParts.ts) by its id. */
  part?: string;
  prop?: number;
}

/**
 * One car part or body piece: a collider on the chassis while attached, on a body of its own
 * (shared with whatever it is still stuck to) once it has broken off.
 */
export interface PartEntry {
  owner: PlayerId;
  partId: string;
  colliderHandle: number;
  bodyHandle: number;
  attached: boolean;
  /** A piece from the garage, rather than a part of the chassis. */
  piece?: boolean;
}

/** Tape or hot glue between two pieces (or a piece and the chassis) of a car. */
export interface JointEntry {
  owner: PlayerId;
  a: string;
  b: string;
  kind: Adhesive;
  /** Hit damage it takes before letting go. */
  strength: number;
  damage: number;
  broken: boolean;
  /** Car-local center of the tape or hot glue. */
  at: Vec3;
}

export interface Pose {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/** Collision group bits (membership << 16 | filter). */
export const GROUP = { STATIC: 0x1, P1: 0x2, P2: 0x4, PROP: 0x8, DEBRIS: 0x10, ALL: 0xffff } as const;
const groups = (membership: number, filter: number) => ((membership & 0xffff) << 16) | (filter & 0xffff);
export const carGroup = (owner: PlayerId) => (owner === 'p1' ? GROUP.P1 : GROUP.P2);

export const yawQuat = (heading: number) => ({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) });

const PART_BY_ID = Object.fromEntries(CAR_PARTS.map((p) => [p.id, p])) as Record<CarPartId, CarPartSpec>;
/** A car with a garage body keeps the chassis, bumpers and wheels; the pieces replace the rest. */
const BODY_PARTS: CarPartId[] = ['shell', 'spoiler'];

export type Designs = Record<PlayerId, CarDesign | null>;

function shapeDesc(shape: PartShape) {
  if (shape.kind === 'ball') return RAPIER.ColliderDesc.ball(shape.r);
  return shape.round
    ? RAPIER.ColliderDesc.roundCuboid(shape.hx - shape.round, shape.hy - shape.round, shape.hz - shape.round, shape.round)
    : RAPIER.ColliderDesc.cuboid(shape.hx, shape.hy, shape.hz);
}

/** Contact force above which Rapier reports a part hit; finite break thresholds are checked against it. */
const PART_FORCE_REPORT = 40;

export interface PhysicsState {
  world: RAPIER.World;
  carBodies: Record<PlayerId, number>;
  propBodies: number[];
  parts: PartEntry[];
  joints: JointEntry[];
  colliders: [number, ColliderInfo][];
}

export class PhysicsWorld {
  world: RAPIER.World;
  carBodies: Record<PlayerId, number> = { p1: -1, p2: -1 };
  propBodies: number[] = [];
  parts: PartEntry[] = [];
  joints: JointEntry[] = [];
  colliders = new Map<number, ColliderInfo>();
  /** Not part of any snapshot: the queue is recreated on demand (Microverse does the same). */
  private $queue: RAPIER.EventQueue | null = null;

  constructor(world: RAPIER.World) {
    this.world = world;
  }

  static create(stage: StageDefinition, designs: Designs = { p1: null, p2: null }) {
    const world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    world.timestep = FIXED_STEP;
    const pw = new PhysicsWorld(world);
    pw.buildStatics(stage.obstacles);
    for (const id of ['p1', 'p2'] as PlayerId[]) {
      const s = stage.spawns[id];
      pw.carBodies[id] = pw.createCar(id, s.x, 0.002, s.z, s.heading, designs[id]);
    }
    pw.propBodies = stage.props.map((def, i) => pw.createProp(def, i));
    return pw;
  }

  // -------------------------------------------------------------------------
  // Snapshot: everything physical is in the Rapier bytes, the rest is handles.
  // -------------------------------------------------------------------------
  toState(): PhysicsState {
    return {
      world: this.world,
      carBodies: { ...this.carBodies },
      propBodies: [...this.propBodies],
      parts: this.parts.map((p) => ({ ...p })),
      joints: this.joints.map((j) => ({ ...j, at: [...j.at] as Vec3 })),
      colliders: [...this.colliders.entries()].map(([h, info]) => [h, { ...info }]),
    };
  }

  static fromState(state: PhysicsState) {
    const pw = new PhysicsWorld(state.world);
    pw.carBodies = { ...state.carBodies };
    pw.propBodies = [...state.propBodies];
    pw.parts = state.parts.map((p) => ({ ...p }));
    pw.joints = (state.joints ?? []).map((j) => ({ ...j, at: [...j.at] as Vec3 }));
    pw.colliders = new Map(state.colliders.map(([h, info]) => [h, { ...info }]));
    return pw;
  }

  /** A deep copy through Rapier's own snapshot: what a late joiner receives. */
  cloneViaSnapshot() {
    const state = this.toState();
    return PhysicsWorld.fromState({ ...state, world: RAPIER.World.restoreSnapshot(this.world.takeSnapshot()) });
  }

  takeSnapshot() {
    return this.world.takeSnapshot();
  }

  free() {
    this.$queue?.free();
    this.$queue = null;
    this.world.free();
  }

  // -------------------------------------------------------------------------
  // Stepping and events.
  // -------------------------------------------------------------------------
  step(
    onCollision: (a: number, b: number, started: boolean) => void,
    onPartForce?: (collider1: number, collider2: number, force: number) => void,
  ) {
    this.$queue ??= new RAPIER.EventQueue(true);
    this.world.step(this.$queue);
    this.$queue.drainCollisionEvents(onCollision);
    this.$queue.drainContactForceEvents((e) => onPartForce?.(e.collider1(), e.collider2(), e.totalForceMagnitude()));
  }

  info(handle: number) {
    return this.colliders.get(handle);
  }

  body(handle: number) {
    return this.world.getRigidBody(handle);
  }

  carBody(owner: PlayerId) {
    return this.world.getRigidBody(this.carBodies[owner]);
  }

  propBody(index: number) {
    return this.world.getRigidBody(this.propBodies[index]);
  }

  /** Distance to the first surface below a point, ignoring one body. */
  castDown(x: number, y: number, z: number, maxToi: number, exclude: RAPIER.RigidBody) {
    const ray = new RAPIER.Ray({ x, y, z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, maxToi, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, exclude);
    return hit ? hit.timeOfImpact : null;
  }

  static poseOf(body: { translation(): RAPIER.Vector; rotation(): RAPIER.Rotation }): Pose {
    const t = body.translation();
    const q = body.rotation();
    return { x: t.x, y: t.y, z: t.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w };
  }

  // -------------------------------------------------------------------------
  // Static stage geometry.
  // -------------------------------------------------------------------------
  private addStatic(desc: RAPIER.ColliderDesc, info: ColliderInfo) {
    desc.setCollisionGroups(groups(GROUP.STATIC, GROUP.ALL));
    const c = this.world.createCollider(desc);
    this.colliders.set(c.handle, info);
  }

  private buildStatics(obstacles: StaticObstacle[]) {
    this.addStatic(
      RAPIER.ColliderDesc.cuboid(TABLE_HALF_X, TABLE_THICKNESS / 2, TABLE_HALF_Z)
        .setTranslation(0, -TABLE_THICKNESS / 2, 0)
        .setFriction(0.6),
      { kind: 'table' },
    );
    this.addStatic(
      RAPIER.ColliderDesc.cuboid(30, 0.5, 30).setTranslation(0, FLOOR_Y - 0.5, 0).setFriction(0.8),
      { kind: 'floor' },
    );
    for (const o of obstacles) {
      const rot = yawQuat(o.rotation);
      if (o.kind === 'mug') {
        this.addStatic(
          RAPIER.ColliderDesc.cylinder(o.height / 2, o.radius)
            .setTranslation(o.x, o.height / 2, o.z)
            .setRestitution(0.9)
            .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
            .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
          { kind: 'mug' },
        );
      } else if (o.kind === 'books') {
        this.addStatic(
          RAPIER.ColliderDesc.cuboid(o.halfX, o.height / 2, o.halfZ)
            .setTranslation(o.x, o.height / 2, o.z)
            .setRotation(rot)
            .setRestitution(0.25)
            .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
          { kind: 'books' },
        );
      } else {
        // A wedge rising towards local +X.
        const { halfX: hx, halfZ: hz, height: h } = o;
        const points = new Float32Array([-hx, 0, -hz, -hx, 0, hz, hx, 0, -hz, hx, 0, hz, hx, h, -hz, hx, h, hz]);
        const desc = RAPIER.ColliderDesc.convexHull(points);
        if (!desc) throw new Error('ramp hull');
        this.addStatic(desc.setTranslation(o.x, 0, o.z).setRotation(rot).setFriction(0.4), { kind: 'ramp' });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cars: one chassis body carrying every part as a compound collider.
  // -------------------------------------------------------------------------
  private partDesc(spec: CarPartSpec, membership: number) {
    const desc = shapeDesc(spec.shape)
      .setMass(spec.mass)
      .setFriction(0)
      .setRestitution(spec.isWheel ? 0 : 0.3)
      .setCollisionGroups(groups(membership, GROUP.ALL))
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(PART_FORCE_REPORT);
    return desc;
  }

  private createCar(owner: PlayerId, x: number, y: number, z: number, heading: number, design: CarDesign | null) {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setRotation(yawQuat(heading))
        .setAngularDamping(2)
        .setCcdEnabled(true)
        .setCanSleep(false),
    );
    for (const spec of CAR_PARTS) {
      if (design && BODY_PARTS.includes(spec.id)) continue;
      const desc = this.partDesc(spec, carGroup(owner)).setTranslation(...spec.offset);
      const c = this.world.createCollider(desc, body);
      this.colliders.set(c.handle, { kind: 'car', owner, part: spec.id });
      this.parts.push({ owner, partId: spec.id, colliderHandle: c.handle, bodyHandle: body.handle, attached: true });
    }
    if (design) this.addBody(owner, body, design);
    return body.handle;
  }

  /** The garage pieces: one collider each on the chassis, and the joints between them. */
  private addBody(owner: PlayerId, body: RAPIER.RigidBody, design: CarDesign) {
    for (const piece of design.pieces) {
      const spec = specOf(piece);
      let desc: RAPIER.ColliderDesc;
      if (spec.shape.kind === 'box') {
        const [hx, hy, hz] = localHalf(spec.shape);
        desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setRotation(orientationQuat(piece.rot));
      } else if (spec.shape.kind === 'cylinder') {
        desc = RAPIER.ColliderDesc.cylinder(spec.shape.h / 2, spec.shape.r).setRotation(orientationQuat(piece.rot));
      } else {
        desc = RAPIER.ColliderDesc.ball(spec.shape.r);
      }
      desc
        .setTranslation(piece.x, piece.y, piece.z)
        .setMass(spec.mass)
        .setFriction(0)
        .setRestitution(0.3)
        .setCollisionGroups(groups(carGroup(owner), GROUP.ALL))
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      const c = this.world.createCollider(desc, body);
      this.colliders.set(c.handle, { kind: 'car', owner, part: piece.id });
      this.parts.push({ owner, partId: piece.id, colliderHandle: c.handle, bodyHandle: body.handle, attached: true, piece: true });
    }
    for (const joint of design.joints) {
      const bond = jointBond(design, joint);
      if (!bond) continue;
      this.joints.push({ owner, a: joint.a, b: joint.b, kind: joint.kind, strength: jointStrength(bond), damage: 0, broken: false, at: bond.center });
    }
  }

  /** Removes the car with all of its debris and puts a complete one in its place. */
  rebuildCar(owner: PlayerId, x: number, y: number, z: number, heading: number, design: CarDesign | null = null) {
    for (const entry of this.parts.filter((p) => p.owner === owner)) {
      this.colliders.delete(entry.colliderHandle);
      if (!entry.attached) {
        const debris = this.world.getRigidBody(entry.bodyHandle);
        if (debris) this.world.removeRigidBody(debris);
      }
    }
    this.parts = this.parts.filter((p) => p.owner !== owner);
    this.joints = this.joints.filter((j) => j.owner !== owner);
    const old = this.world.getRigidBody(this.carBodies[owner]);
    if (old) this.world.removeRigidBody(old);
    this.carBodies[owner] = this.createCar(owner, x, y, z, heading, design);
    return this.carBody(owner);
  }

  /** Changes what one car collides with, e.g. to let a respawning ghost pass through its rival. */
  setCarFilter(owner: PlayerId, filter: number) {
    for (const entry of this.parts) {
      if (entry.owner !== owner || !entry.attached) continue;
      this.world.getCollider(entry.colliderHandle)?.setCollisionGroups(groups(carGroup(owner), filter));
    }
  }

  partSpec(partId: string) {
    return PART_BY_ID[partId as CarPartId] as CarPartSpec | undefined;
  }

  partEntry(colliderHandle: number) {
    return this.parts.find((p) => p.colliderHandle === colliderHandle);
  }

  /** Breaks one part off its car (see detachGroup). */
  detachPart(colliderHandle: number, impulse = { x: 0, y: 0, z: 0 }) {
    const entry = this.partEntry(colliderHandle);
    if (!entry || !entry.attached) return null;
    return this.detachGroup(entry.owner, [entry.partId], impulse) ? entry : null;
  }

  /**
   * Breaks parts off a car as one piece of debris: their colliders leave the chassis and come
   * back, at the same car-local places, on a new dynamic body that starts where the chassis is,
   * moving as the chassis did at those places, plus `impulse`.
   */
  detachGroup(owner: PlayerId, partIds: string[], impulse = { x: 0, y: 0, z: 0 }) {
    const entries = this.parts.filter((p) => p.owner === owner && p.attached && partIds.includes(p.partId));
    const chassis = this.world.getRigidBody(this.carBodies[owner]);
    if (entries.length === 0 || !chassis) return null;
    const t = chassis.translation();
    const com = chassis.worldCom();
    const v = chassis.linvel();
    const w = chassis.angvel();
    // The velocity of the chassis at the group's middle.
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (const e of entries) {
      const p = this.world.getCollider(e.colliderHandle)!.translation();
      mx += p.x / entries.length;
      my += p.y / entries.length;
      mz += p.z / entries.length;
    }
    const rx = mx - com.x;
    const ry = my - com.y;
    const rz = mz - com.z;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(t.x, t.y, t.z)
        .setRotation(chassis.rotation())
        .setLinvel(v.x + (w.y * rz - w.z * ry), v.y + (w.z * rx - w.x * rz), v.z + (w.x * ry - w.y * rx))
        .setAngvel(w)
        .setAngularDamping(0.5),
    );
    for (const entry of entries) {
      const old = this.world.getCollider(entry.colliderHandle)!;
      const local = old.translationWrtParent() ?? { x: 0, y: 0, z: 0 };
      const turn = old.rotationWrtParent() ?? { x: 0, y: 0, z: 0, w: 1 };
      const desc = new RAPIER.ColliderDesc(old.shape)
        .setTranslation(local.x, local.y, local.z)
        .setRotation(turn)
        .setMass(old.mass())
        .setFriction(0.6)
        .setRestitution(0.3)
        .setCollisionGroups(groups(GROUP.DEBRIS, GROUP.ALL));
      this.world.removeCollider(old, true);
      this.colliders.delete(entry.colliderHandle);
      const c = this.world.createCollider(desc, body);
      this.colliders.set(c.handle, { kind: 'debris', owner, part: entry.partId });
      entry.colliderHandle = c.handle;
      entry.bodyHandle = body.handle;
      entry.attached = false;
    }
    body.applyImpulse(impulse, true);
    return body;
  }

  /**
   * Hit damage on a piece: it goes through every joint between the piece and the chassis
   * (along the shortest way), and a joint that has taken enough lets go. Returns the joints
   * that broke; whatever no longer reaches the chassis has come off the car by then.
   */
  damagePiece(owner: PlayerId, pieceId: string, damage: number) {
    const joints = this.joints.filter((j) => j.owner === owner);
    const path = shortestPath(joints, pieceId);
    const broke: JointEntry[] = [];
    for (const j of path) {
      j.damage += damage;
      if (j.damage >= j.strength) {
        j.broken = true;
        broke.push(j);
      }
    }
    if (broke.length) this.dropLoosePieces(owner);
    return broke;
  }

  /** Pieces cut off from the chassis fall away, each stuck-together cluster as one body. */
  dropLoosePieces(owner: PlayerId) {
    const joints = this.joints.filter((j) => j.owner === owner);
    const reached = connectedToBase(joints, (i) => !joints[i].broken);
    const loose = this.parts.filter((p) => p.owner === owner && p.piece && p.attached && !reached.has(p.partId)).map((p) => p.partId);
    const done = new Set<string>();
    for (const id of loose) {
      if (done.has(id)) continue;
      const cluster = clusterOf(joints, id);
      const ids = loose.filter((p) => cluster.has(p));
      ids.forEach((p) => done.add(p));
      this.detachGroup(owner, ids);
    }
    return loose;
  }

  /**
   * Where a part is drawn from: the body it is on. Attached parts are on the chassis; a part
   * that broke off is on a body that started in the chassis' place, so the car-local layout holds.
   */
  partPose(entry: PartEntry): Pose | null {
    const b = this.world.getRigidBody(entry.bodyHandle);
    return b ? PhysicsWorld.poseOf(b) : null;
  }

  // -------------------------------------------------------------------------
  // Props.
  // -------------------------------------------------------------------------
  private createProp(def: PropDefinition, index: number) {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(def.x, 0.001, def.z)
        .setRotation(yawQuat(def.angle))
        .setAngularDamping(0.8)
        .setLinearDamping(0.3),
    );
    // A prop twice the size is the same thing made eight times heavier.
    const s = def.scale;
    const desc =
      def.kind === 'pencil'
        ? RAPIER.ColliderDesc.capsule(0.3 * s, 0.042 * s)
            // Capsules run along Y: lay it along local X like the model.
            .setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 })
            .setTranslation(0.03 * s, 0.042 * s, 0)
            .setMass(0.14 * s * s * s)
        : RAPIER.ColliderDesc.cuboid(0.11 * s, 0.041 * s, 0.06 * s)
            .setTranslation(0, 0.041 * s, 0)
            .setMass(0.28 * s * s * s);
    desc
      .setFriction(def.kind === 'pencil' ? 0.5 : 0.7)
      .setRestitution(0.15)
      .setCollisionGroups(groups(GROUP.PROP, GROUP.ALL))
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const c = this.world.createCollider(desc, body);
    this.colliders.set(c.handle, { kind: 'prop', prop: index });
    return body.handle;
  }
}

/** The joints on the shortest way from a piece to the chassis (none when it is off already). */
function shortestPath(joints: JointEntry[], from: string): JointEntry[] {
  const via = new Map<string, JointEntry | null>([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    if (id === BASE) break;
    for (const j of joints) {
      if (j.broken || (j.a !== id && j.b !== id)) continue;
      const next = j.a === id ? j.b : j.a;
      if (via.has(next)) continue;
      via.set(next, j);
      queue.push(next);
    }
  }
  if (!via.has(BASE)) return [];
  const path: JointEntry[] = [];
  let at = BASE;
  while (at !== from) {
    const j = via.get(at)!;
    path.push(j);
    at = j.a === at ? j.b : j.a;
  }
  return path;
}

/** Everything still stuck to a piece. */
function clusterOf(joints: JointEntry[], from: string) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    for (const j of joints) {
      if (j.broken || (j.a !== id && j.b !== id)) continue;
      const next = j.a === id ? j.b : j.a;
      if (next === BASE || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}
