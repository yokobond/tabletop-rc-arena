import { describe, expect, it } from 'vitest';
import { IDENTITY, MAX_PIECES, emptyDesign, putPiece, readMadePart, type CarDesign } from './bodyParts';
import { CAR_NAME_LIMIT, carFileName, cleanCarName, readCarFile, writeCarFile } from './carFile';
import { bakeMesh, meshIdOf, type SourceMesh } from './stlMesh';

const lookCache = new Map<number, Uint8Array>();

function makeLook(width = 40) {
  const cached = lookCache.get(width);
  if (cached) return cached;
  const p = [0, 0, 0, width, 0, 0, 0, 20, 0, width, 20, 0, 0, 0, 30, width, 0, 30, 0, 20, 30, width, 20, 30];
  const quads = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  const mesh: SourceMesh = {
    pos: new Float32Array(p),
    idx: Uint32Array.from(quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d])),
  };
  const bytes = bakeMesh(
    mesh,
    0.001,
    { shape: { kind: 'box', size: [width * 0.001, 0.02, 0.03] }, center: [width / 2, 10, 15], axis: 1, volume: 0 },
    [0, 20, 0],
  ).bytes;
  lookCache.set(width, bytes);
  return bytes;
}

describe('car names and filenames', () => {
  it('cleans car names to one trimmed line within the limit without splitting surrogate pairs', () => {
    expect(cleanCarName('  テスト  カー\n２  ')).toBe('テスト カー ２');
    expect(cleanCarName('')).toBe('');
    expect(cleanCarName(123)).toBe('');
    expect([...cleanCarName('あ'.repeat(100))]).toHaveLength(CAR_NAME_LIMIT);
    expect([...cleanCarName('🚗'.repeat(100))]).toHaveLength(CAR_NAME_LIMIT);
  });

  it('formats safe car file names', () => {
    expect(carFileName('ブルドーザー/改:1')).toBe('ブルドーザー_改_1.car.json');
    expect(carFileName('   ')).toBe('car.car.json');
  });
});

describe('car files', () => {
  it('round-trips an empty chassis design', () => {
    const empty = emptyDesign();
    const text = writeCarFile('ノーマル風', empty);
    const read = readCarFile(text)!;
    expect(read.name).toBe('ノーマル風');
    expect(read.design).toEqual(empty);
    expect(read.meshes).toEqual([]);
    expect(read.missingLooks).toBe(false);
  });

  it('round-trips stock, plain made-up, and STL parts while deduplicating and filtering meshes', () => {
    const bytes = makeLook(40);
    const extraBytes = makeLook(50);
    const meshId = meshIdOf(bytes);
    const stlPart = readMadePart({
      name: 'はこ',
      shape: { kind: 'box', size: [0.04, 0.02, 0.03] },
      mass: 0.02,
      color: '#22C55E',
      mesh: meshId,
      turn: [0, 20, 0],
    })!;
    const plainPart = readMadePart({
      name: 'おもり',
      shape: { kind: 'cylinder', r: 0.015, h: 0.04 },
      mass: 0.05,
      color: '#EF4444',
    })!;

    // Place pieces onto the chassis deck (top is y = 0.105).
    let d: CarDesign = emptyDesign();
    d = putPiece(d, { id: 'p1', kind: 'brick', x: 0, y: 0.129, z: 0, rot: IDENTITY, adhesive: 'superglue', seat: [0, 1, 0] }).design!;
    d = putPiece(d, {
      id: 'p2',
      kind: 'made',
      made: plainPart,
      x: 0,
      y: 0.125,
      z: -0.1,
      rot: IDENTITY,
      adhesive: 'superglue',
      seat: [0, 1, 0],
    }).design!;
    d = putPiece(d, {
      id: 'p3',
      kind: 'made',
      made: stlPart,
      x: 0,
      y: 0.115,
      z: 0.12,
      rot: IDENTITY,
      adhesive: 'hotglue',
      seat: [0, 1, 0],
    }).design!;

    // Pass duplicate used mesh and an unused mesh: only one used mesh should be serialized.
    const text = writeCarFile('  ブルドーザー\n1号  ', d, [bytes, bytes, extraBytes]);
    const parsed = JSON.parse(text) as { meshes?: string[] };
    expect(parsed.meshes).toHaveLength(1);

    const read1 = readCarFile(text)!;
    const read2 = readCarFile(text)!;
    expect(read1).toEqual(read2);
    expect(read1.name).toBe('ブルドーザー 1号');
    expect(read1.design).toEqual(d);
    expect(read1.missingLooks).toBe(false);
    expect(read1.meshes).toHaveLength(1);
    expect([...read1.meshes[0]]).toEqual([...bytes]);
  });

  it('falls back to plain shape and flags missingLooks when STL meshes are missing, corrupt, or hash-mismatched', () => {
    const bytes = makeLook(40);
    const wrongBytes = makeLook(44);
    const meshId = meshIdOf(bytes);
    const stlPart = readMadePart({
      name: 'はこ',
      shape: { kind: 'box', size: [0.04, 0.02, 0.03] },
      mass: 0.02,
      color: '#22C55E',
      mesh: meshId,
      turn: [0, 20, 0],
    })!;
    const d = putPiece(emptyDesign(), {
      id: 'p1',
      kind: 'made',
      made: stlPart,
      x: 0,
      y: 0.115,
      z: 0.12,
      rot: IDENTITY,
      adhesive: 'superglue',
      seat: [0, 1, 0],
    }).design!;

    // 1. Missing mesh
    const noMeshRead = readCarFile(writeCarFile('欠損', d, []))!;
    expect(noMeshRead.missingLooks).toBe(true);
    expect(noMeshRead.meshes).toEqual([]);
    expect(noMeshRead.design.pieces[0].made).toEqual({
      name: 'はこ',
      shape: { kind: 'box', size: [0.04, 0.02, 0.03] },
      mass: 0.02,
      color: '#22C55E',
    });

    // 2. Corrupt base64 mesh
    const corrupt = JSON.parse(writeCarFile('破損', d, [bytes])) as { meshes: string[] };
    corrupt.meshes = [btoa('not a mesh')];
    const corruptRead = readCarFile(JSON.stringify(corrupt))!;
    expect(corruptRead.missingLooks).toBe(true);
    expect(corruptRead.meshes).toEqual([]);
    expect(corruptRead.design.pieces[0].made?.mesh).toBeUndefined();

    // 3. Hash mismatch (valid mesh bytes for a different mesh id)
    const mismatch = JSON.parse(writeCarFile('不一致', d, [bytes])) as { meshes: string[] };
    let wrongBin = '';
    for (const b of wrongBytes) wrongBin += String.fromCharCode(b);
    mismatch.meshes = [btoa(wrongBin)];
    const mismatchRead = readCarFile(JSON.stringify(mismatch))!;
    expect(mismatchRead.missingLooks).toBe(true);
    expect(mismatchRead.meshes).toEqual([]);
    expect(mismatchRead.design.pieces[0].made?.mesh).toBeUndefined();
  });

  it('rejects invalid JSON, wrong format/version, or invalid designs', () => {
    const d = putPiece(emptyDesign(), {
      id: 'p1',
      kind: 'cube',
      x: 0,
      y: 0.14,
      z: 0,
      rot: IDENTITY,
      adhesive: 'superglue',
      seat: [0, 1, 0],
    }).design!;
    const good = JSON.parse(writeCarFile('ok', d));

    for (const bad of [
      '',
      'not json',
      '[]',
      'null',
      '{}',
      JSON.stringify({ ...good, format: 'rc-sumo-arena' }),
      JSON.stringify({ ...good, format: 'rc-sumo-parts' }),
      JSON.stringify({ ...good, version: 2 }),
      JSON.stringify({ ...good, design: 'bad' }),
      JSON.stringify({ ...good, design: { pieces: 'many', joints: [] } }),
    ]) {
      expect(readCarFile(bad), bad.slice(0, 40)).toBeNull();
    }

    // Too many pieces
    const tooMany = Array.from({ length: MAX_PIECES + 1 }, (_, i) => ({
      id: `p${i + 1}`,
      kind: 'cube',
      x: 0,
      y: 0.14 + i * 0.08,
      z: 0,
      rot: IDENTITY,
      adhesive: 'superglue',
    }));
    expect(readCarFile(JSON.stringify({ ...good, design: { pieces: tooMany, joints: [] } }))).toBeNull();

    // Overlapping pieces (two cubes at the same spot)
    const overlap = [
      { id: 'p1', kind: 'cube', x: 0, y: 0.14, z: 0, rot: IDENTITY, adhesive: 'superglue' },
      { id: 'p2', kind: 'cube', x: 0, y: 0.14, z: 0, rot: IDENTITY, adhesive: 'superglue' },
    ];
    expect(
      readCarFile(
        JSON.stringify({
          ...good,
          design: {
            pieces: overlap,
            joints: [{ a: 'base', b: 'p1', kind: 'superglue' }],
          },
        }),
      ),
    ).toBeNull();

    // Heavy design (exceeding MAX_PIECE_MASS 0.6 kg)
    const heavyPart = readMadePart({ name: 'おもり', shape: { kind: 'box', size: [0.03, 0.03, 0.03] }, mass: 0.2, color: '#111111' })!;
    const heavyPieces = [0, 1, 2, 3].map((i) => ({
      id: `p${i + 1}`,
      kind: 'made',
      made: heavyPart,
      x: -0.09 + i * 0.06,
      y: 0.12,
      z: 0,
      rot: IDENTITY,
      adhesive: 'superglue',
    }));
    expect(
      readCarFile(
        JSON.stringify({
          ...good,
          design: {
            pieces: heavyPieces,
            joints: heavyPieces.map((p) => ({ a: 'base', b: p.id, kind: 'superglue' })),
          },
        }),
      ),
    ).toBeNull();

    // Non-string name safely turns into empty string
    expect(readCarFile(JSON.stringify({ ...good, name: { bad: 1 } }))!.name).toBe('');
  });
});
