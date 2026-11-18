/**
 * Editing an arena. `applyArenaEdit` is the only way a stage changes: the local store calls it
 * directly and the replicated model calls it for every edit event, so both keep the same rules.
 * Everything here is plain arithmetic on plain data (no DOM, no clock, no randomness).
 */
import { TABLE_SCALE_MAX, tableHalfX, tableHalfZ } from './constants';
import { STAGES, isStagePreset } from './stages';
import type { PlayerId, PropDefinition, PropKind, StageDefinition, StaticObstacle, TableArt, TableArtPreset } from './types';

export const MAX_OBSTACLES = 16;
export const MAX_PROPS = 8;
/** One press of a rotate button. */
export const ROTATE_STEP = Math.PI / 12;
/** One press of a size button makes an object this many times larger, or smaller. */
export const RESIZE_STEP = 1.2;
/** How far a size can go; an object is resized as a whole, so the first limit reached stops it. */
const SIZE_LIMITS = {
  mug: { radius: [0.1, 0.45], height: [0.1, 0.7] },
  box: { half: [0.1, 1], height: [0.05, 0.6] },
  prop: { scale: [0.55, 2.1] },
} as const;
/** The table never gets smaller than the standard one: the presets are laid out to fill that. */
const TABLE_SCALE_LIMITS = [1, TABLE_SCALE_MAX] as const;

/** How close to the table's edge the centre of an object may be. */
const EDGE_MARGIN = 0.12;
/** Free table around a start position: a car is about 0.3 from its centre to a corner. */
const SPAWN_CLEARANCE = 0.34;
export const SPAWN_EDGE_MARGIN = 0.35;
const SPAWN_SEPARATION = 0.8;
/** A car drops back in at these points, so they stay further from anything solid. */
const RESPAWN_CLEARANCE = 0.4;
const RESPAWN_INSET = 0.7;

export type ArenaItemType = 'mug' | 'books' | 'platform' | 'ramp' | 'pencil' | 'eraser';
export type ArenaList = 'obstacles' | 'props';

/** The palette: what can be put on the table, with the sizes the presets use. */
export const ARENA_ITEMS: { type: ArenaItemType; label: string; list: ArenaList }[] = [
  { type: 'mug', label: 'マグ', list: 'obstacles' },
  { type: 'books', label: '本', list: 'obstacles' },
  { type: 'platform', label: '高台', list: 'obstacles' },
  { type: 'ramp', label: 'スロープ', list: 'obstacles' },
  { type: 'pencil', label: '鉛筆', list: 'props' },
  { type: 'eraser', label: '消しゴム', list: 'props' },
];

export const TABLE_ART_PRESETS: { id: TableArtPreset; label: string }[] = [
  { id: 'dohyo', label: '土俵' },
  { id: 'wood', label: '木目' },
  { id: 'circuit', label: 'サーキット' },
  { id: 'grid', label: '方眼' },
];

export type ArenaEdit =
  | { op: 'add'; item: ArenaItemType; x: number; z: number; rotation: number }
  | { op: 'move'; id: string; x: number; z: number; rotation: number }
  | { op: 'remove'; id: string }
  /** Larger (positive) or smaller (negative) by a number of steps, keeping the proportions. */
  | { op: 'resize'; id: string; steps: number }
  | { op: 'spawn'; player: PlayerId; x: number; z: number }
  | { op: 'art'; art: TableArt }
  /** Another size of table, against the standard one. Everything on it keeps its place against the table. */
  | { op: 'table'; scale: number }
  /**
   * A preset's id, or a whole arena (a saved one, or the one before an undo). A preset can be
   * asked for on a table of another size; a whole arena says its own.
   */
  | { op: 'load'; stage: unknown; tableScale?: number };

type Table = Pick<StageDefinition, 'tableScale'>;

const PLAYERS: PlayerId[] = ['p1', 'p2'];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round = (v: number) => Math.round(v * 1000) / 1000;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const within = (v: number, [lo, hi]: readonly [number, number]) => v >= lo && v <= hi;
const limit = (v: number, [lo, hi]: readonly [number, number]) => clamp(v, lo, hi);

/** Keeps an angle within one turn, so that repeated rotating never grows it. */
function wrapAngle(a: number) {
  const turn = Math.PI * 2;
  const wrapped = ((((a + Math.PI) % turn) + turn) % turn) - Math.PI;
  return Math.round(wrapped * 10000) / 10000;
}

/** The nearest place on the table where the centre of an object may be. */
export function clampToTable(table: Table, x: number, z: number, margin = EDGE_MARGIN) {
  const halfX = tableHalfX(table);
  const halfZ = tableHalfZ(table);
  return { x: round(clamp(x, -halfX + margin, halfX - margin)), z: round(clamp(z, -halfZ + margin, halfZ - margin)) };
}

/** Distance from a point to an obstacle's outline on the table; 0 inside it. */
export function footprintDistance(o: StaticObstacle, x: number, z: number) {
  const dx = x - o.x;
  const dz = z - o.z;
  if (o.kind === 'mug') return Math.max(0, Math.hypot(dx, dz) - o.radius);
  const c = Math.cos(o.rotation);
  const s = Math.sin(o.rotation);
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.hypot(Math.max(0, Math.abs(lx) - o.halfX), Math.max(0, Math.abs(lz) - o.halfZ));
}

/** A prop as a row of circles along its long (local X) axis: enough to tell what it touches. */
function propCircles(p: { kind: PropKind; x: number; z: number; angle: number; scale: number }) {
  const pencil = p.kind === 'pencil';
  const from = (pencil ? -0.3 : -0.05) * p.scale;
  const to = (pencil ? 0.36 : 0.05) * p.scale;
  const count = pencil ? 6 : 2;
  const r = (pencil ? 0.05 : 0.075) * p.scale;
  const ax = Math.cos(p.angle);
  const az = -Math.sin(p.angle);
  return Array.from({ length: count }, (_, i) => {
    const along = from + ((to - from) * i) / (count - 1);
    return { x: p.x + ax * along, z: p.z + az * along, r };
  });
}

function obstacleOf(type: ArenaItemType, id: string, x: number, z: number, rotation: number): StaticObstacle | null {
  if (type === 'mug') return { id, kind: 'mug', x, z, radius: 0.24, height: 0.34, rotation };
  if (type === 'books') return { id, kind: 'books', x, z, halfX: 0.5, halfZ: 0.34, height: 0.27, rotation };
  if (type === 'platform') return { id, kind: 'books', x, z, halfX: 0.42, halfZ: 0.42, height: 0.3, rotation };
  if (type === 'ramp') return { id, kind: 'ramp', x, z, halfX: 0.55, halfZ: 0.27, height: 0.34, rotation };
  return null;
}

/** The same obstacle a number of size steps larger or smaller, or null when that is out of range. */
function resized(o: StaticObstacle, factor: number): StaticObstacle | null {
  const height = round(o.height * factor);
  if (o.kind === 'mug') {
    const radius = round(o.radius * factor);
    return within(radius, SIZE_LIMITS.mug.radius) && within(height, SIZE_LIMITS.mug.height) ? { ...o, radius, height } : null;
  }
  const halfX = round(o.halfX * factor);
  const halfZ = round(o.halfZ * factor);
  const { half } = SIZE_LIMITS.box;
  return within(halfX, half) && within(halfZ, half) && within(height, SIZE_LIMITS.box.height) ? { ...o, halfX, halfZ, height } : null;
}

/** An id no object of the stage has: one more than the largest number in use. */
function nextId(stage: StageDefinition) {
  let max = 0;
  for (const item of [...stage.obstacles, ...stage.props]) {
    const n = Number(/\d+$/.exec(item.id)?.[0] ?? 0);
    if (n > max) max = n;
  }
  return `n${max + 1}`;
}

function respawnPointsFor(stage: Pick<StageDefinition, 'tableScale' | 'obstacles' | 'props'>, spawns: StageDefinition['spawns']) {
  const points: { x: number; z: number }[] = [];
  const xs = [-1, -0.5, 0, 0.5, 1].map((f) => round(f * (tableHalfX(stage) - RESPAWN_INSET)));
  const zs = [-1, 0, 1].map((f) => round(f * (tableHalfZ(stage) - RESPAWN_INSET)));
  // Props wander, but they are put back where they started, so those places are left out too.
  const circles = stage.props.flatMap(propCircles);
  for (const x of xs) {
    for (const z of zs) {
      const clear =
        stage.obstacles.every((o) => footprintDistance(o, x, z) >= RESPAWN_CLEARANCE) &&
        circles.every((c) => Math.hypot(c.x - x, c.z - z) >= RESPAWN_CLEARANCE);
      if (clear) points.push({ x, z });
    }
  }
  // The start positions are always free, so there is somewhere to come back to on a crowded table.
  for (const id of PLAYERS) points.push({ x: spawns[id].x, z: spawns[id].z });
  return points;
}

function isValid(stage: StageDefinition) {
  if (stage.obstacles.length > MAX_OBSTACLES || stage.props.length > MAX_PROPS) return false;
  const halfX = tableHalfX(stage);
  const halfZ = tableHalfZ(stage);
  const spawns = PLAYERS.map((id) => stage.spawns[id]);
  if (Math.hypot(spawns[0].x - spawns[1].x, spawns[0].z - spawns[1].z) < SPAWN_SEPARATION) return false;
  for (const s of spawns) {
    if (Math.abs(s.x) > halfX - SPAWN_EDGE_MARGIN || Math.abs(s.z) > halfZ - SPAWN_EDGE_MARGIN) return false;
    if (stage.obstacles.some((o) => footprintDistance(o, s.x, s.z) < SPAWN_CLEARANCE)) return false;
  }
  // A prop is a moving body: starting inside something solid would throw it across the table.
  const circles = stage.props.map(propCircles);
  for (let i = 0; i < circles.length; i++) {
    for (const c of circles[i]) {
      if (Math.abs(c.x) > halfX - c.r || Math.abs(c.z) > halfZ - c.r) return false;
      if (spawns.some((s) => Math.hypot(c.x - s.x, c.z - s.z) < SPAWN_CLEARANCE + c.r)) return false;
      if (stage.obstacles.some((o) => footprintDistance(o, c.x, c.z) < c.r + 0.02)) return false;
      for (let j = 0; j < i; j++) {
        if (circles[j].some((d) => Math.hypot(c.x - d.x, c.z - d.z) < c.r + d.r)) return false;
      }
    }
  }
  return true;
}

/** Turns an edited stage into the custom arena, or null when the layout breaks a rule. */
function finish(stage: StageDefinition): StageDefinition | null {
  const { p1, p2 } = stage.spawns;
  const spawns = {
    p1: { x: p1.x, z: p1.z, heading: wrapAngle(Math.atan2(p2.x - p1.x, p2.z - p1.z)) },
    p2: { x: p2.x, z: p2.z, heading: wrapAngle(Math.atan2(p1.x - p2.x, p1.z - p2.z)) },
  };
  const next: StageDefinition = {
    ...stage,
    id: 'custom',
    label: 'カスタム',
    description: '自分で並べたアリーナ',
    spawns,
    respawnPoints: respawnPointsFor(stage, spawns),
  };
  return isValid(next) ? next : null;
}

/**
 * The same arena on a table of another size, or null when it does not fit there. Everything
 * keeps its place against the table, and so against the picture on it, and its own size: a
 * larger table has more room between things and before the edge.
 */
function resizeTable(stage: StageDefinition, scale: unknown): StageDefinition | null {
  if (!num(scale)) return null;
  const tableScale = round(scale);
  if (!within(tableScale, TABLE_SCALE_LIMITS)) return null;
  if (tableScale === stage.tableScale) return stage;
  // A preset is laid out from its standard table every time, so going back gives the preset itself.
  const base = stage.id === 'custom' ? stage : STAGES[stage.id];
  if (tableScale === base.tableScale) return base;
  const factor = tableScale / base.tableScale;
  const at = <T extends { x: number; z: number }>(p: T): T => ({ ...p, x: round(p.x * factor), z: round(p.z * factor) });
  const next: StageDefinition = {
    ...base,
    tableScale,
    obstacles: base.obstacles.map(at),
    props: base.props.map(at),
    spawns: { p1: at(base.spawns.p1), p2: at(base.spawns.p2) },
    respawnPoints: base.respawnPoints.map(at),
  };
  // A preset on another table is still that preset; an arena somebody laid out is checked as one.
  if (next.id === 'custom') return finish(next);
  return isValid(next) ? next : null;
}

function readArt(value: unknown): TableArt | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'preset') {
    const found = TABLE_ART_PRESETS.find((p) => p.id === value.id);
    return found ? { kind: 'preset', id: found.id } : null;
  }
  if (value.kind === 'image' && typeof value.src === 'string' && value.src.length <= 512 && /^(local|croquet):./.test(value.src)) {
    return { kind: 'image', src: value.src };
  }
  return null;
}

/** Rebuilds a whole arena from data that may come from another browser or an old save. */
function readStage(value: unknown): StageDefinition | null {
  if (isStagePreset(value)) return STAGES[value];
  if (!isRecord(value) || !Array.isArray(value.obstacles) || !Array.isArray(value.props) || !isRecord(value.spawns)) return null;
  if (value.obstacles.length > MAX_OBSTACLES || value.props.length > MAX_PROPS) return null;
  // Arenas saved before the table could be resized have the standard table.
  const tableScale = value.tableScale === undefined ? 1 : num(value.tableScale) ? round(limit(value.tableScale, TABLE_SCALE_LIMITS)) : null;
  if (tableScale === null) return null;
  const table = { tableScale };

  const obstacles: StaticObstacle[] = [];
  for (const raw of value.obstacles as unknown[]) {
    if (!isRecord(raw) || !num(raw.x) || !num(raw.z) || !num(raw.rotation) || !num(raw.height)) return null;
    const id = `o${obstacles.length + 1}`;
    const at = { id, ...clampToTable(table, raw.x, raw.z), rotation: wrapAngle(raw.rotation) };
    if (raw.kind === 'mug' && num(raw.radius)) {
      obstacles.push({ ...at, kind: 'mug', radius: limit(raw.radius, SIZE_LIMITS.mug.radius), height: limit(raw.height, SIZE_LIMITS.mug.height) });
    } else if ((raw.kind === 'books' || raw.kind === 'ramp') && num(raw.halfX) && num(raw.halfZ)) {
      obstacles.push({
        ...at,
        kind: raw.kind,
        halfX: limit(raw.halfX, SIZE_LIMITS.box.half),
        halfZ: limit(raw.halfZ, SIZE_LIMITS.box.half),
        height: limit(raw.height, SIZE_LIMITS.box.height),
      });
    } else return null;
  }

  const props: PropDefinition[] = [];
  for (const raw of value.props as unknown[]) {
    if (!isRecord(raw) || !num(raw.x) || !num(raw.z) || !num(raw.angle)) return null;
    if (raw.kind !== 'pencil' && raw.kind !== 'eraser') return null;
    // Arenas saved before props could be resized have no scale.
    const scale = raw.scale === undefined ? 1 : num(raw.scale) ? limit(raw.scale, SIZE_LIMITS.prop.scale) : null;
    if (scale === null) return null;
    props.push({ id: `p${props.length + 1}`, kind: raw.kind, ...clampToTable(table, raw.x, raw.z), angle: wrapAngle(raw.angle), scale });
  }

  const spawn = (raw: unknown) => (isRecord(raw) && num(raw.x) && num(raw.z) ? { x: round(raw.x), z: round(raw.z), heading: 0 } : null);
  const p1 = spawn(value.spawns.p1);
  const p2 = spawn(value.spawns.p2);
  if (!p1 || !p2) return null;

  return finish({
    id: 'custom',
    label: '',
    description: '',
    tableScale,
    art: readArt(value.art) ?? { kind: 'preset', id: 'dohyo' },
    obstacles,
    props,
    spawns: { p1, p2 },
    respawnPoints: [],
  });
}

/**
 * The stage after one edit, or null when the edit is malformed or would break a rule (then
 * nothing changes). Any edit makes the stage the custom arena, but loading a preset or putting
 * a preset on a table of another size.
 */
export function applyArenaEdit(stage: StageDefinition, edit: ArenaEdit): StageDefinition | null {
  if (typeof edit !== 'object' || edit === null) return null;
  switch (edit.op) {
    case 'load': {
      const loaded = readStage(edit.stage);
      if (!loaded || loaded.id === 'custom' || edit.tableScale === undefined) return loaded;
      return resizeTable(loaded, edit.tableScale);
    }

    case 'table': {
      const next = resizeTable(stage, edit.scale);
      return next === stage ? null : next;
    }

    case 'art': {
      const art = readArt(edit.art);
      return art ? finish({ ...stage, art }) : null;
    }

    case 'add': {
      if (!num(edit.x) || !num(edit.z) || !num(edit.rotation)) return null;
      const at = clampToTable(stage, edit.x, edit.z);
      const rotation = wrapAngle(edit.rotation);
      const id = nextId(stage);
      const obstacle = obstacleOf(edit.item, id, at.x, at.z, rotation);
      if (obstacle) return finish({ ...stage, obstacles: [...stage.obstacles, obstacle] });
      if (edit.item !== 'pencil' && edit.item !== 'eraser') return null;
      return finish({ ...stage, props: [...stage.props, { id, kind: edit.item, ...at, angle: rotation, scale: 1 }] });
    }

    case 'move': {
      if (!num(edit.x) || !num(edit.z) || !num(edit.rotation)) return null;
      const at = clampToTable(stage, edit.x, edit.z);
      const rotation = wrapAngle(edit.rotation);
      if (stage.obstacles.some((o) => o.id === edit.id)) {
        return finish({ ...stage, obstacles: stage.obstacles.map((o) => (o.id === edit.id ? { ...o, ...at, rotation } : o)) });
      }
      if (stage.props.some((p) => p.id === edit.id)) {
        return finish({ ...stage, props: stage.props.map((p) => (p.id === edit.id ? { ...p, ...at, angle: rotation } : p)) });
      }
      return null;
    }

    case 'remove': {
      const obstacles = stage.obstacles.filter((o) => o.id !== edit.id);
      const props = stage.props.filter((p) => p.id !== edit.id);
      if (obstacles.length === stage.obstacles.length && props.length === stage.props.length) return null;
      return finish({ ...stage, obstacles, props });
    }

    case 'resize': {
      if (!Number.isInteger(edit.steps) || edit.steps === 0 || Math.abs(edit.steps) > 8) return null;
      let factor = 1;
      for (let i = 0; i < Math.abs(edit.steps); i++) factor = edit.steps > 0 ? factor * RESIZE_STEP : factor / RESIZE_STEP;
      const obstacle = stage.obstacles.find((o) => o.id === edit.id);
      if (obstacle) {
        const next = resized(obstacle, factor);
        return next ? finish({ ...stage, obstacles: stage.obstacles.map((o) => (o === obstacle ? next : o)) }) : null;
      }
      const prop = stage.props.find((p) => p.id === edit.id);
      if (!prop) return null;
      const scale = round(prop.scale * factor);
      if (!within(scale, SIZE_LIMITS.prop.scale)) return null;
      return finish({ ...stage, props: stage.props.map((p) => (p === prop ? { ...p, scale } : p)) });
    }

    case 'spawn': {
      if ((edit.player !== 'p1' && edit.player !== 'p2') || !num(edit.x) || !num(edit.z)) return null;
      const at = clampToTable(stage, edit.x, edit.z, SPAWN_EDGE_MARGIN);
      return finish({ ...stage, spawns: { ...stage.spawns, [edit.player]: { ...at, heading: 0 } } });
    }

    default:
      return null;
  }
}

/** Where a new object from the palette can go: the free spot nearest the middle of the table. */
export function findFreeSpot(stage: StageDefinition, item: ArenaItemType): ArenaEdit | null {
  const spots: { x: number; z: number }[] = [];
  const step = 0.25;
  const nx = Math.floor((tableHalfX(stage) - 0.4) / step);
  const nz = Math.floor((tableHalfZ(stage) - 0.35) / step);
  for (let i = -nx; i <= nx; i++) {
    for (let j = -nz; j <= nz; j++) spots.push({ x: round(i * step), z: round(j * step) });
  }
  spots.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
  const edits = spots.map((spot): ArenaEdit => ({ op: 'add', item, ...spot, rotation: 0 }));
  // Obstacles may overlap, but a new one is easier to grab when it does not land on another.
  const apart = (spot: { x: number; z: number }) => stage.obstacles.every((o) => footprintDistance(o, spot.x, spot.z) > 0.45);
  return (
    edits.find((edit, i) => apart(spots[i]) && applyArenaEdit(stage, edit)) ?? edits.find((edit) => applyArenaEdit(stage, edit)) ?? null
  );
}
