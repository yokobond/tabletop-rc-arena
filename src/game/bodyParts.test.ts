import { describe, expect, it } from 'vitest';
import {
  BASE,
  IDENTITY,
  PIECE_SPEC,
  connectedToBase,
  defaultRot,
  designMass,
  distance,
  emptyDesign,
  jointBond,
  onSurface,
  orientationQuat,
  pieceBox,
  pieceHalf,
  putPiece,
  readMadePart,
  removePiece,
  restingOn,
  rotateOrientation,
  sameOrientation,
  sanitizeDesign,
  seatAgainst,
  turnOrientation,
  turnedInPlace,
  type Adhesive,
  type BodyPiece,
  type CarDesign,
  type MadePart,
  type PieceKind,
} from './bodyParts';

/** The chassis top is at y = 0.105. */
const DECK = 0.105;

function onDeck(id: string, kind: PieceKind, x: number, z: number, adhesive: Adhesive = 'superglue', rot = defaultRot(kind)): BodyPiece {
  return { id, kind, x, y: DECK + pieceHalf(kind, rot)[1], z, rot, adhesive };
}

function put(design: CarDesign, piece: BodyPiece) {
  const result = putPiece(design, piece);
  if (!result.design) throw new Error(`refused: ${result.problem}`);
  return result.design;
}

describe('orientations', () => {
  it('turn in 45° steps: two make a quarter turn, eight come back round', () => {
    const quarter = turnOrientation(IDENTITY, 'z', 2);
    expect(sameOrientation(turnOrientation(turnOrientation(IDENTITY, 'z'), 'z'), quarter)).toBe(true);
    let rot = turnOrientation(IDENTITY, 'x');
    for (let i = 0; i < 8; i++) rot = turnOrientation(rot, 'y');
    expect(sameOrientation(rot, turnOrientation(IDENTITY, 'x'))).toBe(true);
    expect(sameOrientation(turnOrientation(turnOrientation(rot, 'z', 1), 'z', -1), rot)).toBe(true);
    const q = orientationQuat(turnOrientation(turnOrientation(IDENTITY, 'x'), 'y'));
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 9);
  });

  it('a pencil from the tray lies along the car', () => {
    expect(pieceHalf('pencil', defaultRot('pencil'))[2]).toBeCloseTo(0.15);
    expect(pieceHalf('pencil', defaultRot('pencil'))[1]).toBeCloseTo(0.018);
  });

  it('a block turned 45° takes more room across', () => {
    expect(pieceHalf('cube', turnOrientation(IDENTITY, 'y'))[0]).toBeCloseTo(0.035 * Math.SQRT2, 6);
  });

  it('rotates by arbitrary angles such as 1° and 15°', () => {
    let rot = IDENTITY;
    for (let i = 0; i < 3; i++) rot = rotateOrientation(rot, 'y', (15 * Math.PI) / 180);
    expect(sameOrientation(rot, turnOrientation(IDENTITY, 'y'))).toBe(true);
    const oneDeg = rotateOrientation(IDENTITY, 'x', (1 * Math.PI) / 180);
    expect(sameOrientation(oneDeg, IDENTITY)).toBe(false);
  });
});

describe('fine rotations (1° and 15°)', () => {
  it('1° and 2° tilts leave flat faces misaligned for superglue, while hot glue still holds', () => {
    for (const deg of [1, 2]) {
      const rot = rotateOrientation(IDENTITY, 'x', (deg * Math.PI) / 180);
      const tilted = turnedInPlace({ ...onDeck('a', 'cube', 0, 0, 'superglue'), seat: [0, 1, 0] }, rot);
      expect(putPiece(emptyDesign(), tilted).problem).toBe('superglue');
      expect(putPiece(emptyDesign(), { ...tilted, adhesive: 'hotglue' }).design?.joints).toHaveLength(1);
    }
  });

  it('1° yaw on the deck keeps flat bottom superglued and carries stacked riders', () => {
    let d = put(emptyDesign(), { ...onDeck('a', 'cube', 0, 0, 'superglue'), seat: [0, 1, 0] });
    d = put(d, { id: 'c', kind: 'cap', x: 0.02, y: DECK + 0.07 + 0.011, z: 0, rot: IDENTITY, adhesive: 'superglue' });
    const a = d.pieces.find((p) => p.id === 'a')!;
    const yaw1 = rotateOrientation(a.rot, 'y', (1 * Math.PI) / 180);
    const turned = put(d, turnedInPlace(a, yaw1));
    expect(turned.pieces).toHaveLength(2);
    expect(turned.joints).toContainEqual({ a: BASE, b: 'a', kind: 'superglue' });
    expect(turned.joints).toContainEqual({ a: 'a', b: 'c', kind: 'superglue' });
    const cap = turned.pieces.find((p) => p.id === 'c')!;
    expect(cap.x).toBeCloseTo(0.02 * Math.cos(Math.PI / 180), 3);
    expect(cap.z).toBeCloseTo(-0.02 * Math.sin(Math.PI / 180), 3);
  });
});

describe('turned 45°', () => {
  const yawed = turnOrientation(IDENTITY, 'y');
  const pitched = turnOrientation(IDENTITY, 'x');

  it('a block spun on the deck is still superglued by its whole bottom', () => {
    const d = put(emptyDesign(), onDeck('a', 'cube', 0, 0, 'superglue', yawed));
    expect(jointBond(d, d.joints[0])!.area).toBeCloseTo(0.07 * 0.07, 6);
  });

  it('a block tilted forward stands on an edge: superglue cannot hold it, hot glue can', () => {
    const tilted = onDeck('a', 'cube', 0, 0, 'superglue', pitched);
    expect(tilted.y).toBeCloseTo(DECK + 0.035 * Math.SQRT2, 6);
    expect(putPiece(emptyDesign(), tilted).problem).toBe('superglue');
    expect(putPiece(emptyDesign(), { ...tilted, adhesive: 'hotglue' }).design?.joints).toHaveLength(1);
  });

  it('turning in place keeps it resting on the deck', () => {
    const flat = onDeck('a', 'cube', 0, 0);
    const tilted = turnedInPlace({ ...flat, seat: [0, 1, 0] }, pitched);
    expect(tilted.y).toBeCloseTo(DECK + 0.035 * Math.SQRT2, 4);
    const back = turnedInPlace(tilted, turnOrientation(pitched, 'x', -1));
    expect(back.y).toBeCloseTo(flat.y, 4);
  });

  it('overlap is judged on the turned shape, not the box around it', () => {
    const d = put(emptyDesign(), onDeck('a', 'cube', 0, 0, 'hotglue', yawed));
    // The diamond's corner reaches 4.95cm; a square block 8cm away overlaps it, 9cm away does not.
    expect(putPiece(d, onDeck('b', 'cube', 0.08, 0, 'hotglue')).problem).toBe('overlap');
    expect(putPiece(d, onDeck('b', 'cube', 0.09, 0, 'hotglue')).design).not.toBeNull();
    // Diagonally, the box around the diamond would collide but the diamond itself does not.
    expect(putPiece(d, onDeck('b', 'cube', 0.065, 0.065, 'hotglue')).design).not.toBeNull();
  });

  it('superglue between a spun block and the eraser under it holds by the part they share', () => {
    let d = put(emptyDesign(), onDeck('a', 'eraser', 0, 0));
    d = put(d, { id: 'b', kind: 'cube', x: 0, y: DECK + 0.04 + 0.035, z: 0, rot: yawed, adhesive: 'superglue' });
    const area = jointBond(d, d.joints.find((j) => j.b === 'b')!)!.area;
    expect(area).toBeGreaterThan(0.003);
    expect(area).toBeLessThan(0.07 * 0.07);
  });

  it('a piece put on a tilted face rests against it', () => {
    const d = put(emptyDesign(), { ...onDeck('a', 'cube', 0, 0, 'hotglue', turnOrientation(IDENTITY, 'z')), seat: [0, 1, 0] });
    const n: [number, number, number] = [-Math.SQRT1_2, Math.SQRT1_2, 0];
    const face: [number, number, number] = [d.pieces[0].x + n[0] * 0.035, d.pieces[0].y + n[1] * 0.035, 0];
    const at = seatAgainst(face, n, 'matchbox', turnOrientation(IDENTITY, 'z'));
    const result = putPiece(d, { id: 'b', kind: 'matchbox', rot: turnOrientation(IDENTITY, 'z'), adhesive: 'superglue', ...at });
    expect(result.problem).toBeNull();
    expect(result.design!.joints).toContainEqual({ a: 'a', b: 'b', kind: 'superglue' });
  });

  describe('on a slope', () => {
    /** A block tilted forward on the deck, glued; its upper back face slopes up toward the back. */
    const block = put(emptyDesign(), { ...onDeck('a', 'cube', 0, 0, 'hotglue', pitched), seat: [0, 1, 0] });
    const a = block.pieces[0];
    const n: [number, number, number] = [0, Math.SQRT1_2, -Math.SQRT1_2];
    const face: [number, number, number] = [a.x, a.y + n[1] * 0.035, a.z + n[2] * 0.035];

    function onSlope(kind: PieceKind, adhesive: Adhesive) {
      const rot = restingOn(defaultRot(kind), n);
      return { id: 'b', kind, rot, adhesive, ...seatAgainst(face, n, kind, rot) };
    }

    it('a ball glued on rests on the face, in the hot glue', () => {
      const ball = onSlope('ball', 'hotglue');
      // Its center is one radius off the face: it touches it.
      const off = (ball.x - face[0]) * n[0] + (ball.y - face[1]) * n[1] + (ball.z - face[2]) * n[2];
      expect(off).toBeCloseTo(0.04, 3);
      const d = put(block, ball);
      const bond = jointBond(d, d.joints.find((j) => j.b === 'b')!)!;
      // The glue sits between the face and the ball, right under it.
      const toBond = Math.hypot(bond.center[0] - ball.x, bond.center[1] - ball.y, bond.center[2] - ball.z);
      expect(toBond).toBeLessThan(0.04 + 0.004);
    });

    it('things lie along it, so a cup can even be superglued by its bottom', () => {
      const cup = onSlope('cup', 'superglue');
      expect(putPiece(block, cup).problem).toBeNull();
    });

    it('moving a piece from slope to slope does not add the tilts up', () => {
      const once = restingOn(IDENTITY, n);
      expect(sameOrientation(restingOn(once, n, n), once)).toBe(true);
      expect(sameOrientation(restingOn(once, [0, 1, 0], n), IDENTITY)).toBe(true);
    });
  });

  it('survives sanitizing', () => {
    const p = onDeck('a', 'cube', 0, 0, 'hotglue', turnOrientation(pitched, 'y'));
    const d = put(emptyDesign(), { ...p, y: Math.round(p.y * 10000) / 10000 });
    expect(sanitizeDesign(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(sanitizeDesign({ pieces: [{ ...d.pieces[0], rot: [0, 0, 0, 0] }], joints: [] })).toBeNull();
  });
});

describe('superglue', () => {
  it('sticks flat faces that touch', () => {
    const d = put(emptyDesign(), onDeck('a', 'eraser', 0, 0));
    expect(d.joints).toEqual([{ a: BASE, b: 'a', kind: 'superglue' }]);
    const bond = jointBond(d, d.joints[0])!;
    expect(bond.area).toBeCloseTo(0.11 * 0.06, 6);
  });

  it('does not hold a ball or the round side of a pencil', () => {
    expect(putPiece(emptyDesign(), onDeck('a', 'ball', 0, 0)).problem).toBe('superglue');
    expect(putPiece(emptyDesign(), onDeck('a', 'pencil', 0, 0)).problem).toBe('superglue');
  });

  it('holds a cup by its flat bottom but not lying on its side', () => {
    expect(putPiece(emptyDesign(), onDeck('a', 'cup', 0, 0)).design).not.toBeNull();
    const lying = turnOrientation(IDENTITY, 'z', 2);
    expect(putPiece(emptyDesign(), onDeck('a', 'cup', 0, 0, 'superglue', lying)).problem).toBe('superglue');
  });

  it('cannot bridge a gap', () => {
    const p = onDeck('a', 'eraser', 0, 0);
    expect(putPiece(emptyDesign(), { ...p, y: p.y + 0.01 }).problem).toBe('superglue');
  });

  it('holds much stronger than hot glue and scales with contact area', async () => {
    const { jointStrength } = await import('./bodyParts');
    const tiny: MadePart = { name: 'ちび', shape: { kind: 'box', size: [0.01, 0.01, 0.01] }, mass: 0.01, color: '#3B82F6' };
    const small = put(emptyDesign(), { id: 's', kind: 'made', made: tiny, x: 0, y: DECK + 0.005, z: 0, rot: IDENTITY, adhesive: 'superglue' });
    const wide = put(emptyDesign(), onDeck('w', 'eraser', 0, 0, 'superglue'));
    const hot = put(emptyDesign(), onDeck('h', 'eraser', 0, 0, 'hotglue'));
    const sSmall = jointStrength(jointBond(small, small.joints[0])!);
    const sWide = jointStrength(jointBond(wide, wide.joints[0])!);
    const sHot = jointStrength(jointBond(hot, hot.joints[0])!);
    expect(sSmall).toBeGreaterThan(sHot * 2);
    expect(sWide).toBeGreaterThan(sSmall);
  });
});

describe('moving a piece', () => {
  /** An eraser on the deck with a block superglued on top of it. */
  function stack() {
    const d = put(emptyDesign(), onDeck('a', 'eraser', 0, 0));
    return put(d, { ...onDeck('b', 'cube', 0, 0), y: DECK + 0.04 + 0.035 });
  }
  const at = (d: CarDesign, id: string) => d.pieces.find((p) => p.id === id)!;

  it('takes along what is stuck only to it', () => {
    const d = stack();
    const a = at(d, 'a');
    const moved = put(d, { ...a, z: a.z + 0.05 });
    expect(at(moved, 'b').z).toBeCloseTo(0.05, 6);
    expect(at(moved, 'b').y).toBeCloseTo(at(d, 'b').y, 6);
    expect(moved.joints).toContainEqual({ a: 'a', b: 'b', kind: 'superglue' });
  });

  it('turns it along too, about its own center', () => {
    let d = put(emptyDesign(), onDeck('a', 'eraser', 0, 0));
    d = put(d, { id: 'c', kind: 'cap', x: 0.03, y: DECK + 0.04 + 0.011, z: 0, rot: IDENTITY, adhesive: 'superglue' });
    const a = at(d, 'a');
    const turned = put(d, turnedInPlace({ ...a, seat: [0, 1, 0] }, turnOrientation(a.rot, 'y', 2)));
    const cap = at(turned, 'c');
    // A quarter turn about Y takes +X to -Z.
    expect(cap.x).toBeCloseTo(0, 4);
    expect(cap.z).toBeCloseTo(-0.03, 4);
    expect(turned.joints).toContainEqual({ a: 'a', b: 'c', kind: 'superglue' });
  });

  it('leaves alone what is also held by something else', () => {
    let d = put(emptyDesign(), onDeck('l', 'cube', -0.05, 0));
    d = put(d, onDeck('r', 'cube', 0.05, 0));
    // A matchbox bridging both blocks.
    d = put(d, { id: 'top', kind: 'matchbox', x: 0, y: DECK + 0.07 + 0.0175, z: 0, rot: IDENTITY, adhesive: 'superglue' });
    const l = at(d, 'l');
    const moved = put(d, { ...l, z: l.z + 0.01 });
    expect(at(moved, 'top')).toEqual(at(d, 'top'));
  });

  it('is refused when what it takes along would not fit', () => {
    let d = put(emptyDesign(), onDeck('a', 'eraser', 0, 0));
    // A pencil standing on it, nearly as tall as a car may be.
    d = put(d, { id: 'pen', kind: 'pencil', x: 0, y: DECK + 0.04 + 0.15, z: 0, rot: IDENTITY, adhesive: 'superglue' });
    const a = at(d, 'a');
    expect(putPiece(d, { ...a, y: a.y + 0.08, adhesive: 'hotglue' }).problem).toBe('bounds');
  });
});

describe('round things', () => {
  const diagonal: [number, number, number] = [-Math.SQRT1_2, Math.SQRT1_2, 0];

  /** What the garage does with a tap on `target` at `point`. */
  function stuckOn(design: CarDesign, target: string, point: [number, number, number], kind: PieceKind) {
    const surface = onSurface(design, target, point, diagonal);
    const rot = restingOn(defaultRot(kind), surface.normal);
    return { id: 'n', kind, rot, adhesive: 'hotglue' as const, ...seatAgainst(surface.point, surface.normal, kind, rot, !surface.round) };
  }

  it('are measured as they are: two balls touch when their centers are two radii apart', () => {
    const a = pieceBox({ id: 'a', kind: 'ball', x: 0, y: 0.2, z: 0, rot: IDENTITY });
    const b = pieceBox({ id: 'b', kind: 'ball', x: 0.06, y: 0.26, z: 0, rot: IDENTITY });
    expect(distance(a, b)).toBeCloseTo(Math.hypot(0.06, 0.06) - 0.08, 5);
  });

  it('a ball may sit in the corner its box would fill', () => {
    const d = put(emptyDesign(), onDeck('a', 'cube', 0, 0, 'hotglue'));
    expect(putPiece(d, onDeck('b', 'ball', 0.065, 0.065, 'hotglue')).design).not.toBeNull();
  });

  it('a cap stuck on a ball at a slant touches the ball, in the glue', () => {
    const d = put(emptyDesign(), onDeck('ball', 'ball', 0, 0, 'hotglue'));
    const ball = d.pieces[0];
    const cap = stuckOn(d, 'ball', [ball.x - 0.03, ball.y + 0.03, ball.z], 'cap');
    const next = put(d, cap);
    expect(distance(pieceBox(cap), pieceBox(ball))).toBeLessThan(0.0005);
    const bond = jointBond(next, next.joints.find((j) => j.b === 'n')!)!;
    // The glue sits where they touch, on the ball's surface toward the cap.
    const touch = [ball.x + diagonal[0] * 0.04, ball.y + diagonal[1] * 0.04, ball.z];
    expect(Math.hypot(bond.center[0] - touch[0], bond.center[1] - touch[1], bond.center[2] - touch[2])).toBeLessThan(0.006);
  });

  it('a cup stuck on the round side of a pencil touches it', () => {
    const d = put(emptyDesign(), onDeck('pen', 'pencil', 0, 0, 'hotglue'));
    const pen = d.pieces[0];
    const cup = stuckOn(d, 'pen', [pen.x - 0.012, pen.y + 0.012, 0.05], 'cup');
    put(d, cup);
    expect(distance(pieceBox(cup), pieceBox(pen))).toBeLessThan(0.0005);
  });

  it('superglue still needs a flat face: not on a ball', () => {
    const d = put(emptyDesign(), onDeck('ball', 'ball', 0, 0, 'hotglue'));
    const cap = { ...stuckOn(d, 'ball', [d.pieces[0].x, d.pieces[0].y + 0.04, 0], 'cap'), adhesive: 'superglue' as const };
    expect(putPiece(d, cap).problem).toBe('superglue');
  });
});

describe('hot glue', () => {
  it('fills a gap of up to 3cm and sticks round things', () => {
    const p = onDeck('a', 'ball', 0, 0, 'hotglue');
    expect(putPiece(emptyDesign(), { ...p, y: p.y + 0.02 }).design?.joints).toEqual([{ a: BASE, b: 'a', kind: 'hotglue' }]);
    expect(putPiece(emptyDesign(), { ...p, y: p.y + 0.04 }).problem).toBe('hotglue');
  });

  it('is weaker than superglue', async () => {
    const { jointStrength } = await import('./bodyParts');
    const strength = (adhesive: Adhesive) => {
      const d = put(emptyDesign(), onDeck('a', 'eraser', 0, 0, adhesive));
      return jointStrength(jointBond(d, d.joints[0])!);
    };
    expect(strength('hotglue')).toBeGreaterThanOrEqual(2);
    expect(strength('hotglue')).toBeLessThan(strength('superglue'));
  });

  it('migrates legacy tape and strong glue (セメダイン) designs to hot glue, and defaults missing adhesive to hot glue', () => {
    const d = put(emptyDesign(), onDeck('a', 'cube', 0, 0, 'hotglue'));
    for (const legacy of ['tape', 'glue'] as const) {
      const old = {
        pieces: d.pieces.map((p) => ({ ...p, adhesive: legacy })),
        joints: d.joints.map((j) => ({ ...j, kind: legacy })),
      };
      expect(sanitizeDesign(old)).toEqual(d);
    }
    const omitted = {
      pieces: d.pieces.map(({ adhesive: _a, ...rest }) => rest),
      joints: d.joints,
    };
    expect(sanitizeDesign(omitted)).toEqual(d);
  });

  it('survives sanitizing', () => {
    const d = put(emptyDesign(), onDeck('a', 'ball', 0, 0, 'hotglue'));
    expect(sanitizeDesign(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });
});

describe('designs', () => {
  it('refuses overlapping pieces and pieces in the wheels', () => {
    const d = put(emptyDesign(), onDeck('a', 'eraser', 0, 0));
    expect(putPiece(d, onDeck('b', 'eraser', 0.02, 0)).problem).toBe('overlap');
    expect(putPiece(d, onDeck('b', 'cube', 0.12, 0.15)).problem).toBe('wheel');
  });

  it('stacks: a piece on a piece is held through it, and comes off with it', () => {
    let d = put(emptyDesign(), onDeck('a', 'eraser', 0, 0));
    const top = { ...onDeck('b', 'cube', 0, 0), y: DECK + 0.04 + 0.035 };
    d = put(d, top);
    expect(d.joints).toContainEqual({ a: 'a', b: 'b', kind: 'superglue' });
    expect([...connectedToBase(d.joints)].sort()).toEqual(['a', 'b', BASE]);
    expect(removePiece(d, 'a').pieces).toHaveLength(0);
  });

  it('a mass limit keeps the car drivable', () => {
    let d = emptyDesign();
    let refused = null;
    for (let i = 0; i < 12 && !refused; i++) {
      const x = -0.1 + (i % 3) * 0.1;
      const y = DECK + 0.035 + Math.floor(i / 3) * 0.07;
      const result = putPiece(d, { id: `c${i}`, kind: 'cube', x, y, z: 0, rot: IDENTITY, adhesive: 'hotglue' });
      if (result.design) d = result.design;
      else refused = result.problem;
    }
    expect(refused).toBe('heavy');
    expect(d.pieces.length * PIECE_SPEC.cube.mass).toBeLessThanOrEqual(0.6 + 1e-9);
  });

  it('sanitizing keeps a good design and drops what does not hold', () => {
    const d = put(put(emptyDesign(), onDeck('a', 'eraser', 0, 0)), onDeck('b', 'brick', 0, -0.12, 'hotglue'));
    expect(sanitizeDesign(JSON.parse(JSON.stringify(d)))).toEqual(d);
    // A joint that claims superglue where there is a gap is dropped, and so is the piece it held.
    const floating = { ...d, pieces: d.pieces.map((p) => (p.id === 'b' ? { ...p, y: p.y + 0.01 } : p)), joints: [...d.joints] };
    floating.joints = floating.joints.map((j) => (j.b === 'b' ? { ...j, kind: 'superglue' as const } : j));
    expect(sanitizeDesign(floating)?.pieces.map((p) => p.id)).toEqual(['a']);
    expect(sanitizeDesign({ pieces: [{ id: 'x', kind: 'rocket', x: 0, y: 0, z: 0, rot: IDENTITY }], joints: [] })).toBeNull();
    expect(sanitizeDesign('nope')).toBeNull();
  });
});

describe('made-up parts', () => {
  const slab: MadePart = { name: 'いた', shape: { kind: 'box', size: [0.2, 0.01, 0.1] }, mass: 0.05, color: '#3B82F6' };
  const tube: MadePart = { name: 'つつ', shape: { kind: 'cylinder', r: 0.01, h: 0.2 }, mass: 0.02, color: '#22C55E' };
  const made = (id: string, part: MadePart, x: number, z: number, adhesive: Adhesive = 'superglue'): BodyPiece => {
    const rot = defaultRot({ kind: 'made', made: part });
    return { id, kind: 'made', made: part, x, y: DECK + pieceHalf({ kind: 'made', made: part }, rot)[1], z, rot, adhesive };
  };

  it('are read to 0.1 mm, within the limits', () => {
    expect(readMadePart({ ...slab, shape: { kind: 'box', size: [0.20004, 0.01001, 0.1] }, color: '#3b82f6' })).toEqual({
      ...slab,
      shape: { kind: 'box', size: [0.2, 0.01, 0.1] },
    });
    expect(readMadePart({ ...tube, shape: { kind: 'cylinder', r: 0.0075, h: 0.2 } })?.shape).toEqual({ kind: 'cylinder', r: 0.0075, h: 0.2 });
    expect(readMadePart({ ...slab, name: '  ' })).toBeNull();
    expect(readMadePart({ ...slab, name: 'とてもとてもながいなまえのぶひん' })?.name).toHaveLength(12);
    expect(readMadePart({ ...slab, shape: { kind: 'box', size: [1, 0.01, 0.1] } })).toBeNull();
    expect(readMadePart({ ...slab, mass: 5 })).toBeNull();
    expect(readMadePart({ ...slab, color: 'red' })).toBeNull();
    expect(readMadePart({ ...slab, shape: { kind: 'cone', r: 0.01 } })).toBeNull();
    expect(readMadePart({ ...slab, shape: { kind: 'ball', r: Number.NaN } })).toBeNull();
  });

  it('stick on and weigh like the tray things', () => {
    const d = put(put(emptyDesign(), made('a', slab, 0, 0)), onDeck('b', 'cube', 0, 0.16));
    expect(d.joints).toContainEqual({ a: BASE, b: 'a', kind: 'superglue' });
    expect(designMass(d)).toBeCloseTo(0.05 + 0.07);
    // Something else sits on the slab's top.
    const top = DECK + 0.01;
    const ball = { id: 'c', kind: 'ball' as const, x: 0, y: top + 0.04, z: 0, rot: IDENTITY, adhesive: 'hotglue' as const };
    expect(put(d, ball).joints).toContainEqual({ a: 'a', b: 'c', kind: 'hotglue' });
  });

  it('a long tube comes out lying down, and superglue will not hold its round side', () => {
    const piece = made('t', tube, 0, 0);
    expect(pieceHalf(piece, piece.rot)[1]).toBeCloseTo(0.01);
    expect(putPiece(emptyDesign(), piece).problem).toBe('superglue');
    expect(putPiece(emptyDesign(), { ...piece, adhesive: 'hotglue' }).design).not.toBeNull();
  });

  it('travel with the design: sanitizing keeps them and turns away a bad one', () => {
    const d = put(emptyDesign(), made('a', slab, 0, 0));
    expect(sanitizeDesign(JSON.parse(JSON.stringify(d)))).toEqual(d);
    const broken = JSON.parse(JSON.stringify(d));
    broken.pieces[0].made.shape.size[0] = 9;
    expect(sanitizeDesign(broken)).toBeNull();
    expect(sanitizeDesign({ pieces: [{ ...d.pieces[0], made: undefined }], joints: [] })).toBeNull();
    expect(sanitizeDesign({ pieces: [{ ...d.pieces[0], kind: 'toString' }], joints: [] })).toBeNull();
  });
});
