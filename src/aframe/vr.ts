/* eslint-disable @typescript-eslint/no-explicit-any */
import { TABLE_HALF_Z } from '../game/constants';
import type { PlayerId } from '../game/types';
import { input } from '../runtime/input';
import {
  getState,
  playerName,
  pauseIfRunning,
  setVrHandlers,
  updateSettings,
  vrPrimaryAction,
  vrSecondaryAction,
  type GameState,
} from '../runtime/store';
import { AFRAME, THREE } from './helpers';

/**
 * One simulation unit is this many real metres, which makes the table 1.44 x 0.96 m,
 * 0.72 m tall, with 14 cm RC cars. The simulation keeps its units: the rig is scaled up
 * instead of the world being scaled down, so shadows and physics are unaffected.
 */
export const VR_WORLD_SCALE = 0.3;
const RIG_SCALE = 1 / VR_WORLD_SCALE;

/** Where "Reset view" puts the eyes, in real metres from the table's front edge and surface. */
const EYE_ABOVE_TABLE_M = 0.8;
const EYE_BEHIND_EDGE_M = 0.5;

const FILL_LIGHT_INTENSITY = 9;
const DEAD_ZONE = 0.15;

let session: any = null;

/** No-op outside of VR. Strength is 0..1. */
export function pulseControllers(strength: number, durationMs: number) {
  if (!session) return;
  for (const source of session.inputSources) {
    const gamepad = source.gamepad as any;
    const actuator = gamepad?.hapticActuators?.[0];
    if (actuator?.pulse) void actuator.pulse(strength, durationMs);
    else void gamepad?.vibrationActuator?.playEffect?.('dual-rumble', { duration: durationMs, strongMagnitude: strength });
  }
}

function setFillLight(intensity: number) {
  (document.querySelector('#fill-light') as any)?.setAttribute('light', 'intensity', intensity);
}

/** A little RC transmitter in the player's hand. Sizes are real metres. */
function buildTransmitter() {
  const group = new THREE.Group();
  const add = (geometry: any, color: number, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.55 }));
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };
  add(new THREE.BoxGeometry(0.07, 0.03, 0.11), 0x1f2937, 0, 0, -0.03);
  add(new THREE.CylinderGeometry(0.004, 0.004, 0.022, 8), 0x9ca3af, 0, 0.026, -0.045);
  add(new THREE.SphereGeometry(0.008, 10, 8), 0xef4444, 0, 0.04, -0.045);
  add(new THREE.CylinderGeometry(0.0018, 0.0018, 0.12, 6), 0x9ca3af, 0.026, 0.07, -0.075);
  return group;
}

AFRAME.registerComponent('vr-session', {
  init(this: any) {
    this.scene = this.el.sceneEl;
    this.recenterIn = 0;
    this.pressed = new Set<string>();
    this.controllersBuilt = false;

    void (navigator as any).xr
      ?.isSessionSupported?.('immersive-vr')
      .then((supported: boolean) => updateSettings({ vrSupported: supported }))
      .catch(() => updateSettings({ vrSupported: false }));

    setVrHandlers({
      enter: () => this.scene.enterVR(),
      exit: () => this.scene.exitVR(),
    });

    this.scene.addEventListener('enter-vr', () => this.onEnter());
    this.scene.addEventListener('exit-vr', () => this.onExit());
  },

  onEnter(this: any) {
    session = this.scene.xrSession;
    this.onVisibility = () => {
      if (session?.visibilityState !== 'visible') pauseIfRunning();
    };
    session?.addEventListener('visibilitychange', this.onVisibility);

    this.el.object3D.scale.setScalar(RIG_SCALE);
    // Wait for tracking to report a head pose before lining the table up.
    this.recenterIn = 3;
    // Distances are shortened along with the view, so distance-based light falloff needs undoing.
    setFillLight(FILL_LIGHT_INTENSITY * VR_WORLD_SCALE ** 2);

    if (!this.controllersBuilt) {
      this.controllersBuilt = true;
      for (const i of [0, 1]) {
        const grip = this.scene.renderer.xr.getControllerGrip(i);
        grip.add(buildTransmitter());
        this.el.object3D.add(grip);
      }
    }
    updateSettings({ vrActive: true });
  },

  onExit(this: any) {
    session?.removeEventListener('visibilitychange', this.onVisibility);
    session = null;
    input.setXr({ throttle: 0, steer: 0, boost: false });
    this.pressed.clear();

    // camera-rig takes the camera entity back on its next tick.
    const rig = this.el.object3D;
    rig.scale.setScalar(1);
    rig.position.set(0, 0, 0);
    rig.rotation.set(0, 0, 0);
    // The XR manager overwrites the camera's lens with the headset's; it does not put it back.
    const camera = this.head().el.getObject3D('camera');
    camera.fov = this.head().el.getAttribute('camera').fov;
    camera.updateProjectionMatrix();
    setFillLight(FILL_LIGHT_INTENSITY);

    pauseIfRunning();
    updateSettings({ vrActive: false });
  },

  head(this: any) {
    return this.el.querySelector('[camera]').object3D;
  },

  /** Faces the player at the table from wherever they stand or sit in their room. */
  recenter(this: any) {
    // The headset pose, relative to the rig (A-Frame writes it onto the camera entity).
    const camera = this.head();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const headYaw = Math.atan2(-forward.x, -forward.z);
    const rig = this.el.object3D;
    rig.rotation.set(0, -headYaw, 0);

    const head = camera.position.clone().multiplyScalar(RIG_SCALE).applyAxisAngle(new THREE.Vector3(0, 1, 0), -headYaw);
    rig.position.set(
      -head.x,
      EYE_ABOVE_TABLE_M * RIG_SCALE - head.y,
      TABLE_HALF_Z + EYE_BEHIND_EDGE_M * RIG_SCALE - head.z,
    );
  },

  tick(this: any) {
    if (!session) return;
    if (this.recenterIn > 0 && --this.recenterIn === 0) this.recenter();

    let throttle = 0;
    let steer = 0;
    let boost = false;
    const down = new Set<string>();

    for (const source of session.inputSources) {
      const gamepad = source.gamepad;
      if (!gamepad) continue; // Hand tracking has no controls to map.
      const axes = gamepad.axes;
      const x = axes.length >= 4 ? axes[2] : (axes[0] ?? 0);
      const y = axes.length >= 4 ? axes[3] : (axes[1] ?? 0);
      if (Math.abs(x) > Math.abs(steer) && Math.abs(x) > DEAD_ZONE) steer = x;
      if (Math.abs(y) > Math.abs(throttle) && Math.abs(y) > DEAD_ZONE) throttle = y;

      // xr-standard mapping: 0 trigger, 1 squeeze, 3 stick press, 4 A/X, 5 B/Y.
      const buttons = gamepad.buttons;
      if (buttons[0]?.pressed || buttons[1]?.pressed) boost = true;
      if (buttons[3]?.pressed) down.add('stick');
      if (buttons[4]?.pressed) down.add('primary');
      if (buttons[5]?.pressed) down.add('secondary');
    }
    input.setXr({ throttle: -throttle, steer, boost });

    const justPressed = (name: string) => down.has(name) && !this.pressed.has(name);
    if (justPressed('stick')) this.recenter();
    if (justPressed('primary')) vrPrimaryAction();
    if (justPressed('secondary')) vrSecondaryAction();
    this.pressed = down;
  },
});

// ---------------------------------------------------------------------------
// The 2D HUD does not exist inside a headset, so the match is shown on a panel
// floating behind the table. It is a canvas, for the Japanese text and the
// bundled fonts; A-Frame's text component would fetch fonts from a CDN.
// ---------------------------------------------------------------------------
const PANEL_W = 1024;
const PANEL_H = 400;
const COLORS: Record<PlayerId, string> = { p1: '#FB7185', p2: '#22D3EE' };

function panelContent(s: GameState) {
  const name = (id: PlayerId) => playerName(s, id);
  let main = '';
  let sub = '';
  let color = '#F1F5F9';
  if (s.paused) {
    main = '一時停止';
    sub = 'A / X: 再開　　B / Y: タイトルへ';
  } else if (s.phase === 'finished' && s.winner) {
    main = `${name(s.winner)} WIN!`;
    color = COLORS[s.winner];
    sub = 'A / X: リマッチ　　B / Y: タイトルへ';
  } else if (s.phase === 'countdown') {
    main = String(Math.max(1, Math.ceil(s.countdown)));
    sub = 'スティック: 走行　トリガー: ブースト　押し込み: 視点リセット';
  } else if (s.showGo) {
    main = 'GO!';
    color = '#FACC15';
  } else if (s.banner) {
    main = `${name(s.banner.player)} 落下！`;
    sub = s.banner.scoredBy ? `${name(s.banner.scoredBy)} +1 POINT` : '';
  }
  const car = (id: PlayerId) => {
    const t = s.carTelemetry[id];
    const decided = s.phase === 'finishing' || s.phase === 'finished';
    return {
      gauge: Math.round(t.boost / 5) * 5,
      status: decided ? '' : t.status !== 'driving' ? `復帰 ${Math.max(1, Math.ceil(t.respawnIn))}` : t.invulnerable ? '無敵' : '',
    };
  };
  return {
    main,
    sub,
    color,
    names: [name('p1'), name('p2')],
    scores: [s.scores.p1, s.scores.p2],
    target: s.targetScore > 0 ? `TO ${s.targetScore}` : 'FREE',
    p1: car('p1'),
    p2: car('p2'),
  };
}

function drawPanel(g: CanvasRenderingContext2D, c: ReturnType<typeof panelContent>) {
  const W = PANEL_W;
  const H = PANEL_H;
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(15, 23, 42, 0.9)';
  g.beginPath();
  g.roundRect(4, 4, W - 8, H - 8, 28);
  g.fill();
  g.strokeStyle = 'rgba(148, 163, 184, 0.4)';
  g.lineWidth = 3;
  g.stroke();

  const ui = '"Hiragino Sans", "Yu Gothic UI", "Noto Sans JP", sans-serif';
  const display = `"Chakra Petch", ${ui}`;
  g.textBaseline = 'middle';

  const side = (index: 0 | 1, car: { gauge: number; status: string }) => {
    const left = index === 0;
    const x = left ? 44 : W - 44;
    g.textAlign = left ? 'left' : 'right';
    g.fillStyle = left ? COLORS.p1 : COLORS.p2;
    g.font = `700 44px ${display}`;
    g.fillText(c.names[index], x, 58);
    if (car.status) {
      g.fillStyle = '#FDE68A';
      g.font = `700 32px ${display}`;
      g.fillText(car.status, left ? x + 92 : x - 92, 60);
    }
    const gaugeW = 340;
    const gaugeX = left ? x : x - gaugeW;
    g.fillStyle = 'rgba(148, 163, 184, 0.28)';
    g.fillRect(gaugeX, 94, gaugeW, 18);
    g.fillStyle = '#F59E0B';
    const fill = (gaugeW * car.gauge) / 100;
    g.fillRect(left ? gaugeX : gaugeX + gaugeW - fill, 94, fill, 18);
  };
  side(0, c.p1);
  side(1, c.p2);

  g.textAlign = 'center';
  g.font = `700 92px ${display}`;
  g.fillStyle = COLORS.p1;
  g.fillText(String(c.scores[0]), W / 2 - 78, 74);
  g.fillStyle = COLORS.p2;
  g.fillText(String(c.scores[1]), W / 2 + 78, 74);
  g.fillStyle = '#A8B5C8';
  g.font = '500 24px "JetBrains Mono", monospace';
  g.fillText(c.target, W / 2, 76);

  if (c.main) {
    g.fillStyle = c.color;
    g.font = `700 ${c.sub ? 112 : 136}px ${display}`;
    g.fillText(c.main, W / 2, c.sub ? 226 : 258);
  }
  if (c.sub) {
    g.fillStyle = '#E2E8F0';
    g.font = `700 32px ${ui}`;
    g.fillText(c.sub, W / 2, 334);
  }
}

AFRAME.registerComponent('vr-hud', {
  init(this: any) {
    const canvas = document.createElement('canvas');
    canvas.width = PANEL_W;
    canvas.height = PANEL_H;
    this.g = canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false });
    const width = 3.8;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, (width * PANEL_H) / PANEL_W), material);
    this.mesh.visible = false;
    this.el.setObject3D('mesh', this.mesh);
    this.lastKey = '';
  },
  tick(this: any) {
    const s = getState();
    this.mesh.visible = s.vrActive;
    if (!s.vrActive) return;
    const content = panelContent(s);
    const key = JSON.stringify(content);
    if (key === this.lastKey) return;
    this.lastKey = key;
    drawPanel(this.g, content);
    this.texture.needsUpdate = true;
  },
});
