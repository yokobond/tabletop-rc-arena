/* eslint-disable @typescript-eslint/no-explicit-any */
import { SPAWN_EDGE_MARGIN, applyArenaEdit, clampToTable, type ArenaEdit } from '../game/arena';
import type { PlayerId, StageDefinition } from '../game/types';
import { isOnline } from '../net/session';
import { applyEdit, getEngine, getState, removeSelected, rotateSelected, selectArenaItem, subscribe, type ArenaSelection } from '../runtime/store';
import { AFRAME, THREE } from './helpers';
import { CAR_COLORS, ent } from './models';

const PLAYERS: PlayerId[] = ['p1', 'p2'];
/** A press this close to a start position, on the table, picks it up (the car stands on it). */
const SPAWN_GRAB = 0.32;
/** Pencils and erasers are small: a press this close to one counts as on it. */
const PROP_GRAB = 0.18;
/** A press that moves less than this many pixels only selects. */
const DRAG_START_PX = 5;
const RING_OK = '#FACC15';
const RING_REFUSED = '#EF4444';

interface Pose {
  x: number;
  z: number;
  rotation: number;
}

function poseOf(stage: StageDefinition, sel: ArenaSelection): Pose | null {
  if (sel.list === 'spawns') {
    const s = sel.id === 'p1' || sel.id === 'p2' ? stage.spawns[sel.id] : null;
    return s ? { x: s.x, z: s.z, rotation: 0 } : null;
  }
  if (sel.list === 'obstacles') {
    const o = stage.obstacles.find((item) => item.id === sel.id);
    return o ? { x: o.x, z: o.z, rotation: o.rotation } : null;
  }
  const p = stage.props.find((item) => item.id === sel.id);
  return p ? { x: p.x, z: p.z, rotation: p.angle } : null;
}

/** Radius of the ring drawn around a selected thing. */
function reachOf(stage: StageDefinition, sel: ArenaSelection) {
  if (sel.list === 'spawns') return 0.38;
  if (sel.list === 'props') return stage.props.find((p) => p.id === sel.id)?.kind === 'pencil' ? 0.44 : 0.22;
  const o = stage.obstacles.find((item) => item.id === sel.id);
  if (!o) return 0.3;
  return o.kind === 'mug' ? o.radius + 0.14 : Math.hypot(o.halfX, o.halfZ) + 0.08;
}

function moveEdit(sel: ArenaSelection, x: number, z: number, rotation: number): ArenaEdit {
  return sel.list === 'spawns' ? { op: 'spawn', player: sel.id as PlayerId, x, z } : { op: 'move', id: sel.id, x, z, rotation };
}

interface Drag {
  sel: ArenaSelection;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  origin: Pose;
  x: number;
  z: number;
  /** From the point on the table under the pointer to the thing's centre, kept while dragging. */
  offsetX: number;
  offsetZ: number;
  valid: boolean;
  object: any;
}

/**
 * The arena editor's hands: while the store says `editing`, things on the table are picked up
 * with the pointer (mouse or finger) and dragged across it. The thing follows the pointer as a
 * preview only; letting go asks the store for the change, and anything the rules refuse goes back.
 */
AFRAME.registerComponent('arena-editor', {
  init(this: any) {
    this.active = false;
    this.drag = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.table = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.hit = new THREE.Vector3();

    const flat = (color: string) => `shader: flat; color: ${color}; transparent: true; opacity: 0.9; side: double; depthTest: false`;
    // Around whatever is selected; drawn over everything so it shows under a stack of books too.
    this.ring = ent(this.el, {
      geometry: 'primitive: ring; radiusInner: 0.93; radiusOuter: 1; segmentsTheta: 48',
      material: flat(RING_OK),
      rotation: '-90 0 0',
      cast: false,
    });
    this.ring.setAttribute('visible', 'false');
    this.ringColor = RING_OK;
    // Start positions: the cars stand on them, and they are dragged like anything else.
    this.spawnRings = Object.fromEntries(
      PLAYERS.map((id) => {
        const el = ent(this.el, {
          geometry: 'primitive: ring; radiusInner: 0.27; radiusOuter: 0.33; segmentsTheta: 40',
          material: flat(CAR_COLORS[id].body),
          rotation: '-90 0 0',
          cast: false,
        });
        el.setAttribute('visible', 'false');
        return [id, el];
      }),
    );

    this.onDown = this.onDown.bind(this);
    this.onMove = this.onMove.bind(this);
    this.onUp = this.onUp.bind(this);
    this.onKey = this.onKey.bind(this);
    this.unsubscribe = subscribe(() => this.setActive(getState().editing));
  },

  remove(this: any) {
    this.unsubscribe?.();
    this.setActive(false);
  },

  setActive(this: any, on: boolean) {
    if (on === this.active) return;
    const canvas: HTMLCanvasElement | undefined = this.el.canvas;
    if (on && !canvas) return;
    this.active = on;
    if (on && canvas) {
      canvas.addEventListener('pointerdown', this.onDown);
      canvas.addEventListener('pointermove', this.onMove);
      canvas.addEventListener('pointerup', this.onUp);
      canvas.addEventListener('pointercancel', this.onUp);
      window.addEventListener('keydown', this.onKey);
      return;
    }
    canvas?.removeEventListener('pointerdown', this.onDown);
    canvas?.removeEventListener('pointermove', this.onMove);
    canvas?.removeEventListener('pointerup', this.onUp);
    canvas?.removeEventListener('pointercancel', this.onUp);
    window.removeEventListener('keydown', this.onKey);
    if (this.drag) this.putBack(this.drag);
    this.drag = null;
    this.ring.object3D.visible = false;
    for (const id of PLAYERS) this.spawnRings[id].object3D.visible = false;
  },

  /** The component that owns the stage's entities. */
  builder(this: any) {
    return this.el.querySelector('[stage-builder]')?.components?.['stage-builder'];
  },

  /** Aims the ray through the pointer and returns where it meets the table top, if it does. */
  aim(this: any, event: PointerEvent) {
    const camera = this.el.camera;
    const rect = this.el.canvas.getBoundingClientRect();
    if (!camera || rect.width === 0 || rect.height === 0) return null;
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, camera);
    return this.raycaster.ray.intersectPlane(this.table, this.hit) as { x: number; z: number } | null;
  },

  /** What is under the pointer: an object's own shape first, then small or flat things near the point on the table. */
  pick(this: any, point: { x: number; z: number } | null): ArenaSelection | null {
    const builder = this.builder();
    const roots = builder ? [...builder.items.values()].map((item: any) => item.root.object3D) : [];
    for (const found of this.raycaster.intersectObjects(roots, true)) {
      let object = found.object;
      while (object && !object.userData.arenaItem) object = object.parent;
      if (object) return { ...object.userData.arenaItem };
    }
    if (!point) return null;
    const stage = getEngine().stage;
    let nearest: ArenaSelection | null = null;
    let distance = PROP_GRAB;
    for (const p of stage.props) {
      const d = Math.hypot(p.x - point.x, p.z - point.z);
      if (d < distance) {
        distance = d;
        nearest = { list: 'props', id: p.id };
      }
    }
    if (nearest) return nearest;
    for (const id of PLAYERS) {
      if (Math.hypot(stage.spawns[id].x - point.x, stage.spawns[id].z - point.z) < SPAWN_GRAB) return { list: 'spawns', id };
    }
    return null;
  },

  objectOf(this: any, sel: ArenaSelection) {
    if (sel.list === 'spawns') return this.spawnRings[sel.id]?.object3D ?? null;
    return this.builder()?.items.get(`${sel.list}:${sel.id}`)?.root.object3D ?? null;
  },

  onDown(this: any, event: PointerEvent) {
    if (this.drag || event.button !== 0) return;
    const point = this.aim(event);
    const sel = this.pick(point);
    selectArenaItem(sel);
    if (!sel || !point) return;
    const origin = poseOf(getEngine().stage, sel);
    const object = this.objectOf(sel);
    if (!origin || !object) return;
    event.preventDefault();
    // Keeps the drag alive when the pointer leaves the canvas. Not every pointer can be captured; the drag works without.
    try {
      this.el.canvas.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    this.drag = {
      sel,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      origin,
      x: origin.x,
      z: origin.z,
      offsetX: origin.x - point.x,
      offsetZ: origin.z - point.z,
      valid: true,
      object,
    } satisfies Drag;
  },

  onMove(this: any, event: PointerEvent) {
    const drag: Drag | null = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_START_PX) return;
      drag.moved = true;
      if (drag.sel.list === 'props') {
        const builder = this.builder();
        if (builder) builder.hold = drag.sel.id;
      }
    }
    const point = this.aim(event);
    if (!point) return;
    const at = clampToTable(point.x + drag.offsetX, point.z + drag.offsetZ, drag.sel.list === 'spawns' ? SPAWN_EDGE_MARGIN : undefined);
    drag.x = at.x;
    drag.z = at.z;
    drag.object.position.x = at.x;
    drag.object.position.z = at.z;
    drag.valid = applyArenaEdit(getEngine().stage, moveEdit(drag.sel, at.x, at.z, drag.origin.rotation)) !== null;
  },

  onUp(this: any, event: PointerEvent) {
    const drag: Drag | null = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.drag = null;
    if (this.el.canvas.hasPointerCapture?.(event.pointerId)) this.el.canvas.releasePointerCapture(event.pointerId);
    if (!drag.moved) return;
    const done = drag.valid && applyEdit(moveEdit(drag.sel, drag.x, drag.z, drag.origin.rotation)) !== null;
    if (!done) {
      this.putBack(drag);
    } else if (isOnline()) {
      // The model has the last word. If the change never arrives, show what the model has.
      window.setTimeout(() => {
        const builder = this.builder();
        if (builder?.stage) builder.sync(builder.stage);
      }, 1500);
    }
  },

  putBack(this: any, drag: Drag) {
    drag.object.position.x = drag.origin.x;
    drag.object.position.z = drag.origin.z;
    const builder = this.builder();
    if (builder && builder.hold === drag.sel.id) builder.hold = null;
  },

  onKey(this: any, event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      removeSelected();
      event.preventDefault();
    } else if (event.key === 'r' || event.key === 'R') {
      rotateSelected(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      selectArenaItem(null);
    }
  },

  tick(this: any) {
    if (!this.active) return;
    const stage = getEngine().stage;
    const drag: Drag | null = this.drag;
    const dragging = drag?.moved ? drag : null;
    for (const id of PLAYERS) {
      const ring = this.spawnRings[id].object3D;
      ring.visible = true;
      if (dragging?.sel.list === 'spawns' && dragging.sel.id === id) ring.position.y = 0.012;
      else ring.position.set(stage.spawns[id].x, 0.012, stage.spawns[id].z);
    }

    const sel = dragging?.sel ?? getState().editSelection;
    const pose = dragging ? { x: dragging.x, z: dragging.z } : sel ? poseOf(stage, sel) : null;
    const ring = this.ring.object3D;
    ring.visible = Boolean(sel && pose);
    if (!sel || !pose) return;
    const reach = reachOf(stage, sel);
    ring.position.set(pose.x, 0.014, pose.z);
    ring.scale.set(reach, reach, 1);
    const color = dragging && !dragging.valid ? RING_REFUSED : RING_OK;
    if (color !== this.ringColor) {
      this.ringColor = color;
      this.ring.getObject3D('mesh')?.material.color.set(color);
    }
  },
});
