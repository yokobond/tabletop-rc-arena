import { describe, expect, it } from 'vitest';
import { applyArenaEdit, type ArenaEdit } from './arena';
import { ARENA_NAME_LIMIT, asCustomStage, cleanArenaName, readArenaFile, writeArenaFile } from './arenaFile';
import { STAGES } from './stages';
import type { StageDefinition } from './types';

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function edit(stage: StageDefinition, ...edits: ArenaEdit[]) {
  return edits.reduce((current, e) => {
    const next = applyArenaEdit(current, e);
    if (!next) throw new Error(`refused: ${JSON.stringify(e)}`);
    return next;
  }, stage);
}

/** Ids are given anew on loading, so two arenas are compared without them. */
const shape = (s: StageDefinition) => ({
  ...s,
  obstacles: s.obstacles.map(({ id: _id, ...o }) => o),
  props: s.props.map(({ id: _id, ...p }) => p),
});

describe('arena names', () => {
  it('are one trimmed line of limited length', () => {
    expect(cleanArenaName('  机の  上\n２  ')).toBe('机の 上 ２');
    expect(cleanArenaName('')).toBe('');
    expect(cleanArenaName(42)).toBe('');
    expect([...cleanArenaName('あ'.repeat(100))]).toHaveLength(ARENA_NAME_LIMIT);
    // Cut between characters, never inside one.
    expect([...cleanArenaName('🏁'.repeat(100))]).toHaveLength(ARENA_NAME_LIMIT);
  });
});

describe('saving any arena', () => {
  it('a preset is saved as a custom arena with the same things on the table', () => {
    const saved = asCustomStage(STAGES.ramps)!;
    expect(saved.id).toBe('custom');
    // Angles are brought within one turn; everything else is as it was.
    const sameAngle = (a: number, b: number) => expect(Math.cos(a - b)).toBeCloseTo(1, 6);
    expect(saved.obstacles).toHaveLength(STAGES.ramps.obstacles.length);
    saved.obstacles.forEach((o, i) => {
      const { rotation, id: _id, ...rest } = STAGES.ramps.obstacles[i];
      expect(o).toMatchObject(rest);
      sameAngle(o.rotation, rotation);
    });
    saved.props.forEach((p, i) => {
      const { angle, id: _id, ...rest } = STAGES.ramps.props[i];
      expect(p).toMatchObject(rest);
      sameAngle(p.angle, angle);
    });
    expect(saved.spawns.p1).toMatchObject({ x: STAGES.ramps.spawns.p1.x, z: STAGES.ramps.spawns.p1.z });
    expect(asCustomStage('ramps')).toBeNull();
    expect(asCustomStage(null)).toBeNull();
  });
});

describe('arena files', () => {
  const stage = edit(
    STAGES.standard,
    { op: 'add', item: 'ramp', x: 1, z: -1.1, rotation: 2 },
    { op: 'resize', id: 'o1', steps: 1 },
    { op: 'spawn', player: 'p2', x: 1.6, z: -0.3 },
    { op: 'art', art: { kind: 'preset', id: 'circuit' } },
  );

  it('an arena comes back the same from its file', () => {
    const content = readArenaFile(writeArenaFile('  サーキット  ', stage, null))!;
    expect(content.name).toBe('サーキット');
    expect(content.image).toBeNull();
    expect(shape(content.stage)).toEqual(shape(stage));
  });

  it('the picture travels in the file, and the arena does not keep the name it had on the other device', () => {
    const withPicture = edit(stage, { op: 'art', art: { kind: 'image', src: 'local:onlythere' } });
    const content = readArenaFile(writeArenaFile('写真', withPicture, PIXEL))!;
    expect(content.image).toBe(PIXEL);
    expect(content.stage.art).toEqual({ kind: 'preset', id: 'dohyo' });
    expect(shape({ ...content.stage, art: withPicture.art })).toEqual(shape(withPicture));

    // A file that lost its picture, or carries something that is not one, still gives the layout.
    for (const image of [null, 'https://example.com/a.png', 'data:text/html;base64,PGI+', 'data:image/svg+xml;base64,PHN2Zz4=', `${PIXEL}"onerror="x`]) {
      const plain = readArenaFile(writeArenaFile('写真', withPicture, image))!;
      expect(plain.image, String(image)).toBeNull();
      expect(plain.stage.art).toEqual({ kind: 'preset', id: 'dohyo' });
    }
    // A picture is only taken when the arena asks for one.
    expect(readArenaFile(writeArenaFile('絵柄', stage, PIXEL))!.image).toBeNull();
  });

  it('refuses what is not an arena file', () => {
    const good = JSON.parse(writeArenaFile('x', stage, null));
    for (const bad of ['', 'not json', '[]', 'null', '{}', JSON.stringify({ ...good, format: 'other' }), JSON.stringify({ ...good, version: 2 })]) {
      expect(readArenaFile(bad), bad.slice(0, 30)).toBeNull();
    }
    expect(readArenaFile(JSON.stringify({ ...good, stage: { ...good.stage, obstacles: 'many' } }))).toBeNull();
    expect(readArenaFile(JSON.stringify({ ...good, stage: 'ramps' }))).toBeNull();
    // A name that is not text is only a missing name.
    expect(readArenaFile(JSON.stringify({ ...good, name: { toString: 1 } }))!.name).toBe('');
  });
});
