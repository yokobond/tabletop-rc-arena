/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The garage's 3D view: its own small three.js renderer (the arena scene keeps running behind it),
 * a car on a turntable, and the pointer. It only shows things and reports what the pointer is on;
 * the garage panel (ui/Garage.tsx) decides what that means.
 */
import { BASE, BASE_BOXES, WHEEL_BOXES, jointBond, matrixQuat, pieceBox, tidyNormal, type BodyPiece, type CarDesign, type PartType, type SolidBox, type Vec3, specOf } from '../game/bodyParts';
import type { PlayerId } from '../game/types';
import { THREE } from './helpers';
import { buildBaseMesh, buildBondMesh, buildPieceMesh, placedPiece } from './pieceMeshes';

/** What the pointer is on: a point of a surface, its outward direction, and whose surface. */
export interface SurfaceHit {
  point: Vec3;
  normal: Vec3;
  target: string;
}

export interface GarageHandlers {
  /** A tap or click that did not turn the view. */
  tap(hit: SurfaceHit | null): void;
  /** The mouse moved over the car without a button down. */
  hover(hit: SurfaceHit | null): void;
  /** A piece is being dragged (`drop` once let go). */
  drag(id: string, hit: SurfaceHit | null): void;
  drop(id: string, hit: SurfaceHit | null): void;
  /** May this piece be dragged? */
  canDrag(id: string): boolean;
  /** The pieces that move when this one is dragged: it, and what hangs on it alone. */
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
  private selected: string | null = null;
  private raycaster = new THREE.Raycaster();
  private resize: ResizeObserver;
  private yaw = -0.75;
  private pitch = 0.5;
  private distance = 1.45;
  private pointers = new Map<number, { x: number; y: number; startX: number; startY: number; t: number }>();
  private dragging: string | null = null;
  private dragGroup: string[] = [];
  private turned = false;
  private pinch = 0;
  private hidden: string[] = [];

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
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.renderer.setAnimationLoop(this.frame);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
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
  }

  zoom(factor: number) {
    this.distance = Math.min(2.6, Math.max(0.7, this.distance * factor));
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
  }

  select(id: string | null) {
    this.selected = id;
    this.highlight();
  }

  /** While pieces are dragged, they are left out (their ghosts show where they go). */
  hide(ids: string[]) {
    this.hidden = ids;
    for (const [pid, g] of this.pieces) g.visible = !ids.includes(pid);
  }

  private highlight() {
    for (const [id, g] of this.pieces) {
      const on = id === this.selected;
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
  setGhost(pieces: Pick<BodyPiece, 'kind' | 'x' | 'y' | 'z' | 'rot'>[] | null, ok = true) {
    const key = pieces?.length ? `${pieces.map((p) => `${partKey(p)}|${p.rot}`).join('/')}|${ok}` : '';
    if (key !== this.ghostKey) {
      if (this.ghost) this.car.remove(this.ghost);
      this.ghost = null;
      this.ghostKey = key;
      if (pieces?.length) {
        this.ghost = new THREE.Group();
        const pulse: any[] = [];
        for (const piece of pieces) {
          const g = buildPieceMesh(piece, this.player);
          g.traverse((o: any) => {
            if (o.isLineSegments) o.visible = false;
            if (!o.isMesh) return;
            o.castShadow = false;
            o.raycast = () => {};
            o.material = new THREE.MeshStandardMaterial({
              color: ok ? '#4ADE80' : '#F87171',
              emissive: ok ? '#22C55E' : '#EF4444',
              emissiveIntensity: 0.5,
              transparent: true,
              opacity: 0.55,
              depthWrite: false,
            });
            pulse.push(o.material);
          });
          this.ghost.add(g);
        }
        this.ghost.userData.pulse = pulse;
        this.car.add(this.ghost);
      }
    }
    if (pieces && this.ghost) {
      pieces.forEach((piece, i) => {
        const inner = this.ghost.children[i];
        const placed = placedPiece({ ...piece }, this.player);
        inner.position.copy(placed.position);
        inner.quaternion.copy(placed.quaternion);
      });
    }
  }

  // -------------------------------------------------------------------------
  // The pointer.
  // -------------------------------------------------------------------------
  private hitAt(clientX: number, clientY: number, skip: string[] = []): SurfaceHit | null {
    const rect = (this.renderer.domElement as HTMLCanvasElement).getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets = this.hitBoxes.children.filter((m: any) => !skip.includes(m.userData.target));
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    // The wheels only stop the ray: nothing is stuck to them.
    if (!hit?.face || hit.object.userData.target === 'wheel') return null;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    // The car sits at the origin, so world is car space.
    return { point: [hit.point.x, hit.point.y, hit.point.z], normal: tidyNormal([n.x, n.y, n.z]), target: hit.object.userData.target };
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
    const hit = this.hitAt(e.clientX, e.clientY);
    if (hit && hit.target !== BASE && this.handlers.canDrag(hit.target)) {
      this.dragging = hit.target;
      this.dragGroup = this.handlers.group(hit.target);
    }
  };

  private onMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse') this.handlers.hover(this.hitAt(e.clientX, e.clientY));
      return;
    }
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
      if (!moved && !this.hidden.length) return;
      // What moves with it is not something to put it on.
      this.hide(this.dragGroup);
      this.handlers.drag(this.dragging, this.hitAt(e.clientX, e.clientY, this.dragGroup));
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
      const id = this.dragging;
      const group = this.dragGroup;
      const wasDragged = this.hidden.length > 0;
      this.dragging = null;
      this.hide([]);
      if (wasDragged) {
        this.handlers.drop(id, this.hitAt(e.clientX, e.clientY, group));
        return;
      }
    }
    const tap = !this.turned && performance.now() - p.t < 600;
    if (tap && this.pointers.size === 0) this.handlers.tap(this.hitAt(e.clientX, e.clientY));
  };

  private onLeave = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && !this.pointers.size) this.handlers.hover(null);
  };

  private cancelDrag() {
    if (!this.dragging) return;
    this.dragging = null;
    this.hide([]);
    this.handlers.hover(null);
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

/**
 * A picture of one part, as a data URL ('' when it cannot be drawn). `keep` false draws it
 * without keeping it (a part still being made changes with every slider step).
 */
export function pieceThumbnail(type: PartType, player: PlayerId, keep = true) {
  const key = `${player}|${partKey(type)}`;
  const cached = thumbs.get(key);
  if (cached !== undefined) return cached;
  let url = '';
  try {
    const { renderer, scene, camera } = thumbStage();
    const g = buildPieceMesh(type, player);
    // Long things lie down and turn a little, so they read in a square.
    const spec = specOf(type);
    if (spec.lying) g.rotation.set(Math.PI / 2, 0, -Math.PI / 4);
    else if (spec.shape.kind === 'box') g.rotation.y = -Math.PI / 4;
    scene.add(g);
    const box = new THREE.Box3().setFromObject(g);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const d = (sphere.radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.05;
    camera.position.set(sphere.center.x + d * 0.55, sphere.center.y + d * 0.55, sphere.center.z + d * 0.63);
    camera.lookAt(sphere.center);
    renderer.render(scene, camera);
    url = (renderer.domElement as HTMLCanvasElement).toDataURL('image/png');
    scene.remove(g);
  } catch (err) {
    console.error(err);
  }
  if (keep) thumbs.set(key, url);
  return url;
}
