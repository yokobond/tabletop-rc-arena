import { describe, expect, it } from 'vitest';
import { BASE, IDENTITY, emptyDesign, putPiece, sanitizeDesign, turnOrientation, type BodyPiece, type CarDesign, type PieceKind } from './bodyParts';
import {
  assemblyMass,
  assemblyOf,
  breakGroup,
  centerOf,
  groupOf,
  hangingOnAll,
  makeGroup,
  movePieces,
  newPieceIds,
  outerAdhesive,
  poseAssembly,
  putGroup,
  readAssembly,
  removePieces,
  seatAssembly,
  stuckTogether,
} from './assembly';

/** The chassis top is at y = 0.105. */
const DECK = 0.105;

function piece(id: string, kind: PieceKind, x: number, y: number, z: number): BodyPiece {
  return { id, kind, x, y, z, rot: IDENTITY, adhesive: 'superglue' };
}

function put(design: CarDesign, p: BodyPiece) {
  const result = putPiece(design, p);
  if (!result.design) throw new Error(`refused: ${result.problem}`);
  return result.design;
}

/** Two blocks stacked on the deck, and an eraser on its own further back. */
function stacked() {
  let d = put(emptyDesign(), piece('p1', 'cube', 0, DECK + 0.035, 0));
  d = put(d, piece('p2', 'cube', 0, DECK + 0.105, 0));
  d = put(d, piece('p3', 'eraser', 0, DECK + 0.02, -0.15));
  return d;
}

/** The two blocks as a part of their own. */
const tower = () => assemblyOf(stacked(), ['p1', 'p2'], 'タワー');

/** An assembly put on a car, its bottom on the deck at (x, z). */
function placed(design: CarDesign, x: number, z: number) {
  const asm = tower();
  const at = seatAssembly([x, DECK, z], [0, 1, 0], asm, IDENTITY);
  return poseAssembly(asm, IDENTITY, at.at, newPieceIds(design, asm.pieces.length), 'g1', at.seat);
}

describe('pieces made into one', () => {
  it('are what is stuck together through pieces, not through the chassis', () => {
    const d = stacked();
    expect(stuckTogether(d, 'p2')).toEqual(['p2', 'p1']);
    expect(stuckTogether(d, 'p3')).toEqual(['p3']);
  });

  it('are picked as one once grouped, and back to pieces when broken up', () => {
    const d = makeGroup(stacked(), ['p1', 'p2']);
    expect(groupOf(d, 'p1')).toEqual(['p1', 'p2']);
    expect(groupOf(d, 'p3')).toEqual(['p3']);
    expect(groupOf(breakGroup(d, 'p2'), 'p1')).toEqual(['p1']);
  });

  it('keep their group through a design sent elsewhere', () => {
    const d = makeGroup(stacked(), ['p1', 'p2']);
    expect(sanitizeDesign(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });

  it('come off together, with what hangs on them alone', () => {
    let d = makeGroup(stacked(), ['p1']);
    expect(hangingOnAll(d, ['p1'])).toEqual(['p2']);
    d = removePieces(d, ['p1']);
    expect(d.pieces.map((p) => p.id)).toEqual(['p3']);
  });
});

describe('assemblies', () => {
  it('are centered on the box around them, with their joints among themselves', () => {
    const asm = tower();
    expect(asm.pieces.map((p) => p.id)).toEqual(['a1', 'a2']);
    expect(centerOf(asm.pieces)).toEqual([0, 0, 0]);
    expect(asm.pieces[0].y).toBeCloseTo(-0.035, 6);
    expect(asm.joints).toEqual([{ a: 'a1', b: 'a2', kind: 'superglue' }]);
    expect(assemblyMass(asm)).toBeCloseTo(0.14, 6);
  });

  it('go on another car in one go: stuck to it, and to each other as before', () => {
    const start = put(emptyDesign(), piece('p1', 'eraser', 0, DECK + 0.02, -0.15));
    const { pieces, joints } = placed(start, 0, 0.05);
    expect(pieces.map((p) => p.id)).toEqual(['p2', 'p3']);
    expect(pieces[0].y).toBeCloseTo(DECK + 0.035, 6);
    expect(pieces[0].z).toBeCloseTo(0.05, 6);
    const result = putGroup(start, pieces, joints, 'hotglue');
    const d = result.design!;
    expect(d.pieces).toHaveLength(3);
    expect(groupOf(d, 'p3')).toEqual(['p2', 'p3']);
    expect(d.joints).toContainEqual({ a: 'p2', b: 'p3', kind: 'superglue' });
    expect(d.joints).toContainEqual({ a: BASE, b: 'p2', kind: 'hotglue' });
    expect(outerAdhesive(d, ['p2', 'p3'])).toBe('hotglue');
  });

  it('are refused where one of their pieces cannot be', () => {
    const { pieces, joints } = placed(emptyDesign(), 0.3, 0);
    expect(putGroup(emptyDesign(), pieces, joints, 'superglue').problem).toBe('bounds');
  });

  it('move and turn as one, keeping the joints inside', () => {
    const first = placed(emptyDesign(), 0, 0);
    const start = putGroup(emptyDesign(), first.pieces, first.joints, 'superglue').design!;
    const ids = groupOf(start, 'p1');
    const members = ids.map((id) => start.pieces.find((p) => p.id === id)!);
    const c = centerOf(members);
    const moved = movePieces(members, c, [c[0], c[1], c[2] - 0.1], IDENTITY);
    const d = putGroup(start, moved, [], 'superglue').design!;
    expect(d.pieces.find((p) => p.id === 'p1')!.z).toBeCloseTo(-0.1, 6);
    expect(d.joints).toContainEqual({ a: 'p1', b: 'p2', kind: 'superglue' });
    // Spun a quarter turn about its middle, the tower still stands on the deck.
    const spun = movePieces(members, c, c, turnOrientation(IDENTITY, 'y', 2));
    expect(putGroup(start, spun, [], 'superglue').design?.pieces).toHaveLength(2);
  });

  it('come back from storage the same, and are refused when they are not one thing', () => {
    const asm = tower();
    expect(readAssembly(JSON.parse(JSON.stringify(asm)))).toEqual(asm);
    expect(readAssembly({ ...asm, name: '  ' })).toBeNull();
    // Apart: nothing holds the second block to the first.
    const apart = { ...asm, pieces: [asm.pieces[0], { ...asm.pieces[1], y: 0.2 }] };
    expect(readAssembly(apart)).toBeNull();
    // In each other.
    const inside = { ...asm, pieces: [asm.pieces[0], { ...asm.pieces[1], y: asm.pieces[0].y + 0.01 }] };
    expect(readAssembly(inside)).toBeNull();
  });

  it('migrates legacy tape joints in stored assemblies to hot glue', () => {
    const asm = tower();
    const old = {
      ...asm,
      pieces: asm.pieces.map((p) => ({ ...p, adhesive: 'tape' })),
      joints: asm.joints.map((j) => ({ ...j, kind: 'tape' })),
    };
    const read = readAssembly(old)!;
    expect(read.pieces.every((p) => p.adhesive === 'hotglue')).toBe(true);
    expect(read.joints.every((j) => j.kind === 'hotglue')).toBe(true);
  });
});
