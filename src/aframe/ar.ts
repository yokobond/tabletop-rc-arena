/* eslint-disable @typescript-eslint/no-explicit-any */
import { MARKER_DICTIONARY, MARKER_ID, loadAruco, markerSize } from '../ar/marker';
import { coverFov, focalLength, pickPose, poseCandidates, type CameraPose } from '../ar/markerPose';
import { getState, setArHandlers, updateSettings } from '../runtime/store';
import { AFRAME, THREE } from './helpers';

/** Markers are searched for in a copy of the frame this long, in pixels: enough to find one across a table. */
const DETECT_LONG_SIDE = 640;
/** After this long without the marker the player is asked to show it again. */
const LOST_AFTER_MS = 1000;
/** How fast the view follows the measured pose, per second. Corner positions are whole pixels, so they jitter. */
const FOLLOW_RATE = 14;
/** Anything further below the table's surface than this is not drawn, so a car that drives off sinks out of sight. */
const CLIP_BELOW = 0.02;

/**
 * AR without WebXR, which iPhones and iPads do not have: the rear camera's picture is shown behind
 * the scene, and the scene's camera is put where the device is, worked out from a printed marker in
 * the middle of the table. The simulation is not touched, so everybody looking at the same marker
 * sees the arena in the same place, whether they drive or watch.
 */
AFRAME.registerComponent('ar-session', {
  init(this: any) {
    this.scene = this.el.sceneEl;
    this.active = false;
    this.clip = new THREE.Plane(new THREE.Vector3(0, 1, 0), CLIP_BELOW);
    this.basis = new THREE.Matrix4();
    this.targetPosition = new THREE.Vector3();
    this.targetQuaternion = new THREE.Quaternion();
    this.axes = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

    updateSettings({ arSupported: Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext });
    setArHandlers({ enter: () => this.enter(), exit: () => this.exit() });
    // A headset has its own view; the two cannot share the camera entity.
    this.scene.addEventListener('enter-vr', () => this.exit());
  },

  remove(this: any) {
    this.exit();
    setArHandlers(null);
  },

  async enter(this: any) {
    if (this.active || this.starting) return;
    this.starting = true;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      const { AR, POS } = await loadAruco();
      const video = document.querySelector('.ar-video') as HTMLVideoElement;
      video.srcObject = stream;
      await video.play();

      this.stream = stream;
      this.video = video;
      this.Posit = POS.Posit;
      this.detector = new AR.Detector({ dictionaryName: MARKER_DICTIONARY });
      this.frame = document.createElement('canvas');
      this.g = this.frame.getContext('2d', { willReadFrequently: true });
      this.posit = null;
      this.positKey = '';
      this.pose = null;
      this.placed = false;
      this.lastSeen = -Infinity;
      this.lastFrameTime = -1;
    } catch (err) {
      stream?.getTracks().forEach((track) => track.stop());
      throw err;
    } finally {
      this.starting = false;
    }

    this.active = true;
    this.scene.setAttribute('background', 'transparent: true');
    this.scene.renderer.clippingPlanes = [this.clip];
    // Nothing is in the right place until the marker has been seen once.
    this.scene.object3D.visible = false;
    updateSettings({ arActive: true, arTracking: false });
  },

  exit(this: any) {
    if (!this.active) return;
    this.active = false;
    this.stream.getTracks().forEach((track: MediaStreamTrack) => track.stop());
    this.video.srcObject = null;
    this.stream = this.video = this.detector = this.posit = null;

    this.scene.setAttribute('background', 'color: #0F172A; transparent: false');
    this.scene.renderer.clippingPlanes = [];
    this.scene.object3D.visible = true;
    // camera-rig takes the camera entity back on its next tick; the lens is put back here.
    const cameraEl = this.cameraEl();
    const camera = cameraEl.getObject3D('camera');
    camera.fov = cameraEl.getAttribute('camera').fov;
    camera.updateProjectionMatrix();
    updateSettings({ arActive: false, arTracking: false });
  },

  cameraEl(this: any) {
    return this.scene.querySelector('[camera]');
  },

  /** Looks for the marker in the current video frame. */
  detect(this: any): CameraPose | null {
    const video: HTMLVideoElement = this.video;
    const scale = Math.min(1, DETECT_LONG_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    if (this.frame.width !== width || this.frame.height !== height) {
      this.frame.width = width;
      this.frame.height = height;
    }
    this.g.drawImage(video, 0, 0, width, height);
    const markers = this.detector.detect(this.g.getImageData(0, 0, width, height));
    const marker = markers.find((m: { id: number }) => m.id === MARKER_ID);
    if (!marker) return null;

    const size = markerSize(getState().arSize);
    const key = `${size}|${width}|${height}`;
    if (key !== this.positKey) {
      this.positKey = key;
      this.posit = new this.Posit(size, focalLength(width, height));
    }
    return pickPose(poseCandidates(marker.corners, width, height, this.posit), this.pose);
  },

  tick(this: any, time: number, dtMs: number) {
    if (!this.active) return;
    const video: HTMLVideoElement = this.video;
    if (video.readyState < 2 || !video.videoWidth) return;

    // The lens of the visible part of the picture; it changes when the device is turned.
    const cameraEl = this.cameraEl();
    const camera = cameraEl.getObject3D('camera');
    const fov = coverFov(video.videoWidth, video.videoHeight, camera.aspect, focalLength(video.videoWidth, video.videoHeight));
    if (Number.isFinite(fov) && Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }

    if (video.currentTime !== this.lastFrameTime) {
      this.lastFrameTime = video.currentTime;
      const pose = this.detect();
      if (pose) {
        this.pose = pose;
        this.lastSeen = time;
        const [right, up, back] = this.axes;
        this.basis.makeBasis(right.fromArray(pose.right), up.fromArray(pose.up), back.fromArray(pose.back));
        this.targetQuaternion.setFromRotationMatrix(this.basis);
        this.targetPosition.fromArray(pose.position);
      }
    }

    const tracking = time - this.lastSeen < LOST_AFTER_MS;
    if (tracking !== getState().arTracking) updateSettings({ arTracking: tracking });
    // While the marker is out of sight the last view stays, so that a match can go on.
    if (!this.pose) return;

    const object = cameraEl.object3D;
    if (!this.placed) {
      this.placed = true;
      this.scene.object3D.visible = true;
      object.position.copy(this.targetPosition);
      object.quaternion.copy(this.targetQuaternion);
      return;
    }
    const k = 1 - Math.exp((-FOLLOW_RATE * Math.min(dtMs, 100)) / 1000);
    object.position.lerp(this.targetPosition, k);
    object.quaternion.slerp(this.targetQuaternion, k);
  },
});
