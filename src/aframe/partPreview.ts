/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The part maker's 3D picture of the part being made: its own small renderer, turned, moved and
 * zoomed by the player. Unlike the tray's thumbnails it is drawn live, so the red lines of the
 * shape it bumps with can be looked at from any side and up close.
 */
import { defaultRot, orientationQuat, specOf, turnMatrix, type PartType } from '../game/bodyParts';
import type { PlayerId } from '../game/types';
import { THREE } from './helpers';
import { buildPieceMesh, shapeOutline } from './pieceMeshes';

const START_YAW = -0.7;
const START_PITCH = 0.45;
const MAX_PITCH = Math.PI / 2 - 0.05;
const ZOOM = [0.4, 30] as const;

export class PartPreview {
  private renderer: any;
  private scene: any;
  private camera: any;
  private part: any = null;
  /** The middle of the look: where the view starts and goes back to. */
  private home: any;
  /** What the view turns around and zooms to. */
  private target: any;
  /** The player moved the target: it then stays put while the part changes. */
  private moved = false;
  private radius = 0.05;
  private yaw = START_YAW;
  private pitch = START_PITCH;
  private zoom = 1;
  private frame = 0;
  private raycaster: any;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight('#FFFFFF', '#64748B', 2));
    const sun = new THREE.DirectionalLight('#FFFFFF', 2.2);
    sun.position.set(1, 2, 1.5);
    this.scene.add(sun);
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.001, 10);
    this.home = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.raycaster = new THREE.Raycaster();
    this.resize();
  }

  /**
   * Shows a part as it comes out of the tray (a long tube lying). The view is framed on the look
   * alone, so moving or resizing the red lines does not move the camera.
   */
  setPart(type: PartType | null, player: PlayerId, outline: boolean) {
    this.clear();
    if (!type) {
      this.render();
      return;
    }
    const g = buildPieceMesh(type, player);
    const q = orientationQuat(defaultRot(type));
    g.quaternion.set(q.x, q.y, q.z, q.w);
    // A tilted box is shown tilted, with the look the way it was made (the part itself has it the other way round).
    const tilt = type.made?.turn;
    if (tilt) {
      const m = turnMatrix(tilt);
      const turn = new THREE.Matrix4().set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1);
      g.quaternion.premultiply(new THREE.Quaternion().setFromRotationMatrix(turn));
    }
    g.updateMatrixWorld(true);
    const sphere = new THREE.Box3().setFromObject(g).getBoundingSphere(new THREE.Sphere());
    this.home.copy(sphere.center);
    this.radius = Math.max(sphere.radius, 0.005);
    if (!this.moved) this.target.copy(this.home);
    if (outline) g.add(shapeOutline(specOf(type).shape));
    this.part = g;
    this.scene.add(g);
    this.render();
  }

  /** Turns the view: right and up in radians. */
  orbit(dYaw: number, dPitch: number) {
    this.yaw += dYaw;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch + dPitch));
    this.render();
  }

  /** Slides the view along with a drag of `dx`, `dy` pixels (the part follows the pointer). */
  pan(dx: number, dy: number) {
    const { right, up, perPixel } = this.basis();
    this.target.addScaledVector(right, -dx * perPixel).addScaledVector(up, dy * perPixel);
    this.moved = true;
    this.render();
  }

  /**
   * Comes closer (`factor` > 1) or goes back, toward the point under `x`, `y` (pixels in the
   * picture; its middle when left out), which stays where it is on the screen.
   */
  zoomBy(factor: number, x?: number, y?: number) {
    const zoom = Math.max(ZOOM[0], Math.min(ZOOM[1], this.zoom * factor));
    const applied = zoom / this.zoom;
    if (applied === 1) return;
    if (x !== undefined && y !== undefined) {
      const { right, up, perPixel } = this.basis();
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      const toward = (1 - 1 / applied) * perPixel;
      this.target.addScaledVector(right, (x - w / 2) * toward).addScaledVector(up, -(y - h / 2) * toward);
      this.moved = true;
    }
    this.zoom = zoom;
    this.render();
  }

  /** Makes the point of the part under `x`, `y` what the view turns around. False when there is none. */
  focusAt(x: number, y: number) {
    if (!this.part) return false;
    this.place();
    const ndc = new THREE.Vector2((x / this.canvas.clientWidth) * 2 - 1, -(y / this.canvas.clientHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes: any[] = [];
    this.part.traverse((o: any) => o.isMesh && meshes.push(o));
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return false;
    this.target.copy(hit.point);
    this.moved = true;
    this.render();
    return true;
  }

  /** Back to the first view: the whole look, from the front left and above. */
  reset() {
    this.yaw = START_YAW;
    this.pitch = START_PITCH;
    this.zoom = 1;
    this.target.copy(this.home);
    this.moved = false;
    this.render();
  }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.render();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.clear();
    this.renderer.dispose();
  }

  private clear() {
    if (!this.part) return;
    this.scene.remove(this.part);
    // Geometries are made anew for every part; the plain materials are shared and stay.
    this.part.traverse((o: any) => {
      o.geometry?.dispose();
      if (o.isLineSegments) o.material?.dispose();
    });
    this.part = null;
  }

  /** How far the camera is: far enough for the whole look in the narrower side, at zoom 1. */
  private distance() {
    const fov = (this.camera.fov * Math.PI) / 180;
    const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect));
    return ((this.radius / Math.sin(fit / 2)) * 1.08) / this.zoom;
  }

  /** The screen's right and up in the scene, and how much of the scene a pixel is at the target. */
  private basis() {
    const back = new THREE.Vector3(Math.cos(this.pitch) * Math.sin(this.yaw), Math.sin(this.pitch), Math.cos(this.pitch) * Math.cos(this.yaw));
    const right = new THREE.Vector3(0, 1, 0).cross(back).normalize();
    const up = back.clone().cross(right).normalize();
    const fov = (this.camera.fov * Math.PI) / 180;
    const perPixel = (2 * this.distance() * Math.tan(fov / 2)) / Math.max(1, this.canvas.clientHeight);
    return { back, right, up, perPixel };
  }

  /** Puts the camera where the view says. */
  private place() {
    const camera = this.camera;
    const distance = this.distance();
    const { back } = this.basis();
    camera.position.copy(this.target).addScaledVector(back, distance);
    camera.near = distance / 100;
    camera.far = distance * 10 + this.radius * 4;
    camera.updateProjectionMatrix();
    camera.lookAt(this.target);
    camera.updateMatrixWorld();
  }

  /** Draws on the next frame (once, however often it is asked for before then). */
  private render() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.place();
      this.renderer.render(this.scene, this.camera);
    });
  }
}
