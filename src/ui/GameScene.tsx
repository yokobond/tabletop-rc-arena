import { memo } from 'react';

/** Rendered once; everything inside is driven by the A-Frame components. */
export const GameScene = memo(function GameScene() {
  return (
    <a-scene
      embedded=""
      class="scene"
      sumo-arena-manager=""
      background="color: #0F172A"
      renderer="antialias: true; colorManagement: true; maxCanvasWidth: 1920; maxCanvasHeight: 1920"
      shadow="type: pcf"
      xr-mode-ui="enabled: false"
      loading-screen="enabled: false"
      device-orientation-permission-ui="enabled: false"
      keyboard-shortcuts="enterVR: false"
    >
      {/* A-Frame writes the headset pose onto the camera entity, so the VR rig has to be its parent. */}
      <a-entity vr-session="">
        <a-entity camera="fov: 42; near: 0.05; far: 120; active: true" camera-rig="" />
      </a-entity>
      <a-entity light="type: hemisphere; color: #FFE9D0; groundColor: #1E293B; intensity: 1.15" />
      <a-entity
        position="2.6 7 3.4"
        light="type: directional; color: #FFEBD2; intensity: 2.5; castShadow: true; shadowMapWidth: 2048; shadowMapHeight: 2048; shadowCameraLeft: -4.5; shadowCameraRight: 4.5; shadowCameraTop: 4.5; shadowCameraBottom: -4.5; shadowCameraNear: 1; shadowCameraFar: 18; shadowBias: -0.0006"
      />
      <a-entity id="fill-light" position="-3 2.6 -2.5" light="type: point; color: #FFB066; intensity: 9; distance: 14; decay: 2" />
      <a-entity tabletop-arena="" />
      <a-entity stage-builder="" />
      <a-entity rc-car-physics="player: p1" />
      <a-entity rc-car-physics="player: p2" />
      <a-entity spark-burst="" />
      <a-entity vr-hud="" position="0 1.85 -2.15" rotation="-14 0 0" />
    </a-scene>
  );
});
