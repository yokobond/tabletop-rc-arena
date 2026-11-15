export type PlayerId = 'p1' | 'p2';
export type GameMode = 'pvp' | 'cpu';
export type CpuDifficulty = 'easy' | 'normal' | 'hard';
export type StagePreset = 'standard' | 'ramps' | 'sumo';
/** `custom` is an arena somebody laid out by hand, starting from a preset. */
export type StageId = StagePreset | 'custom';
export type CameraPreset = 'high' | 'angled' | 'low';
export type CarStatus = 'driving' | 'falling' | 'respawning';
export type MatchPhase = 'idle' | 'countdown' | 'playing' | 'finishing' | 'finished';

export interface CarInput {
  /** -1 (brake / reverse) .. 1 (forward) */
  throttle: number;
  /** -1 (left) .. 1 (right) */
  steer: number;
  boost: boolean;
}

export const NO_INPUT: Readonly<CarInput> = Object.freeze({ throttle: 0, steer: 0, boost: false });

export interface CarState {
  id: PlayerId;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Radians. Forward vector is (sin heading, 0, cos heading). */
  heading: number;
  /** Radians. Positive is nose down. */
  pitch: number;
  roll: number;
  steer: number;
  /** 0..100 */
  boost: number;
  boosting: boolean;
  grounded: boolean;
  status: CarStatus;
  /** Seconds left of the current falling / respawning stage. */
  stateTimer: number;
  /** Seconds until the car is back in play (0 while driving). */
  respawnIn: number;
  invulnerable: number;
  hitStun: number;
  wheelSpin: number;
  spawnX: number;
  spawnZ: number;
  /** Seconds in the air, for landing effects. */
  airTime: number;
  /** Seconds spent stuck on the side or roof; the car rights itself after a moment. */
  flipTime: number;
  /** World rotation of the chassis (derived from the rigid body). */
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/** The fields of a car that are game rules rather than physics; only these go into a snapshot. */
export const CAR_RULE_KEYS = [
  'id',
  'steer',
  'boost',
  'boosting',
  'grounded',
  'status',
  'stateTimer',
  'respawnIn',
  'invulnerable',
  'hitStun',
  'wheelSpin',
  'spawnX',
  'spawnZ',
  'airTime',
  'flipTime',
] as const satisfies readonly (keyof CarState)[];

export interface CylinderObstacle {
  /** Unique within the stage and stable while it is edited. */
  id: string;
  kind: 'mug';
  x: number;
  z: number;
  radius: number;
  height: number;
  rotation: number;
}

export interface BoxObstacle {
  id: string;
  kind: 'books';
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
  height: number;
  rotation: number;
}

export interface RampObstacle {
  id: string;
  kind: 'ramp';
  x: number;
  z: number;
  /** Half length along the ascending local X axis. */
  halfX: number;
  halfZ: number;
  /** Height at the high (+X local) end. */
  height: number;
  rotation: number;
}

export type StaticObstacle = CylinderObstacle | BoxObstacle | RampObstacle;

export type PropKind = 'pencil' | 'eraser';

export interface PropDefinition {
  id: string;
  kind: PropKind;
  x: number;
  z: number;
  angle: number;
  /** Size against the ordinary pencil or eraser (1). */
  scale: number;
}

export interface PropState extends PropDefinition {
  y: number;
  vx: number;
  vy: number;
  vz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  falling: boolean;
  respawnTimer: number;
  home: PropDefinition;
}

export type TableArtPreset = 'dohyo' | 'wood' | 'circuit' | 'grid';

/**
 * What is painted on the table top. An image is named by where its pixels are kept:
 * `local:<name>` on this device, `croquet:<data id>` on the session's file server.
 */
export type TableArt = { kind: 'preset'; id: TableArtPreset } | { kind: 'image'; src: string };

export interface SpawnPoint {
  x: number;
  z: number;
  heading: number;
}

/** An arena: plain data, so that it can be edited, sent to the other players and put in a snapshot. */
export interface StageDefinition {
  id: StageId;
  label: string;
  description: string;
  art: TableArt;
  obstacles: StaticObstacle[];
  props: PropDefinition[];
  spawns: Record<PlayerId, SpawnPoint>;
  respawnPoints: { x: number; z: number }[];
}

export type GameEvent =
  | { type: 'countdown'; value: number }
  | { type: 'go' }
  | { type: 'crash'; x: number; y: number; z: number; strength: number; boosted: boolean }
  | { type: 'bump'; x: number; y: number; z: number; strength: number; surface: 'mug' | 'books' | 'prop' }
  | { type: 'jump'; player: PlayerId }
  | { type: 'land'; player: PlayerId; x: number; y: number; z: number; strength: number }
  | { type: 'boost'; player: PlayerId }
  | { type: 'fall'; player: PlayerId; x: number; y: number; z: number; scoredBy: PlayerId | null }
  | { type: 'floor'; x: number; y: number; z: number }
  | { type: 'respawn'; player: PlayerId }
  | { type: 'win'; player: PlayerId };
