import type { StageDefinition, StagePreset } from './types';

const SPAWN_LEFT = { x: -1.25, z: 0, heading: Math.PI / 2 };
const SPAWN_RIGHT = { x: 1.25, z: 0, heading: -Math.PI / 2 };

const mug = (x: number, z: number, rotation = 0) =>
  ({ kind: 'mug', x, z, radius: 0.24, height: 0.34, rotation }) as const;

const books = (x: number, z: number, halfX: number, halfZ: number, height: number, rotation = 0) =>
  ({ kind: 'books', x, z, halfX, halfZ, height, rotation }) as const;

/** `rotation` turns the ascending direction: 0 climbs towards +X, PI climbs towards -X. */
const ramp = (x: number, z: number, rotation: number, height = 0.34, halfX = 0.55, halfZ = 0.27) =>
  ({ kind: 'ramp', x, z, halfX, halfZ, height, rotation }) as const;

export const STAGES: Record<StagePreset, StageDefinition> = {
  standard: {
    id: 'standard',
    label: 'スタンダード机',
    description: 'マグ・本・定規・文房具のフル配置',
    obstacles: [
      mug(-1.05, 0.95, 0.6),
      mug(1.45, -0.95, 2.4),
      books(0.1, -1.0, 0.5, 0.34, 0.27, 0.12),
      ramp(-1.45, -0.85, 0),
    ],
    props: [
      { kind: 'pencil', x: 0.75, z: 0.85, angle: 0.65 },
      { kind: 'eraser', x: -0.2, z: 0.75, angle: 0.4 },
      { kind: 'eraser', x: 1.7, z: 0.45, angle: 1.2 },
    ],
    spawns: { p1: SPAWN_LEFT, p2: SPAWN_RIGHT },
    respawnPoints: [
      { x: 0, z: 0 },
      { x: -0.75, z: 0.1 },
      { x: 0.75, z: 0.1 },
      { x: 0, z: 0.35 },
    ],
  },
  ramps: {
    id: 'ramps',
    label: 'ジャンプリング',
    description: '中央の高台と四隅のバンパー',
    obstacles: [
      books(0, 0, 0.42, 0.42, 0.3),
      ramp(-0.97, 0, 0, 0.3),
      ramp(0.97, 0, Math.PI, 0.3),
      ramp(-0.35, 1.08, 0),
      ramp(0.35, -1.08, Math.PI),
      mug(-1.85, 1.15),
      mug(1.85, 1.15, 1.6),
      mug(-1.85, -1.15, 3.1),
      mug(1.85, -1.15, 4.4),
    ],
    props: [{ kind: 'pencil', x: 1.25, z: 0.72, angle: 2.2 }],
    spawns: {
      p1: { x: -1.95, z: 0, heading: Math.PI / 2 },
      p2: { x: 1.95, z: 0, heading: -Math.PI / 2 },
    },
    respawnPoints: [
      { x: -1.75, z: 0 },
      { x: 1.75, z: 0 },
      { x: -1.1, z: 0.72 },
      { x: 1.1, z: -0.72 },
    ],
  },
  sumo: {
    id: 'sumo',
    label: 'シンプル土俵',
    description: '障害物なしの真っ向勝負',
    obstacles: [],
    props: [],
    spawns: { p1: SPAWN_LEFT, p2: SPAWN_RIGHT },
    respawnPoints: [
      { x: 0, z: 0 },
      { x: -0.9, z: 0 },
      { x: 0.9, z: 0 },
      { x: 0, z: 0.7 },
      { x: 0, z: -0.7 },
    ],
  },
};
