/* eslint-disable @typescript-eslint/no-explicit-any */
import 'aframe';

export const AFRAME = (window as any).AFRAME;
export const THREE = AFRAME.THREE;

/**
 * Sets a canvas as the map of an entity's material once the mesh exists.
 * The material component owns the mesh, so this waits for it.
 */
export function applyCanvasTexture(el: any, canvas: HTMLCanvasElement, repeat?: [number, number]) {
  const apply = () => {
    const mesh = el.getObject3D('mesh');
    if (!mesh || !mesh.material) return false;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    if (repeat) {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(repeat[0], repeat[1]);
    }
    mesh.material.map = texture;
    mesh.material.color?.set?.('#ffffff');
    mesh.material.needsUpdate = true;
    return true;
  };
  if (el.hasLoaded && apply()) return;
  el.addEventListener('loaded', () => {
    // The material component updates right after `loaded` on some paths: apply on the next frame too.
    if (!apply()) requestAnimationFrame(apply);
  });
}
