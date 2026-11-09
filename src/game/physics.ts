/**
 * Rapier wrapper, modelled on Croquet Microverse's PhysicsManager / PhysicsWorld.
 *
 * The Rapier World is the single source of truth for every body: positions, rotations,
 * velocities, contacts and sleep state. Snapshots are `world.takeSnapshot()` bytes; this
 * class only adds plain bookkeeping (body and collider handles) next to them, so that a
 * world restored with `RAPIER.World.restoreSnapshot` is complete.
 */
import RAPIER from '@dimforge/rapier3d-compat';
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
  part?: CarPartId;
  prop?: number;
}

/** One car part: a collider on the chassis while attached, its own body once broken off. */
export interface PartEntry {
  owner: PlayerId;
  partId: CarPartId;
  colliderHandle: number;
  bodyHandle: number;
  attached: boolean;
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
  colliders: [number, ColliderInfo][];
}

export class PhysicsWorld {
  world: RAPIER.World;
  carBodies: Record<PlayerId, number> = { p1: -1, p2: -1 };
  propBodies: number[] = [];
  parts: PartEntry[] = [];
  colliders = new Map<number, ColliderInfo>();
  /** Not part of any snapshot: the queue is recreated on demand (Microverse does the same). */
  private $queue: RAPIER.EventQueue | null = null;

  constructor(world: RAPIER.World) {
    this.world = world;
  }

  static create(stage: StageDefinition) {
    const world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    world.timestep = FIXED_STEP;
    const pw = new PhysicsWorld(world);
    pw.buildStatics(stage.obstacles);
    for (const id of ['p1', 'p2'] as PlayerId[]) {
      const s = stage.spawns[id];
      pw.carBodies[id] = pw.createCar(id, s.x, 0.002, s.z, s.heading);
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
      colliders: [...this.colliders.entries()].map(([h, info]) => [h, { ...info }]),
    };
  }

  static fromState(state: PhysicsState) {
    const pw = new PhysicsWorld(state.world);
    pw.carBodies = { ...state.carBodies };
    pw.propBodies = [...state.propBodies];
    pw.parts = state.parts.map((p) => ({ ...p }));
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

  private createCar(owner: PlayerId, x: number, y: number, z: number, heading: number) {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setRotation(yawQuat(heading))
        .setAngularDamping(2)
        .setCcdEnabled(true)
        .setCanSleep(false),
    );
    for (const spec of CAR_PARTS) {
      const desc = this.partDesc(spec, carGroup(owner)).setTranslation(...spec.offset);
      const c = this.world.createCollider(desc, body);
      this.colliders.set(c.handle, { kind: 'car', owner, part: spec.id });
      this.parts.push({ owner, partId: spec.id, colliderHandle: c.handle, bodyHandle: body.handle, attached: true });
    }
    return body.handle;
  }

  /** Removes the car with all of its debris and puts a complete one in its place. */
  rebuildCar(owner: PlayerId, x: number, y: number, z: number, heading: number) {
    for (const entry of this.parts.filter((p) => p.owner === owner)) {
      this.colliders.delete(entry.colliderHandle);
      if (!entry.attached) {
        const debris = this.world.getRigidBody(entry.bodyHandle);
        if (debris) this.world.removeRigidBody(debris);
      }
    }
    this.parts = this.parts.filter((p) => p.owner !== owner);
    const old = this.world.getRigidBody(this.carBodies[owner]);
    if (old) this.world.removeRigidBody(old);
    this.carBodies[owner] = this.createCar(owner, x, y, z, heading);
    return this.carBody(owner);
  }

  /** Changes what one car collides with, e.g. to let a respawning ghost pass through its rival. */
  setCarFilter(owner: PlayerId, filter: number) {
    for (const entry of this.parts) {
      if (entry.owner !== owner || !entry.attached) continue;
      this.world.getCollider(entry.colliderHandle)?.setCollisionGroups(groups(carGroup(owner), filter));
    }
  }

  partSpec(partId: CarPartId) {
    return PART_BY_ID[partId];
  }

  partEntry(colliderHandle: number) {
    return this.parts.find((p) => p.colliderHandle === colliderHandle);
  }

  /**
   * Breaks one part off its car: the collider leaves the chassis and comes back as its own
   * dynamic body with the same shape, pose and velocity, plus `impulse`.
   */
  detachPart(colliderHandle: number, impulse = { x: 0, y: 0, z: 0 }) {
    const entry = this.partEntry(colliderHandle);
    if (!entry || !entry.attached) return null;
    const collider = this.world.getCollider(colliderHandle);
    const chassis = this.world.getRigidBody(entry.bodyHandle);
    if (!collider || !chassis) return null;
    const t = collider.translation();
    const q = collider.rotation();
    const com = chassis.translation();
    const v = chassis.linvel();
    const w = chassis.angvel();
    const rx = t.x - com.x;
    const ry = t.y - com.y;
    const rz = t.z - com.z;
    this.world.removeCollider(collider, true);
    this.colliders.delete(colliderHandle);

    const spec = PART_BY_ID[entry.partId];
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(t.x, t.y, t.z)
        .setRotation(q)
        .setLinvel(v.x + (w.y * rz - w.z * ry), v.y + (w.z * rx - w.x * rz), v.z + (w.x * ry - w.y * rx))
        .setAngvel(w)
        .setAngularDamping(0.5),
    );
    const desc = shapeDesc(spec.shape)
      .setMass(spec.mass)
      .setFriction(0.6)
      .setRestitution(0.3)
      .setCollisionGroups(groups(GROUP.DEBRIS, GROUP.ALL));
    const c = this.world.createCollider(desc, body);
    body.applyImpulse(impulse, true);
    this.colliders.set(c.handle, { kind: 'debris', owner: entry.owner, part: entry.partId });
    entry.colliderHandle = c.handle;
    entry.bodyHandle = body.handle;
    entry.attached = false;
    return entry;
  }

  /** World pose of a part, wherever it is (on the car or flying around). */
  partPose(entry: PartEntry): Pose | null {
    const c = this.world.getCollider(entry.colliderHandle);
    return c ? PhysicsWorld.poseOf(c) : null;
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
    const desc =
      def.kind === 'pencil'
        ? RAPIER.ColliderDesc.capsule(0.3, 0.042)
            // Capsules run along Y: lay it along local X like the model.
            .setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 })
            .setTranslation(0.03, 0.042, 0)
            .setMass(0.14)
        : RAPIER.ColliderDesc.cuboid(0.11, 0.041, 0.06).setTranslation(0, 0.041, 0).setMass(0.28);
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
