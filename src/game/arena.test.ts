import { describe, expect, it } from 'vitest';
import { ARENA_ITEMS, MAX_OBSTACLES, MAX_PROPS, applyArenaEdit, findFreeSpot, footprintDistance, type ArenaEdit } from './arena';
import { STAGES } from './stages';
import type { StageDefinition, StagePreset } from './types';

const PRESETS: StagePreset[] = ['standard', 'ramps', 'sumo'];

function edit(stage: StageDefinition, ...edits: ArenaEdit[]) {
  let current = stage;
  for (const e of edits) {
    const next = applyArenaEdit(current, e);
    expect(next, JSON.stringify(e)).not.toBeNull();
    current = next!;
  }
  return current;
}

describe('editing an arena', () => {
  it.each(PRESETS)('%s can be edited: it follows the rules it is checked against', (id) => {
    const next = edit(STAGES[id], { op: 'art', art: { kind: 'preset', id: 'grid' } });
    expect(next.id).toBe('custom');
    expect(next.art).toEqual({ kind: 'preset', id: 'grid' });
    expect(next.obstacles).toEqual(STAGES[id].obstacles);
    expect(next.props).toEqual(STAGES[id].props);
    // The presets are left alone.
    expect(STAGES[id].id).toBe(id);
    expect(STAGES[id].art).toEqual({ kind: 'preset', id: 'dohyo' });
  });

  it('adds, moves and removes objects, keeping ids stable', () => {
    const added = edit(STAGES.sumo, { op: 'add', item: 'mug', x: 0, z: 1, rotation: 0 }, { op: 'add', item: 'pencil', x: 0, z: -1, rotation: 0.5 });
    expect(added.obstacles).toHaveLength(1);
    expect(added.props).toHaveLength(1);
    const mug = added.obstacles[0];
    const pencil = added.props[0];
    expect(mug.id).not.toBe(pencil.id);

    const moved = edit(added, { op: 'move', id: mug.id, x: 0.6, z: 0.9, rotation: 1 }, { op: 'move', id: pencil.id, x: -0.5, z: -1, rotation: 0 });
    expect(moved.obstacles[0]).toMatchObject({ id: mug.id, kind: 'mug', x: 0.6, z: 0.9, rotation: 1 });
    expect(moved.props[0]).toMatchObject({ id: pencil.id, kind: 'pencil', x: -0.5, z: -1, angle: 0 });

    const removed = edit(moved, { op: 'remove', id: mug.id });
    expect(removed.obstacles).toHaveLength(0);
    expect(removed.props[0].id).toBe(pencil.id);
    // A new object never reuses the id of one that is still there.
    const again = edit(removed, { op: 'add', item: 'books', x: 0, z: 1, rotation: 0 });
    expect(again.obstacles[0].id).not.toBe(pencil.id);
  });

  it('two people moving different objects both keep their change', () => {
    const base = edit(STAGES.standard, { op: 'art', art: { kind: 'preset', id: 'wood' } });
    const [a, b] = base.obstacles;
    // Each edit is applied to whatever the stage is by then, not to the stage its sender saw.
    const next = edit(base, { op: 'move', id: a.id, x: -0.5, z: 1.2, rotation: 0 }, { op: 'move', id: b.id, x: 0.5, z: -1.2, rotation: 0 });
    expect(next.obstacles[0]).toMatchObject({ x: -0.5, z: 1.2 });
    expect(next.obstacles[1]).toMatchObject({ x: 0.5, z: -1.2 });
  });

  it('keeps objects on the table', () => {
    const next = edit(STAGES.sumo, { op: 'add', item: 'mug', x: 99, z: -99, rotation: 0 });
    expect(next.obstacles[0].x).toBeLessThan(2.4);
    expect(next.obstacles[0].z).toBeGreaterThan(-1.6);
  });

  it('refuses an obstacle on a start position, and a start position on an obstacle', () => {
    const { p1 } = STAGES.sumo.spawns;
    expect(applyArenaEdit(STAGES.sumo, { op: 'add', item: 'mug', x: p1.x, z: p1.z, rotation: 0 })).toBeNull();
    expect(applyArenaEdit(STAGES.sumo, { op: 'add', item: 'pencil', x: p1.x, z: p1.z, rotation: 0 })).toBeNull();
    const withMug = edit(STAGES.sumo, { op: 'add', item: 'mug', x: 0, z: 1, rotation: 0 });
    expect(applyArenaEdit(withMug, { op: 'spawn', player: 'p1', x: 0, z: 1 })).toBeNull();
    expect(applyArenaEdit(withMug, { op: 'spawn', player: 'p1', x: 0.1, z: 0.6 })).toBeNull();
  });

  it('moves a start position and turns both cars to face each other', () => {
    const next = edit(STAGES.sumo, { op: 'spawn', player: 'p1', x: 0, z: 1 }, { op: 'spawn', player: 'p2', x: 0, z: -1 });
    expect(next.spawns.p1).toMatchObject({ x: 0, z: 1 });
    // Forward is (sin heading, cos heading): p1 looks towards -Z, p2 towards +Z.
    expect(Math.cos(next.spawns.p1.heading)).toBeCloseTo(-1, 3);
    expect(Math.cos(next.spawns.p2.heading)).toBeCloseTo(1, 3);
    expect(applyArenaEdit(next, { op: 'spawn', player: 'p2', x: 0.2, z: 0.9 })).toBeNull();
  });

  it('refuses a prop inside an obstacle or another prop, but lets obstacles overlap', () => {
    const base = edit(STAGES.sumo, { op: 'add', item: 'books', x: 0, z: 1, rotation: 0 });
    expect(applyArenaEdit(base, { op: 'add', item: 'eraser', x: 0.2, z: 1.1, rotation: 0 })).toBeNull();
    const withEraser = edit(base, { op: 'add', item: 'eraser', x: 0, z: -1, rotation: 0 });
    expect(applyArenaEdit(withEraser, { op: 'add', item: 'eraser', x: 0.05, z: -1, rotation: 0 })).toBeNull();
    // Moving the books onto the eraser is refused as well.
    expect(applyArenaEdit(withEraser, { op: 'move', id: base.obstacles[0].id, x: 0, z: -1, rotation: 0 })).toBeNull();
    expect(applyArenaEdit(base, { op: 'add', item: 'mug', x: 0.3, z: 1, rotation: 0 })).not.toBeNull();
  });

  it('stops at the limits', () => {
    let stage = STAGES.sumo;
    for (let i = 0; i < MAX_OBSTACLES; i++) stage = edit(stage, findFreeSpot(stage, 'mug')!);
    expect(stage.obstacles).toHaveLength(MAX_OBSTACLES);
    expect(applyArenaEdit(stage, { op: 'add', item: 'mug', x: 0, z: 1.3, rotation: 0 })).toBeNull();

    stage = STAGES.sumo;
    for (let i = 0; i < MAX_PROPS; i++) stage = edit(stage, findFreeSpot(stage, 'eraser')!);
    expect(stage.props).toHaveLength(MAX_PROPS);
    expect(findFreeSpot(stage, 'eraser')).toBeNull();
  });

  it.each(ARENA_ITEMS.map((i) => i.type))('finds a free spot for a new %s on every preset', (item) => {
    for (const id of PRESETS) expect(findFreeSpot(STAGES[id], item), id).not.toBeNull();
  });

  it('respawn points stay clear of obstacles and always include the start positions', () => {
    const stage = edit(
      STAGES.sumo,
      { op: 'add', item: 'platform', x: 0, z: 0, rotation: 0.4 },
      { op: 'add', item: 'ramp', x: 0.85, z: 0.9, rotation: 1 },
      { op: 'add', item: 'mug', x: -1.7, z: -0.9, rotation: 0 },
    );
    expect(stage.respawnPoints.length).toBeGreaterThan(2);
    for (const p of stage.respawnPoints) {
      for (const o of stage.obstacles) expect(footprintDistance(o, p.x, p.z)).toBeGreaterThanOrEqual(0.34);
    }
    for (const s of [stage.spawns.p1, stage.spawns.p2]) {
      expect(stage.respawnPoints.some((p) => p.x === s.x && p.z === s.z)).toBe(true);
    }
  });
});

describe('loading an arena', () => {
  it('a preset by its id is the preset itself', () => {
    expect(applyArenaEdit(STAGES.sumo, { op: 'load', stage: 'ramps' })).toBe(STAGES.ramps);
  });

  it('a saved arena comes back the same after a trip through JSON', () => {
    const stage = edit(
      STAGES.standard,
      { op: 'add', item: 'ramp', x: 1, z: -1.1, rotation: 2 },
      { op: 'art', art: { kind: 'image', src: 'local:abc' } },
      { op: 'spawn', player: 'p2', x: 1.6, z: -0.3 },
    );
    const loaded = applyArenaEdit(STAGES.sumo, { op: 'load', stage: JSON.parse(JSON.stringify(stage)) })!;
    const shape = (s: StageDefinition) => ({
      ...s,
      obstacles: s.obstacles.map(({ id: _id, ...o }) => o),
      props: s.props.map(({ id: _id, ...p }) => p),
    });
    expect(shape(loaded)).toEqual(shape(stage));
    expect(new Set([...loaded.obstacles, ...loaded.props].map((i) => i.id)).size).toBe(loaded.obstacles.length + loaded.props.length);
  });

  it('rejects what is not an arena and cuts sizes down to something sane', () => {
    const good = JSON.parse(JSON.stringify(edit(STAGES.standard, { op: 'art', art: { kind: 'preset', id: 'wood' } })));
    for (const bad of [null, 42, 'nowhere', {}, { ...good, obstacles: 'many' }, { ...good, spawns: { p1: good.spawns.p1 } }]) {
      expect(applyArenaEdit(STAGES.sumo, { op: 'load', stage: bad })).toBeNull();
    }
    expect(applyArenaEdit(STAGES.sumo, { op: 'load', stage: { ...good, obstacles: [{ kind: 'tank', x: 0, z: 0, rotation: 0, height: 1 }] } })).toBeNull();
    expect(applyArenaEdit(STAGES.sumo, { op: 'load', stage: { ...good, props: [{ kind: 'pencil', x: NaN, z: 0, angle: 0 }] } })).toBeNull();

    const huge = { ...good, obstacles: [{ kind: 'mug', x: -1.5, z: 1.2, rotation: 0, radius: 50, height: 50 }], art: { kind: 'image', src: 'https://example.com/a.png' } };
    const loaded = applyArenaEdit(STAGES.sumo, { op: 'load', stage: huge })!;
    expect(loaded.obstacles[0]).toMatchObject({ kind: 'mug', radius: 0.4, height: 0.6 });
    // Only images this app stored itself are accepted.
    expect(loaded.art).toEqual({ kind: 'preset', id: 'dohyo' });
  });

  it('ignores edits that are not edits', () => {
    for (const bad of [null, undefined, 'add', {}, { op: 'explode' }, { op: 'move', id: 'o1' }, { op: 'spawn', player: 'p3', x: 0, z: 0 }]) {
      expect(applyArenaEdit(STAGES.standard, bad as unknown as ArenaEdit)).toBeNull();
    }
  });
});
