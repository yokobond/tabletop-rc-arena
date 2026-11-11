/* eslint-disable @typescript-eslint/no-explicit-any */
import { RESPAWN_HOVER_Y, FIXED_STEP, MAX_BOOST_SPEED, TABLE_HALF_X, TABLE_HALF_Z, TABLE_THICKNESS, FLOOR_Y } from '../game/constants';
import { STAGES } from '../game/stages';
import type { CameraPreset, CarInput, GameEvent, PlayerId, StagePreset } from '../game/types';
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
import { CAR_PARTS } from '../game/carParts';
import { VR_WORLD_SCALE, pulseControllers } from './vr';
import './ar';
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

AFRAME.registerComponent('camera-rig', {
  init(this: any) {
    const p = CAMERA_PRESETS.angled;
    this.elevation = 34;
    this.azimuth = 30;
    this.distance = p.distance + 1.4;
    this.time = 0;
    this.eye = new THREE.Vector3();
    this.target = new THREE.Vector3(0, -0.05, 0.06);
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
    const idle = s.phase === 'idle' && !this.reducedMotion;

    const wantElevation = Math.max(8, Math.min(88, preset.elevation + s.cameraHeight * 38));
    const wantAzimuth = preset.azimuth + s.cameraAngle + (idle ? Math.sin(this.time * 0.22) * 16 : 0);

    // Fit the table in narrow viewports; horizontal FOV shrinks with the aspect ratio.
    // Before the first layout the aspect can be 0 or NaN; one bad frame would poison the easing for good.
    const rawAspect = this.el.sceneEl.camera?.aspect;
    const aspect = Number.isFinite(rawAspect) && rawAspect > 0 ? rawAspect : 1.6;
    const fitHalfWidth = TABLE_HALF_X + 0.35;
    const fov = ((this.el.getAttribute('camera')?.fov ?? 42) * Math.PI) / 180;
    const fitDistance = fitHalfWidth / (Math.tan(fov / 2) * aspect) + 1;
    const wantDistance = Math.max(preset.distance, fitDistance);

    const k = 1 - Math.exp(-4.5 * dt);
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
    applyCanvasTexture(top, tableTexture());

    // Apron and legs.
    const apron = `primitive: box; width: ${tableW - 0.3}; height: 0.2; depth: ${tableD - 0.3}`;
    const apronEl = ent(root, {
      geometry: apron,
      material: 'color: #7C4A22; roughness: 0.7',
      position: `0 ${-TABLE_THICKNESS - 0.1} 0`,
    });
    applyCanvasTexture(apronEl, woodSideTexture());
    room.push(apronEl);
    const legHeight = -FLOOR_Y - TABLE_THICKNESS;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = ent(root, {
          geometry: `primitive: box; width: 0.18; height: ${legHeight}; depth: 0.18`,
          material: 'color: #6B3F1D; roughness: 0.7',
          position: `${sx * (TABLE_HALF_X - 0.24)} ${FLOOR_Y + legHeight / 2} ${sz * (TABLE_HALF_Z - 0.24)}`,
        });
        applyCanvasTexture(leg, woodSideTexture());
        room.push(leg);
      }
    }

    // Only the table top is left in AR, lying on the real table like a mat.
    let shown = true;
    this.unsubscribe = subscribe(() => {
      const show = !getState().arActive;
      if (show === shown) return;
      shown = show;
      for (const el of room) el.object3D.visible = show;
    });
  },
  remove(this: any) {
    this.unsubscribe?.();
  },
});

// ---------------------------------------------------------------------------
// Stage builder: creates obstacles and props; props follow the simulation.
// ---------------------------------------------------------------------------
const MUG_COLORS = ['#DC2626', '#2563EB', '#16A34A', '#D97706'];

AFRAME.registerComponent('stage-builder', {
  init(this: any) {
    this.current = null;
    this.propEls = [];
    this.rebuild(getState().stagePreset);
    this.unsubscribe = subscribe(() => {
      const next = getState().stagePreset;
      if (next !== this.current) this.rebuild(next);
    });
  },
  remove(this: any) {
    this.unsubscribe?.();
  },
  rebuild(this: any, preset: StagePreset) {
    this.current = preset;
    while (this.el.firstChild) this.el.removeChild(this.el.firstChild);
    const stage = STAGES[preset];
    let mugs = 0;
    let bookStacks = 0;
    for (const o of stage.obstacles) {
      if (o.kind === 'mug') buildMug(this.el, o, MUG_COLORS[mugs++ % MUG_COLORS.length]);
      else if (o.kind === 'books') buildBooks(this.el, o, bookStacks++);
      else buildRamp(this.el, o);
    }
    this.propEls = stage.props.map((def) => buildProp(this.el, def));
  },
  tick(this: any) {
    const engine = getEngine();
    const smooth = smoothing();
    this.propEls.forEach((els: { root: any; spin: any }, i: number) => {
      const p = engine.props[i];
      if (!p || !els.root.object3D) return;
      followPose(els.root.object3D, p, smooth);
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

const PART_OFFSET = Object.fromEntries(CAR_PARTS.map((p) => [p.id, p.offset]));
const partMatrix = new THREE.Matrix4();
const rootInverse = new THREE.Matrix4();
const offsetMatrix = new THREE.Matrix4();

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
   * Each part's visual follows its collider. Attached parts sit at the car origin; a part that
   * has broken off is placed from its own rigid body (part pose * inverse of its car offset).
   */
  placeParts(this: any, engine: ReturnType<typeof getEngine>) {
    const parts: CarParts = this.parts;
    const root = this.el.object3D;
    let rootReady = false;
    for (const { partId, attached, pose } of engine.partPoses(this.player as PlayerId)) {
      const el = (parts.partEls as any)[partId];
      const o3 = el?.object3D;
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
      const [ox, oy, oz] = PART_OFFSET[partId];
      partMatrix.compose(o3.position.set(pose.x, pose.y, pose.z), tmpQuat.set(pose.qx, pose.qy, pose.qz, pose.qw), o3.scale);
      offsetMatrix.makeTranslation(-ox, -oy, -oz);
      partMatrix.premultiply(rootInverse).multiply(offsetMatrix);
      partMatrix.decompose(o3.position, o3.quaternion, o3.scale);
      o3.userData.detached = true;
    }
  },
  init(this: any) {
    this.player = this.data.player as PlayerId;
    this.parts = buildCar(this.el, this.player) as CarParts;
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


