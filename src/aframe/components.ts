/* eslint-disable @typescript-eslint/no-explicit-any */
import { RESPAWN_HOVER_Y, FIXED_STEP, MAX_BOOST_SPEED, TABLE_HALF_X, TABLE_HALF_Z, TABLE_THICKNESS, FLOOR_Y, tableHalfX } from '../game/constants';
import type { ArenaList } from '../game/arena';
import type { CameraPreset, CarInput, GameEvent, PlayerId, PropDefinition, StageDefinition, StaticObstacle, TableArt } from '../game/types';
import { NO_INPUT } from '../game/types';
import { audio } from '../runtime/audio';
import { input } from '../runtime/input';
import { currentView, isOnline, onlineHooks } from '../net/session';
import {
  getCpu,
  heldForSettings,
  getEngine,
  getState,
  playerName,
  publishTelemetry,
  showFallBanner,
  showGoFlash,
  subscribe,
} from '../runtime/store';
import { AFRAME, THREE, applyCanvasTexture } from './helpers';
import { CAR_COLORS, buildBooks, buildCar, buildMug, buildProp, buildRamp, ent, type CarParts } from './models';
import { jointBond, type CarDesign } from '../game/bodyParts';
import { buildBondMesh, placedPiece } from './pieceMeshes';
import { meshFor, meshVersion } from '../runtime/meshStore';
import { resolveArtImage } from '../runtime/tableArt';
import { VR_WORLD_SCALE, pulseControllers } from './vr';
import './ar';
import './editor';
import { floorTexture, makeCanvas, sparkTexture, skyTexture, tableTexture, woodSideTexture } from './textures';

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// ---------------------------------------------------------------------------
// Sparks: a pooled point cloud, so that a heavy crash never allocates.
// ---------------------------------------------------------------------------
const SPARK_COUNT = 360;
const SPARK_SIZE = 0.075;
const sparks = {
  positions: new Float32Array(SPARK_COUNT * 3),
  colors: new Float32Array(SPARK_COUNT * 3),
  velocities: new Float32Array(SPARK_COUNT * 3),
  life: new Float32Array(SPARK_COUNT),
  maxLife: new Float32Array(SPARK_COUNT),
  next: 0,
};
const tmpColor = new THREE.Color();

function emitSparks(x: number, y: number, z: number, count: number, color: number, speed: number, up = 1) {
  tmpColor.set(color);
  for (let n = 0; n < count; n++) {
    const i = sparks.next;
    sparks.next = (i + 1) % SPARK_COUNT;
    const angle = Math.random() * Math.PI * 2;
    const v = speed * (0.3 + Math.random() * 0.8);
    sparks.positions[i * 3] = x;
    sparks.positions[i * 3 + 1] = y;
    sparks.positions[i * 3 + 2] = z;
    sparks.velocities[i * 3] = Math.cos(angle) * v;
    sparks.velocities[i * 3 + 1] = up * (0.4 + Math.random()) * speed * 0.7;
    sparks.velocities[i * 3 + 2] = Math.sin(angle) * v;
    sparks.colors[i * 3] = tmpColor.r;
    sparks.colors[i * 3 + 1] = tmpColor.g;
    sparks.colors[i * 3 + 2] = tmpColor.b;
    sparks.maxLife[i] = sparks.life[i] = 0.3 + Math.random() * 0.45;
  }
}

AFRAME.registerComponent('spark-burst', {
  init(this: any) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(sparks.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(sparks.colors, 3));
    this.geometry = geometry;
    const texture = new THREE.CanvasTexture(sparkTexture());
    const material = new THREE.PointsMaterial({
      size: SPARK_SIZE,
      map: texture,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    // Point sizes ignore the scale of the VR rig, unlike everything else in the view.
    this.el.sceneEl.addEventListener('enter-vr', () => (material.size = SPARK_SIZE * VR_WORLD_SCALE));
    this.el.sceneEl.addEventListener('exit-vr', () => (material.size = SPARK_SIZE));
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    for (let i = 0; i < SPARK_COUNT; i++) sparks.positions[i * 3 + 1] = -99;
    this.el.setObject3D('mesh', points);
  },
  tick(this: any, _t: number, dtMs: number) {
    const dt = Math.min(dtMs / 1000, 0.05);
    for (let i = 0; i < SPARK_COUNT; i++) {
      if (sparks.life[i] <= 0) continue;
      sparks.life[i] -= dt;
      if (sparks.life[i] <= 0) {
        sparks.positions[i * 3 + 1] = -99;
        continue;
      }
      sparks.velocities[i * 3 + 1] -= 6 * dt;
      sparks.positions[i * 3] += sparks.velocities[i * 3] * dt;
      sparks.positions[i * 3 + 1] += sparks.velocities[i * 3 + 1] * dt;
      sparks.positions[i * 3 + 2] += sparks.velocities[i * 3 + 2] * dt;
      // Additive blending: fading the color fades the particle.
      const fade = 1 - dt * 3.2;
      sparks.colors[i * 3] *= fade;
      sparks.colors[i * 3 + 1] *= fade;
      sparks.colors[i * 3 + 2] *= fade;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  },
});

// ---------------------------------------------------------------------------
// Camera shake is requested by the manager and consumed by the rig.
// ---------------------------------------------------------------------------
let shake = 0;

const CAMERA_PRESETS: Record<CameraPreset, { elevation: number; azimuth: number; distance: number }> = {
  high: { elevation: 74, azimuth: 0, distance: 6.3 },
  angled: { elevation: 50, azimuth: 0, distance: 6.2 },
  low: { elevation: 19, azimuth: 0, distance: 5.9 },
};

const VIEW_TARGET_Z = 0.06;
/** How far from its middle the key light's shadow reaches on the standard table (see GameScene). */
const SHADOW_REACH = 4.5;
/** `lift` moves the table up the screen, clear of the editor's panel: more on a tall, narrow screen. */
const EDIT_VIEW = { elevation: 72, distance: 7.4, lift: 0.1, liftPortrait: 0.16 };

AFRAME.registerComponent('camera-rig', {
  init(this: any) {
    const p = CAMERA_PRESETS.angled;
    this.elevation = 34;
    this.azimuth = 30;
    this.distance = p.distance + 1.4;
    this.time = 0;
    this.eye = new THREE.Vector3();
    this.target = new THREE.Vector3(0, -0.05, VIEW_TARGET_Z);
    this.up = new THREE.Vector3(0, 1, 0);
    this.matrix = new THREE.Matrix4();
    this.reducedMotion = prefersReducedMotion();
  },
  tick(this: any, _t: number, dtMs: number) {
    // In a headset this entity is the rig that vr-session positions; the player's head moves the view.
    // In AR, ar-session puts it where the device is.
    if (this.el.sceneEl.is('vr-mode') || getState().arActive) return;
    const dt = Math.min(dtMs / 1000, 0.05);
    this.time += dt;
    const s = getState();
    const preset = CAMERA_PRESETS[s.cameraPreset];
    // The arena editor needs a still view from above: things are dragged on the table through it.
    const editing = s.editing;
    const idle = s.phase === 'idle' && !this.reducedMotion && !editing;

    const wantElevation = editing ? EDIT_VIEW.elevation : Math.max(8, Math.min(88, preset.elevation + s.cameraHeight * 38));
    const wantAzimuth = editing ? 0 : preset.azimuth + s.cameraAngle + (idle ? Math.sin(this.time * 0.22) * 16 : 0);

    // Fit the table in narrow viewports; horizontal FOV shrinks with the aspect ratio.
    // Before the first layout the aspect can be 0 or NaN; one bad frame would poison the easing for good.
    const rawAspect = this.el.sceneEl.camera?.aspect;
    const aspect = Number.isFinite(rawAspect) && rawAspect > 0 ? rawAspect : 1.6;
    const fitHalfWidth = tableHalfX(s.stage) + 0.35;
    const fov = ((this.el.getAttribute('camera')?.fov ?? 42) * Math.PI) / 180;
    const fitDistance = fitHalfWidth / (Math.tan(fov / 2) * aspect) + 1;
    // The presets frame the standard table; a larger one is seen from further away, framed the same.
    const wantDistance = Math.max((editing ? EDIT_VIEW.distance : preset.distance) * s.stage.tableScale, fitDistance);

    const k = 1 - Math.exp(-4.5 * dt);
    // While editing, look at a point nearer the viewer than the middle of the table.
    // The further away the camera, the further the point has to move for the same shift on screen.
    const lift = wantDistance * (aspect < 1 ? EDIT_VIEW.liftPortrait : EDIT_VIEW.lift);
    this.target.z += ((editing ? lift : VIEW_TARGET_Z) - this.target.z) * k;
    this.elevation += (wantElevation - this.elevation) * k;
    this.azimuth += (wantAzimuth - this.azimuth) * k;
    this.distance += (wantDistance - this.distance) * k;
    if (!Number.isFinite(this.distance)) this.distance = preset.distance;
    if (!Number.isFinite(this.elevation)) this.elevation = wantElevation;
    if (!Number.isFinite(this.azimuth)) this.azimuth = wantAzimuth;

    const el = (this.elevation * Math.PI) / 180;
    const az = (this.azimuth * Math.PI) / 180;
    this.eye.set(
      Math.sin(az) * Math.cos(el) * this.distance,
      Math.sin(el) * this.distance,
      Math.cos(az) * Math.cos(el) * this.distance,
    );
    this.eye.add(this.target);

    const object = this.el.object3D;
    object.position.copy(this.eye);
    if (shake > 0.001 && !this.reducedMotion) {
      object.position.x += (Math.random() - 0.5) * shake;
      object.position.y += (Math.random() - 0.5) * shake;
      object.position.z += (Math.random() - 0.5) * shake;
    }
    shake *= Math.exp(-9 * dt);
    this.matrix.lookAt(object.position, this.target, this.up);
    object.quaternion.setFromRotationMatrix(this.matrix);
  },
});

// ---------------------------------------------------------------------------
// The room, the table and the painted arena.
// ---------------------------------------------------------------------------
AFRAME.registerComponent('tabletop-arena', {
  init(this: any) {
    const root = this.el;
    // The room around the table; in AR the real room is there instead.
    const room: any[] = [];
    const tableW = TABLE_HALF_X * 2;
    const tableD = TABLE_HALF_Z * 2;

    const sky = ent(root, {
      geometry: 'primitive: sphere; radius: 40; segmentsWidth: 16; segmentsHeight: 12',
      material: 'shader: flat; side: back; fog: false',
      cast: false,
    });
    applyCanvasTexture(sky, skyTexture());
    room.push(sky);

    const floor = ent(root, {
      geometry: 'primitive: plane; width: 30; height: 30',
      material: 'roughness: 0.92',
      position: `0 ${FLOOR_Y} 0`,
      rotation: '-90 0 0',
      cast: false,
      receive: true,
    });
    applyCanvasTexture(floor, floorTexture());
    room.push(floor);

    // Rug under the table.
    const rug = ent(root, {
      geometry: 'primitive: plane; width: 7.4; height: 5.4',
      material: 'color: #2E3A4F; roughness: 1',
      position: `0 ${FLOOR_Y + 0.006} 0`,
      rotation: '-90 0 0',
      cast: false,
      receive: true,
    });
    room.push(rug);

    const top = ent(root, {
      geometry: `primitive: box; width: ${tableW}; height: ${TABLE_THICKNESS}; depth: ${tableD}`,
      material: 'roughness: 0.55; metalness: 0.02',
      position: `0 ${-TABLE_THICKNESS / 2} 0`,
      receive: true,
    });
    this.top = top;
    this.rug = rug;
    this.artKey = '';
    this.showArt(getState().stage.art);

    // Apron and legs.
    const apron = `primitive: box; width: ${tableW - 0.3}; height: 0.2; depth: ${tableD - 0.3}`;
    const apronEl = ent(root, {
      geometry: apron,
      material: 'color: #7C4A22; roughness: 0.7',
      position: `0 ${-TABLE_THICKNESS - 0.1} 0`,
    });
    applyCanvasTexture(apronEl, woodSideTexture());
    room.push(apronEl);
    this.apron = apronEl;
    const legHeight = -FLOOR_Y - TABLE_THICKNESS;
    this.legs = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = ent(root, {
          geometry: `primitive: box; width: 0.18; height: ${legHeight}; depth: 0.18`,
          material: 'color: #6B3F1D; roughness: 0.7',
          position: `${sx * (TABLE_HALF_X - 0.24)} ${FLOOR_Y + legHeight / 2} ${sz * (TABLE_HALF_Z - 0.24)}`,
        });
        applyCanvasTexture(leg, woodSideTexture());
        room.push(leg);
        this.legs.push({ el: leg, sx, sz, y: FLOOR_Y + legHeight / 2 });
      }
    }
    this.tableScale = 1;
    this.resize(getState().stage.tableScale);

    // Only the table top is left in AR, lying on the real table like a mat.
    let shown = true;
    this.unsubscribe = subscribe(() => {
      const s = getState();
      this.showArt(s.stage.art);
      this.resize(s.stage.tableScale);
      const show = !s.arActive;
      if (show === shown) return;
      shown = show;
      for (const el of room) el.object3D.visible = show;
    });
  },
  remove(this: any) {
    this.unsubscribe?.();
  },
  /**
   * Makes the table the size the arena says. The parts were built for the standard table: the top
   * and the rug stretch (and the picture with them), the apron and the legs stay as thick as they were.
   */
  resize(this: any, scale: number) {
    if (scale === this.tableScale) return;
    this.tableScale = scale;
    const halfX = TABLE_HALF_X * scale;
    const halfZ = TABLE_HALF_Z * scale;
    // Through the components, so it also holds for an entity that has not initialised yet.
    this.top.setAttribute('scale', `${scale} 1 ${scale}`);
    this.rug.setAttribute('scale', `${scale} ${scale} 1`);
    this.apron.setAttribute('scale', `${(halfX - 0.15) / (TABLE_HALF_X - 0.15)} 1 ${(halfZ - 0.15) / (TABLE_HALF_Z - 0.15)}`);
    for (const leg of this.legs) leg.el.setAttribute('position', `${leg.sx * (halfX - 0.24)} ${leg.y} ${leg.sz * (halfZ - 0.24)}`);
    // The sun's shadow has to reach the corners of the table.
    const reach = SHADOW_REACH * scale;
    this.el.sceneEl.querySelector('#key-light')?.setAttribute('light', {
      shadowCameraLeft: -reach,
      shadowCameraRight: reach,
      shadowCameraTop: reach,
      shadowCameraBottom: -reach,
    });
  },
  /** Paints the table top. A picture may take a moment to arrive; the last design stays until then. */
  showArt(this: any, art: TableArt) {
    const key = art.kind === 'preset' ? art.id : art.src;
    if (key === this.artKey) return;
    const first = this.artKey === '';
    this.artKey = key;
    if (art.kind === 'preset') {
      applyCanvasTexture(this.top, tableTexture(art.id));
      return;
    }
    if (first) applyCanvasTexture(this.top, tableTexture('wood'));
    resolveArtImage(art.src)
      .then((image) => {
        if (this.artKey === key) applyCanvasTexture(this.top, tableTexture(image));
      })
      .catch((err: unknown) => {
        console.error(err);
        // The picture is gone (another device's, or storage was cleared): plain wood rather than a wrong design.
        if (this.artKey === key) applyCanvasTexture(this.top, tableTexture('wood'));
      });
  },
});

// ---------------------------------------------------------------------------
// Stage builder: creates obstacles and props; props follow the simulation.
// ---------------------------------------------------------------------------
const MUG_COLORS = ['#DC2626', '#2563EB', '#16A34A', '#D97706'];

/** One object of the stage as an entity; the arena editor finds it through `userData.arenaItem`. */
interface StageItem {
  list: ArenaList;
  id: string;
  /** Everything but the pose: when this changes the entity is rebuilt, otherwise only moved. */
  shape: string;
  root: any;
}

AFRAME.registerComponent('stage-builder', {
  init(this: any) {
    this.stage = null;
    this.items = new Map<string, StageItem>();
    this.propItems = [];
    /** Id of a prop the arena editor is dragging: it is not put back where physics has it. */
    this.hold = null;
  },
  /**
   * Brings the entities in line with a stage. Objects are matched by id, so editing one thing
   * moves or rebuilds that one entity and leaves the rest alone.
   */
  sync(this: any, stage: StageDefinition) {
    this.stage = stage;
    this.hold = null;
    const items: Map<string, StageItem> = this.items;
    const wanted = new Set<string>();
    for (const o of stage.obstacles) wanted.add(`obstacles:${o.id}`);
    for (const p of stage.props) wanted.add(`props:${p.id}`);
    for (const [key, item] of items) {
      if (wanted.has(key)) continue;
      item.root.remove();
      items.delete(key);
    }

    // `look` picks the colours: the nth mug or stack of books, so every browser paints them alike.
    const place = (list: ArenaList, def: StaticObstacle | PropDefinition, look: number, build: () => any) => {
      const key = `${list}:${def.id}`;
      const shape = JSON.stringify({ ...def, x: 0, z: 0, rotation: 0, angle: 0, look });
      let item = items.get(key);
      if (item && item.shape !== shape) {
        item.root.remove();
        item = undefined;
      }
      if (!item) {
        item = { list, id: def.id, shape, root: build() };
        item.root.object3D.userData.arenaItem = { list, id: def.id };
        items.set(key, item);
      }
      return item;
    };

    const count = { mug: 0, books: 0, ramp: 0 };
    for (const o of stage.obstacles) {
      const look = count[o.kind]++;
      const item = place('obstacles', o, look, () =>
        o.kind === 'mug' ? buildMug(this.el, o, MUG_COLORS[look % MUG_COLORS.length]) : o.kind === 'books' ? buildBooks(this.el, o, look) : buildRamp(this.el, o),
      );
      // Through the component, so it also holds for an entity that has not initialised yet, and
      // directly, so a preview the editor left on the object is undone even if nothing changed.
      item.root.setAttribute('position', `${o.x} 0 ${o.z}`);
      item.root.setAttribute('rotation', `0 ${(o.rotation * 180) / Math.PI} 0`);
      item.root.object3D.position.set(o.x, 0, o.z);
      item.root.object3D.rotation.set(0, o.rotation, 0);
    }
    this.propItems = stage.props.map((p) => place('props', p, 0, () => buildProp(this.el, p).root));
  },
  tick(this: any) {
    const engine = getEngine();
    if (engine.stage !== this.stage) this.sync(engine.stage);
    const smooth = smoothing();
    this.propItems.forEach((item: StageItem, i: number) => {
      const p = engine.props[i];
      if (!p || item.id === this.hold || !item.root.object3D) return;
      followPose(item.root.object3D, p, smooth);
    });
  },
});

// ---------------------------------------------------------------------------
// rc-car-physics: mirrors one simulated car onto its composite entity. The
// simulation itself runs in the manager at a fixed step so both cars share it.
// ---------------------------------------------------------------------------
// Pawn smoothing, like Microverse's PM_Smoothed: online, the model advances in reflector
// ticks, so views ease towards it; a big jump (respawn, teleport) snaps.
const SNAP_DISTANCE = 0.5;
const smoothing = () => (isOnline() ? 0.45 : 1);
const tmpQuat = new THREE.Quaternion();
function followPose(object: any, pose: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number }, k: number) {
  tmpQuat.set(pose.qx, pose.qy, pose.qz, pose.qw);
  const far = Math.hypot(object.position.x - pose.x, object.position.y - pose.y, object.position.z - pose.z) > SNAP_DISTANCE;
  if (k >= 1 || far) {
    object.position.set(pose.x, pose.y, pose.z);
    object.quaternion.copy(tmpQuat);
    return;
  }
  object.position.x += (pose.x - object.position.x) * k;
  object.position.y += (pose.y - object.position.y) * k;
  object.position.z += (pose.z - object.position.z) * k;
  object.quaternion.slerp(tmpQuat, k);
}

const partMatrix = new THREE.Matrix4();
const rootInverse = new THREE.Matrix4();
const unitScale = new THREE.Vector3(1, 1, 1);

// ---------------------------------------------------------------------------
// Name tag over each car: 1P / 2P / CPU, or YOU for this browser's car online.
// ---------------------------------------------------------------------------
const LABEL_W = 256;
const LABEL_H = 160;
const LABEL_HEIGHT = 0.36;
const LABEL_SCALE = 0.42;

function drawLabel(canvas: HTMLCanvasElement, g: CanvasRenderingContext2D, player: PlayerId, name: string, mine: boolean) {
  g.clearRect(0, 0, canvas.width, canvas.height);
  const color = CAR_COLORS[player].body;
  const edge = mine ? '#FACC15' : '#FFFFFF';
  const pillW = mine ? 236 : 200;
  const x = (LABEL_W - pillW) / 2;
  const y = 8;
  const h = 96;
  // Pointer under the tag, aimed at the car.
  g.beginPath();
  g.moveTo(LABEL_W / 2 - 26, y + h - 4);
  g.lineTo(LABEL_W / 2 + 26, y + h - 4);
  g.lineTo(LABEL_W / 2, LABEL_H - 6);
  g.closePath();
  g.fillStyle = edge;
  g.fill();
  g.beginPath();
  g.roundRect(x, y, pillW, h, h / 2);
  g.fillStyle = color;
  g.fill();
  g.lineWidth = 10;
  g.strokeStyle = edge;
  g.stroke();
  g.fillStyle = '#FFFFFF';
  g.font = '800 64px system-ui, -apple-system, "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(15, 23, 42, 0.55)';
  g.strokeText(name, LABEL_W / 2, y + h / 2 + 3);
  g.fillText(name, LABEL_W / 2, y + h / 2 + 3);
}

function createLabel(parent: any) {
  const { canvas, g } = makeCanvas(LABEL_W, LABEL_H);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Drawn over everything, so a tag stays readable behind books and mugs.
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(LABEL_SCALE, (LABEL_SCALE * LABEL_H) / LABEL_W, 1);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 10;
  parent.add(sprite);
  return { sprite, canvas, g, texture, key: '' };
}

AFRAME.registerComponent('rc-car-physics', {
  schema: { player: { type: 'string', default: 'p1' } },
  /**
   * Each part's visual follows the body it is on. Every visual group has its origin at the car
   * origin, and a part that broke off is on a body that started in the chassis' place, so the
   * group simply takes that body's pose (relative to the car).
   */
  placeParts(this: any, engine: ReturnType<typeof getEngine>) {
    const parts: CarParts = this.parts;
    const root = this.el.object3D;
    let rootReady = false;
    for (const { partId, attached, pose } of engine.partPoses(this.player as PlayerId)) {
      const o3 = this.pieceGroups.get(partId) ?? (parts.partEls as any)[partId]?.object3D;
      if (!o3) continue;
      if (attached) {
        if (o3.userData.detached) {
          o3.position.set(0, 0, 0);
          o3.quaternion.identity();
          o3.userData.detached = false;
        }
        continue;
      }
      if (!rootReady) {
        root.updateMatrixWorld();
        rootInverse.copy(root.matrixWorld).invert();
        rootReady = true;
      }
      partMatrix.compose(o3.position.set(pose.x, pose.y, pose.z), tmpQuat.set(pose.qx, pose.qy, pose.qz, pose.qw), unitScale);
      partMatrix.premultiply(rootInverse);
      partMatrix.decompose(o3.position, o3.quaternion, o3.scale);
      o3.userData.detached = true;
    }
    // Tape and hot glue that let go disappear.
    for (const j of engine.physics.joints) {
      if (j.owner !== this.player) continue;
      const bond = this.bondMeshes.get(`${j.a}|${j.b}`);
      if (bond) bond.visible = !j.broken;
    }
  },
  /** Dresses the chassis in a garage body (or the classic shell and wing for null). */
  dress(this: any, design: CarDesign | null) {
    this.design = design;
    const parts: CarParts = this.parts;
    const body = (parts.body as any).object3D;
    for (const g of this.pieceGroups.values()) body.remove(g);
    this.pieceGroups = new Map();
    this.bondMeshes = new Map();
    for (const id of ['shell', 'spoiler'] as const) {
      const o3 = (parts.partEls[id] as any).object3D;
      if (o3) o3.visible = !design;
    }
    // Looks of made-up parts still on their way: their plain shapes stand in until then.
    this.meshWait = (design?.pieces ?? []).map((p) => p.made?.mesh).filter((id): id is string => !!id && !meshFor(id));
    this.meshSeen = meshVersion();
    this.meshPoll = 0;
    if (!design) return;
    for (const piece of design.pieces) {
      const group = new THREE.Group();
      group.add(placedPiece(piece, this.player));
      body.add(group);
      this.pieceGroups.set(piece.id, group);
    }
    // A joint's tape or hot glue rides with the piece that was stuck on.
    for (const joint of design.joints) {
      const bond = jointBond(design, joint);
      const group = this.pieceGroups.get(joint.b) ?? this.pieceGroups.get(joint.a);
      if (!bond || !group) continue;
      const m = buildBondMesh(bond);
      group.add(m);
      this.bondMeshes.set(`${joint.a}|${joint.b}`, m);
    }
  },
  init(this: any) {
    this.player = this.data.player as PlayerId;
    this.parts = buildCar(this.el, this.player) as CarParts;
    this.pieceGroups = new Map();
    this.bondMeshes = new Map();
    this.design = undefined;
    this.time = 0;
    // A pulsing ring on the table marks where the car will land.
    this.marker = ent(this.el.sceneEl, {
      geometry: 'primitive: ring; radiusInner: 0.2; radiusOuter: 0.27; segmentsTheta: 32',
      material: `shader: flat; color: ${CAR_COLORS[this.player as PlayerId].body}; transparent: true; opacity: 0.85; side: double`,
      rotation: '-90 0 0',
      cast: false,
    });
    this.marker.setAttribute('visible', 'false');
    // The tag lives beside the car, not under it, so it stays upright while the car tumbles.
    this.label = createLabel(this.el.object3D.parent ?? this.el.sceneEl.object3D);
  },
  remove(this: any) {
    const label = this.label;
    if (!label) return;
    label.sprite.parent?.remove(label.sprite);
    label.texture.dispose();
    label.sprite.material.dispose();
  },
  updateLabel(this: any, car: { status: string }, blinkOn: boolean) {
    const label = this.label;
    const player = this.player as PlayerId;
    const s = getState();
    const name = playerName(s, player);
    const mine = s.online.status === 'on' && s.online.seat === player;
    const key = `${name}|${mine}`;
    if (key !== label.key) {
      drawLabel(label.canvas, label.g, player, name, mine);
      label.texture.needsUpdate = true;
      label.key = key;
    }
    const object = this.el.object3D;
    const sprite = label.sprite;
    sprite.visible = car.status !== 'falling' && (car.status === 'driving' || blinkOn);
    sprite.position.set(object.position.x, object.position.y + LABEL_HEIGHT, object.position.z);
  },
  tick(this: any, _t: number, dtMs: number) {
    const dt = Math.min(dtMs / 1000, 0.05);
    this.time += dt;
    const engine = getEngine();
    const car = engine.cars[this.player as PlayerId];
    const object = this.el.object3D;
    followPose(object, car, smoothing());
    const design = engine.designs[this.player as PlayerId];
    if ((design !== this.design || (this.meshWait?.length && meshVersion() !== this.meshSeen)) && (this.parts.body as any).object3D) this.dress(design);
    else if (this.meshWait?.length && (this.meshPoll += dt) > 1) {
      // The place of a look may reach the model after the design: ask again now and then.
      this.meshPoll = 0;
      for (const id of this.meshWait) meshFor(id);
    }
    this.placeParts(engine);

    const parts: CarParts = this.parts;
    for (const w of parts.wheels) {
      const o3 = (w as any).object3D;
      if (o3) o3.rotation.x = car.wheelSpin;
    }
    for (const p of parts.frontPivots) {
      const o3 = (p as any).object3D;
      if (o3) o3.rotation.y = -car.steer * 0.42;
    }

    const flame = (parts.flame as any).object3D;
    if (flame) {
      flame.visible = car.boosting && car.status === 'driving';
      if (flame.visible) {
        const flicker = 0.75 + Math.random() * 0.55;
        flame.scale.set(1, flicker, 1);
      }
    }

    // Blink while hovering or invulnerable.
    const ghost = car.status === 'respawning' || car.invulnerable > 0;
    const blinkOn = Math.sin(this.time * 22) > -0.35;
    const body = (parts.body as any).object3D;
    if (body) body.visible = !ghost || blinkOn;
    const shield = (parts.shield as any).object3D;
    if (shield) shield.visible = ghost;

    const marker = this.marker.object3D;
    if (marker) {
      marker.visible = car.status === 'respawning';
      if (marker.visible) {
        marker.position.set(car.spawnX, 0.012, car.spawnZ);
        const s = 1 + Math.sin(this.time * 7) * 0.14;
        marker.scale.set(s, s, 1);
      }
    }
    if (car.status === 'respawning') {
      // Bob gently while waiting to drop.
      object.position.y = RESPAWN_HOVER_Y + Math.sin(this.time * 4) * 0.03;
    }
    this.updateLabel(car, blinkOn);
  },
});

// ---------------------------------------------------------------------------
// sumo-arena-manager: owns the fixed-step loop and routes events.
// ---------------------------------------------------------------------------
function handleEvent(e: GameEvent) {
  switch (e.type) {
    case 'countdown':
      audio.countdown();
      break;
    case 'go':
      audio.go();
      showGoFlash();
      break;
    case 'crash': {
      audio.crash(e.strength, e.boosted);
      const count = Math.min(70, Math.round(12 + e.strength * 11));
      emitSparks(e.x, e.y, e.z, count, e.boosted ? 0xfde047 : 0xfb923c, 1.1 + e.strength * 0.42);
      shake = Math.min(0.14, shake + e.strength * 0.018 + (e.boosted ? 0.04 : 0));
      pulseControllers(Math.min(1, 0.3 + e.strength * 0.15), 90);
      break;
    }
    case 'bump':
      audio.bump(e.surface, e.strength);
      if (e.surface !== 'prop') emitSparks(e.x, e.y, e.z, 6 + Math.round(e.strength * 4), 0xffedd5, 0.9);
      break;
    case 'break':
      audio.unstick(e.kind);
      emitSparks(e.x, e.y, e.z, 14, e.kind === 'hotglue' ? 0xf9a8d4 : 0xe0f2fe, 1.2);
      shake = Math.min(0.14, shake + 0.03);
      pulseControllers(0.5, 70);
      break;
    case 'jump':
      audio.jump();
      break;
    case 'land':
      audio.land(e.strength);
      emitSparks(e.x, e.y + 0.02, e.z, 8, 0xcbd5e1, 0.7, 0.5);
      break;
    case 'boost':
      audio.boost();
      break;
    case 'fall': {
      audio.fall();
      pulseControllers(0.6, 220);
      if (e.scoredBy) window.setTimeout(() => audio.score(), 380);
      emitSparks(e.x, 0.02, e.z, 34, CAR_COLORS[e.player].hex, 1.5);
      emitSparks(e.x, 0.02, e.z, 14, 0xffffff, 1);
      showFallBanner(e.player, e.scoredBy);
      break;
    }
    case 'floor':
      audio.floor();
      emitSparks(e.x, e.y + 0.03, e.z, 26, 0xfacc15, 1.5);
      break;
    case 'respawn':
      audio.respawn();
      break;
    case 'win':
      audio.win();
      break;
  }
}

const sameInput = (a: CarInput | null, b: CarInput) =>
  a !== null && a.throttle === b.throttle && a.steer === b.steer && a.boost === b.boost;

// Online, model-to-view events arrive through the Croquet view.
onlineHooks.events = (events) => events.forEach(handleEvent);

AFRAME.registerComponent('sumo-arena-manager', {
  init(this: any) {
    this.accumulator = 0;
    this.sincePublish = 0;
    this.lastSent = null;
    this.sinceSent = 0;
    input.attach(window);
    audio.setMuted(!getState().sound);
  },
  tick(this: any, _t: number, dtMs: number) {
    const s = getState();
    const dt = Math.min(dtMs / 1000, 0.05);
    const engine = getEngine();

    if (isOnline()) {
      // The model steps itself on every browser; this view only sends its own car's input.
      this.sincePublish += dt;
      if (this.sincePublish >= 1 / 20) {
        this.sincePublish = 0;
        publishTelemetry();
      }
      const view = currentView();
      this.sinceSent += dt;
      if (view?.seat && view.synced) {
        const running = !s.paused && s.phase !== 'idle' && s.phase !== 'finished';
        const mine: CarInput = running ? input.read('p1', true) : NO_INPUT;
        // Send on change (at most 30 per second), plus a slow keep-alive.
        if ((!sameInput(this.lastSent, mine) && this.sinceSent >= 1 / 30) || this.sinceSent > 1) {
          view.sendInput(mine);
          this.lastSent = { ...mine };
          this.sinceSent = 0;
        }
      }
      this.updateEngineSounds(engine, s.paused || s.phase === 'idle');
      return;
    }

    if (s.paused || heldForSettings(s) || s.phase === 'idle') return;

    this.accumulator += dt;
    const cpu = getCpu();
    const shared = s.mode === 'cpu';
    while (this.accumulator >= FIXED_STEP) {
      this.accumulator -= FIXED_STEP;
      const playing = engine.phase === 'playing' || engine.phase === 'finishing';
      const p1: CarInput = input.read('p1', shared);
      const p2: CarInput = cpu ? (playing ? cpu.update(engine, FIXED_STEP) : NO_INPUT) : input.read('p2');
      engine.step(FIXED_STEP, { p1, p2 });
    }
    for (const e of engine.drainEvents()) handleEvent(e);
    this.updateEngineSounds(engine, false);

    this.sincePublish += dt;
    if (this.sincePublish >= 1 / 20) {
      this.sincePublish = 0;
      publishTelemetry();
    }
  },
  updateEngineSounds(this: any, engine: ReturnType<typeof getEngine>, silent: boolean) {
    for (const id of ['p1', 'p2'] as PlayerId[]) {
      const car = engine.cars[id];
      const speed = Math.min(1, Math.hypot(car.vx, car.vz) / MAX_BOOST_SPEED);
      const live = !silent && car.status === 'driving' && engine.phase !== 'finished' && engine.phase !== 'countdown';
      audio.updateEngine(id, speed, car.boosting, live);
    }
  },
});


