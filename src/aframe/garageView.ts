/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The garage's 3D view: its own small three.js renderer (the arena scene keeps running behind it),
 * a car on a turntable, and the pointer. It only shows things and reports what the pointer is on;
 * the garage panel (ui/Garage.tsx) decides what that means.
 */
import { BASE, BASE_BOXES, WHEEL_BOXES, jointBond, matrixQuat, orientationQuat, pieceBox, tidyNormal, type BodyPiece, type CarDesign, type PartType, type SolidBox, type Vec3, specOf } from '../game/bodyParts';
import type { Assembly } from '../game/assembly';
import type { PointerRay, PointerTarget, SurfaceHit } from '../game/placement';
import type { PlayerId } from '../game/types';
import { THREE } from './helpers';
import { buildBaseMesh, buildBondMesh, buildPieceMesh, placedPiece } from './pieceMeshes';

export type { SurfaceHit };

export interface GarageHandlers {
  /** A tap or click that did not turn the view. */
  tap(target: PointerTarget): void;
  /** Dragging a piece started from `grabPoint` on it. */
  dragStart(id: string, grabPoint: Vec3): void;
  /** A piece is being dragged (`drop` once let go). */
  drag(id: string, target: PointerTarget): void;
  drop(id: string, target: PointerTarget): void;
  /** Dragging was cancelled before drop. */
  cancelDrag(): void;
  /** May this piece be dragged? */
  canDrag(id: string): boolean;
  /** The pieces that move when this one is dragged: it (or the part it is in), and what hangs on it alone. */
  group(id: string): string[];
}

const TARGET = new THREE.Vector3(0, 0.12, 0);
const TAP_MOVE = 6;

export class GarageView {
  private renderer: any;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(34, 1, 0.02, 30);
  private car = new THREE.Group();
  private base: any;
  private pieces = new Map<string, any>();
  /**
   * What the pointer is tested against: invisible boxes where the solids are (as the rules see
   * them), not the pictures, so a stud or a pencil tip never turns a top into a wall.
   */
  private hitBoxes = new THREE.Group();
  private hitMaterial = new THREE.MeshBasicMaterial({ visible: false });
  private ghost: any = null;
  private ghostKey = '';
  private selected = new Set<string>();
  private raycaster = new THREE.Raycaster();
  private resize: ResizeObserver;
  private yaw = -0.75;
  private pitch = 0.5;
  private distance = 1.45;
  private pointers = new Map<number, { x: number; y: number; startX: number; startY: number; t: number }>();
  private dragging: string | null = null;
  private dragGroup: string[] = [];
  private dragGrab: Vec3 | null = null;
  private dragStarted = false;
  private turned = false;
  private pinch = 0;
  private hidden: string[] = [];
  private viewListeners = new Set<() => void>();
  private viewDirty = true;

  constructor(
    private host: HTMLElement,
    private player: PlayerId,
    private handlers: GarageHandlers,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    const canvas = this.renderer.domElement as HTMLCanvasElement;
    canvas.className = 'garage-canvas';
    canvas.setAttribute('aria-label', '組み立て中の車。ドラッグで回して見られます');
    canvas.setAttribute('role', 'img');
    host.appendChild(canvas);

    this.scene.add(new THREE.HemisphereLight('#FFFFFF', '#94A3B8', 1.6));
    const sun = new THREE.DirectionalLight('#FFF4E0', 2.4);
    sun.position.set(1.2, 2.4, 1.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -0.7, right: 0.7, top: 0.7, bottom: -0.7, near: 0.5, far: 6 });
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight('#BAE6FD', 0.9);
    rim.position.set(-1.5, 1, -1.8);
    this.scene.add(rim);

    this.buildTurntable();
    this.base = buildBaseMesh(player);
    this.base.traverse((o: any) => (o.userData.target = BASE));
    this.car.add(this.base);
    this.scene.add(this.car);
    this.scene.add(this.hitBoxes);
    this.setHitBoxes(null);

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.renderer.setAnimationLoop(this.frame);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.viewListeners.clear();
    this.setPreview(null);
    this.resize.disconnect();
    const canvas = this.renderer.domElement as HTMLCanvasElement;
    canvas.remove();
    this.renderer.dispose();
  }

  private buildTurntable() {
    const stand = new THREE.Group();
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.62, 0.66, 0.05, 64),
      new THREE.MeshStandardMaterial({ color: '#FFFFFF', roughness: 0.5 }),
    );
    disc.position.y = -0.026;
    disc.receiveShadow = true;
    stand.add(disc);
    // Team-colored ring and a few stripes, like a showroom platform.
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.64, 0.012, 8, 72),
      new THREE.MeshStandardMaterial({ color: this.player === 'p1' ? '#EF4444' : '#06B6D4', roughness: 0.4 }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.002;
    stand.add(ring);
    const grid = new THREE.Mesh(
      new THREE.RingGeometry(0.2, 0.56, 64, 1),
      new THREE.MeshStandardMaterial({ color: '#E2E8F0', roughness: 0.8 }),
    );
    grid.rotation.x = -Math.PI / 2;
    grid.position.y = 0.0005;
    grid.receiveShadow = true;
    stand.add(grid);
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 0.74, 0.08, 64),
      new THREE.MeshStandardMaterial({ color: '#CBD5E1', roughness: 0.6 }),
    );
    base.position.y = -0.09;
    stand.add(base);
    this.scene.add(stand);
  }

  private fit() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // On a tall phone screen the panels take the bottom: the car is drawn a little higher.
    if (w / h < 0.8) this.camera.setViewOffset(w, h, 0, h * 0.07, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.viewDirty = true;
  }

  private frame = () => {
    // Narrow screens see the car from further away, so that all of it fits across.
    const narrow = Math.min(2.2, Math.max(1, 0.95 / this.camera.aspect));
    const d = this.distance * narrow;
    this.camera.position.set(
      TARGET.x + d * Math.cos(this.pitch) * Math.sin(this.yaw),
      TARGET.y + d * Math.sin(this.pitch),
      TARGET.z + d * Math.cos(this.pitch) * Math.cos(this.yaw),
    );
    this.camera.lookAt(TARGET);
    this.camera.updateMatrixWorld();
    if (this.viewDirty) {
      this.viewDirty = false;
      for (const fn of this.viewListeners) fn();
    }
    if (this.ghost) {
      const t = performance.now() / 1000;
      this.ghost.userData.pulse?.forEach((m: any) => (m.opacity = 0.5 + Math.sin(t * 6) * 0.12));
    }
    this.renderer.render(this.scene, this.camera);
  };

  /** Turns the view by the given angles (radians), e.g. from buttons. */
  orbit(dYaw: number, dPitch = 0) {
    this.yaw += dYaw;
    this.pitch = Math.min(1.45, Math.max(0.05, this.pitch + dPitch));
    this.viewDirty = true;
  }

  zoom(factor: number) {
    this.distance = Math.min(2.6, Math.max(0.7, this.distance * factor));
    this.viewDirty = true;
  }

  onCameraChange(fn: () => void): () => void {
    this.viewListeners.add(fn);
    return () => {
      this.viewListeners.delete(fn);
    };
  }

  projectPoint(p: Vec3): { x: number; y: number; visible: boolean } {
    const canvas = this.renderer.domElement as HTMLCanvasElement;
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    const cam = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(this.camera.matrixWorldInverse);
    const ndc = cam.clone().applyMatrix4(this.camera.projectionMatrix);
    const x = ((ndc.x + 1) / 2) * w;
    const y = ((1 - ndc.y) / 2) * h;
    return { x, y, visible: cam.z < -0.001 && Number.isFinite(x) && Number.isFinite(y) };
  }

  cameraSnapshot(): { pos: Vec3; width: number; height: number } {
    const canvas = this.renderer.domElement as HTMLCanvasElement;
    const p = this.camera.position;
    return { pos: [p.x, p.y, p.z], width: Math.max(1, canvas.clientWidth), height: Math.max(1, canvas.clientHeight) };
  }

  isPositionDragging() {
    return this.dragging !== null && this.dragStarted;
  }

  /** Projects a screen point into a ray and hit against the car's hit boxes. */
  pickTarget(clientX: number, clientY: number, shift = false): PointerTarget {
    return this.targetAt(clientX, clientY, shift);
  }

  // -------------------------------------------------------------------------
  // What is on the car.
  // -------------------------------------------------------------------------
  private setHitBoxes(design: CarDesign | null) {
    this.hitBoxes.clear();
    const add = (b: SolidBox, target: string) => {
      // Round things are hit where they really are, not on the box around them.
      const geometry =
        b.shape === 'ball'
          ? new THREE.SphereGeometry(b.h[0], 32, 16)
          : b.shape === 'cylinder'
            ? new THREE.CylinderGeometry(b.h[0], b.h[0], b.h[1] * 2, 32)
            : new THREE.BoxGeometry(b.h[0] * 2, b.h[1] * 2, b.h[2] * 2);
      const m = new THREE.Mesh(geometry, this.hitMaterial);
      const q = matrixQuat(b.m);
      m.position.set(...b.c);
      m.quaternion.set(q[0], q[1], q[2], q[3]);
      m.userData.target = target;
      this.hitBoxes.add(m);
    };
    BASE_BOXES.forEach((b) => add(b, BASE));
    WHEEL_BOXES.forEach((b) => add(b, 'wheel'));
    design?.pieces.forEach((p) => add(pieceBox(p), p.id));
    this.hitBoxes.updateMatrixWorld(true);
  }

  setDesign(design: CarDesign) {
    this.setHitBoxes(design);
    for (const g of this.pieces.values()) this.car.remove(g);
    this.pieces.clear();
    for (const piece of design.pieces) {
      const g = new THREE.Group();
      g.add(placedPiece(piece, this.player));
      g.traverse((o: any) => (o.userData.target = piece.id));
      this.car.add(g);
      this.pieces.set(piece.id, g);
    }
    for (const joint of design.joints) {
      const bond = jointBond(design, joint);
      const g = this.pieces.get(joint.b) ?? this.pieces.get(joint.a);
      if (!bond || !g) continue;
      const m = buildBondMesh(bond);
      // Not something to click on.
      m.raycast = () => {};
      g.add(m);
    }
    this.highlight();
    this.hide(this.hidden);
    this.viewDirty = true;
  }

  /** The pieces picked: one, or all of a part made of pieces. */
  select(ids: readonly string[]) {
    this.selected = new Set(ids);
    this.highlight();
    this.viewDirty = true;
  }

  /** While pieces are dragged, they are left out (their ghosts show where they go). */
  hide(ids: string[]) {
    const same = ids.length === this.hidden.length && ids.every((id, i) => id === this.hidden[i]);
    if (same) return;
    this.hidden = ids;
    for (const [pid, g] of this.pieces) g.visible = !ids.includes(pid);
    this.viewDirty = true;
  }

  private highlight() {
    for (const [id, g] of this.pieces) {
      const on = this.selected.has(id);
      g.traverse((o: any) => {
        if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
        if (on && !o.userData.lit) {
          o.userData.lit = o.material;
          o.material = o.material.clone();
          o.material.emissive = new THREE.Color('#FACC15');
          o.material.emissiveIntensity = 0.35;
        } else if (!on && o.userData.lit) {
          o.material.dispose();
          o.material = o.userData.lit;
          o.userData.lit = null;
        }
      });
    }
  }

  /**
   * The piece in hand (or the pieces being moved), where they would go: green when they can,
   * red when they cannot.
   */
  setGhost(pieces: Pick<BodyPiece, 'kind' | 'made' | 'x' | 'y' | 'z' | 'rot'>[] | null, ok = true) {
    this.setPreview(pieces, ok ? 'ok' : 'bad');
  }

  /**
   * Fast preview of pieces being moved or rotated: keeps geometry/materials across frames
   * while updating only transforms, and only disposes materials it created or cloned.
   */
  setPreview(pieces: Pick<BodyPiece, 'kind' | 'made' | 'x' | 'y' | 'z' | 'rot'>[] | null, mode: 'ok' | 'bad' | 'solid' = 'ok') {
    const key = pieces?.length ? `${pieces.map((p) => partKey(p)).join('/')}|${mode}` : '';
    if (key !== this.ghostKey) {
      if (this.ghost) {
        this.car.remove(this.ghost);
        (this.ghost.userData.ownedMaterials as any[] | undefined)?.forEach((m) => m.dispose());
      }
      this.ghost = null;
      this.ghostKey = key;
      if (pieces?.length) {
        this.ghost = new THREE.Group();
        const ownedMaterials: any[] = [];
        const pulse: any[] = [];
        for (const piece of pieces) {
          const g = buildPieceMesh(piece, this.player);
          g.traverse((o: any) => {
            if (!o.isMesh) {
              if (mode !== 'solid' && o.isLineSegments) o.visible = false;
              return;
            }
            o.raycast = () => {};
            if (mode === 'solid') {
              if (!o.material) return;
              const tint = (m: any) => {
                const c = m.clone();
                c.emissive = new THREE.Color('#FACC15');
                c.emissiveIntensity = 0.35;
                ownedMaterials.push(c);
                return c;
              };
              o.material = Array.isArray(o.material) ? o.material.map(tint) : tint(o.material);
              return;
            }
            o.castShadow = false;
            const m = new THREE.MeshStandardMaterial({
              color: mode === 'ok' ? '#4ADE80' : '#F87171',
              emissive: mode === 'ok' ? '#22C55E' : '#EF4444',
              emissiveIntensity: 0.5,
              transparent: true,
              opacity: 0.55,
              depthWrite: false,
            });
            o.material = m;
            ownedMaterials.push(m);
            pulse.push(m);
          });
          this.ghost.add(g);
        }
        this.ghost.userData.ownedMaterials = ownedMaterials;
        this.ghost.userData.pulse = pulse;
        this.car.add(this.ghost);
      }
    }
    if (pieces && this.ghost) {
      pieces.forEach((piece, i) => {
        const inner = this.ghost.children[i];
        const q = orientationQuat(piece.rot);
        inner.position.set(piece.x, piece.y, piece.z);
        inner.quaternion.set(q.x, q.y, q.z, q.w);
      });
    }
  }

  // -------------------------------------------------------------------------
  // The pointer.
  // -------------------------------------------------------------------------
  private targetAt(clientX: number, clientY: number, shift: boolean, skip: string[] = []): PointerTarget {
    const rect = (this.renderer.domElement as HTMLCanvasElement).getBoundingClientRect();
    const w = rect.width || 1;
    const h = rect.height || 1;
    const ndc = new THREE.Vector2(((clientX - rect.left) / w) * 2 - 1, -((clientY - rect.top) / h) * 2 + 1);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);
    const { origin, direction } = this.raycaster.ray;
    const ray: PointerRay = { origin: [origin.x, origin.y, origin.z], dir: [direction.x, direction.y, direction.z] };
    const targets = this.hitBoxes.children.filter((m: any) => !skip.includes(m.userData.target));
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    // The wheels only stop the ray: nothing is stuck to them.
    if (!hit?.face || hit.object.userData.target === 'wheel') return { hit: null, ray, shift };
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    // The car sits at the origin, so world is car space.
    return {
      hit: { point: [hit.point.x, hit.point.y, hit.point.z], normal: tidyNormal([n.x, n.y, n.z]), target: hit.object.userData.target },
      ray,
      shift,
    };
  }

  private onDown = (e: PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, t: performance.now() });
    this.turned = false;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
      this.cancelDrag();
      return;
    }
    const { hit } = this.targetAt(e.clientX, e.clientY, e.shiftKey);
    if (hit && hit.target !== BASE && this.handlers.canDrag(hit.target)) {
      this.dragging = hit.target;
      this.dragGroup = this.handlers.group(hit.target);
      this.dragGrab = hit.point;
      this.dragStarted = false;
    }
  };

  private onMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch > 0) this.zoom(this.pinch / d);
      this.pinch = d;
      this.turned = true;
      return;
    }
    const moved = Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > TAP_MOVE;
    if (this.dragging) {
      if (!moved && !this.dragStarted) return;
      if (!this.dragStarted) {
        this.dragStarted = true;
        // What moves with it is not something to put it on.
        this.hide(this.dragGroup);
        this.handlers.dragStart(this.dragging, this.dragGrab!);
      }
      this.handlers.drag(this.dragging, this.targetAt(e.clientX, e.clientY, e.shiftKey, this.dragGroup));
      return;
    }
    if (moved) this.turned = true;
    if (this.turned) this.orbit(-dx * 0.008, dy * 0.006);
  };

  private onUp = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (!p) return;
    if (this.dragging) {
      if (e.type === 'pointercancel') {
        this.cancelDrag();
        return;
      }
      const id = this.dragging;
      const group = this.dragGroup;
      const wasDragged = this.dragStarted;
      this.dragging = null;
      this.dragGrab = null;
      this.dragStarted = false;
      this.hide([]);
      if (wasDragged) {
        this.handlers.drop(id, this.targetAt(e.clientX, e.clientY, e.shiftKey, group));
        return;
      }
    }
    if (e.type === 'pointercancel') return;
    const tap = !this.turned && performance.now() - p.t < 600;
    if (tap && this.pointers.size === 0) this.handlers.tap(this.targetAt(e.clientX, e.clientY, e.shiftKey));
  };

  private cancelDrag() {
    if (!this.dragging) return;
    this.dragging = null;
    this.dragGrab = null;
    this.dragStarted = false;
    this.hide([]);
    this.setPreview(null);
    this.handlers.cancelDrag();
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoom(Math.exp(e.deltaY * 0.0012));
  };
}

/** Tells parts apart: a tray thing by its kind, a made-up one by all it is. */
export const partKey = (t: PartType) => (t.kind === 'made' ? `made:${JSON.stringify(t.made ?? null)}` : t.kind);

/** Small pictures of the pieces for the tray, drawn once per part and car color. */
const thumbs = new Map<string, string>();
let thumbRenderer: { renderer: any; scene: any; camera: any } | null = null;

function thumbStage() {
  if (thumbRenderer) return thumbRenderer;
  const size = 160;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(size, size, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#FFFFFF', '#64748B', 2));
  const sun = new THREE.DirectionalLight('#FFFFFF', 2.2);
  sun.position.set(1, 2, 1.5);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 10);
  thumbRenderer = { renderer, scene, camera };
  return thumbRenderer;
}

/** A picture of a group of meshes, framed to fit, as a data URL ('' when it cannot be drawn). */
function snapshot(g: any) {
  try {
    const { renderer, scene, camera } = thumbStage();
    scene.add(g);
    const box = new THREE.Box3().setFromObject(g);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const d = (sphere.radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.05;
    camera.position.set(sphere.center.x + d * 0.55, sphere.center.y + d * 0.55, sphere.center.z + d * 0.63);
    camera.lookAt(sphere.center);
    renderer.render(scene, camera);
    const url = (renderer.domElement as HTMLCanvasElement).toDataURL('image/png');
    scene.remove(g);
    return url;
  } catch (err) {
    console.error(err);
    return '';
  }
}

/**
 * A picture of one part, as a data URL ('' when it cannot be drawn). `keep` false draws it
 * without keeping it (a part still being made changes with every slider step).
 */
export function pieceThumbnail(type: PartType, player: PlayerId, keep = true) {
  const key = `${player}|${partKey(type)}`;
  const cached = thumbs.get(key);
  if (cached !== undefined) return cached;
  const g = buildPieceMesh(type, player);
  // Long things lie down and turn a little, so they read in a square.
  const spec = specOf(type);
  if (spec.lying) g.rotation.set(Math.PI / 2, 0, -Math.PI / 4);
  else if (spec.shape.kind === 'box') g.rotation.y = -Math.PI / 4;
  const url = snapshot(g);
  if (keep) thumbs.set(key, url);
  return url;
}

/** A picture of a part made of parts, as it is put on a car, turned a little. */
export function assemblyThumbnail(assembly: Assembly, player: PlayerId) {
  const key = `${player}|asm:${JSON.stringify(assembly.pieces)}`;
  const cached = thumbs.get(key);
  if (cached !== undefined) return cached;
  const g = new THREE.Group();
  for (const piece of assembly.pieces) g.add(placedPiece(piece, player));
  g.rotation.y = -Math.PI / 4;
  const url = snapshot(g);
  thumbs.set(key, url);
  return url;
}

/** A picture of a whole car body (chassis, pieces, and bonds) from front-right above. */
export function designThumbnail(design: CarDesign, player: PlayerId, keep = true) {
  const key = `${player}|car:${JSON.stringify(design)}`;
  if (keep) {
    const cached = thumbs.get(key);
    if (cached !== undefined) return cached;
  }
  const g = new THREE.Group();
  g.add(buildBaseMesh(player));
  for (const piece of design.pieces) g.add(placedPiece(piece, player));
  for (const joint of design.joints) {
    const bond = jointBond(design, joint);
    if (bond) g.add(buildBondMesh(bond));
  }
  const url = snapshot(g);
  if (keep) thumbs.set(key, url);
  return url;
}
