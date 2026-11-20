import { describe, expect, it } from 'vitest';
import {
  BASE,
  IDENTITY,
  defaultRot,
  emptyDesign,
  jointBond,
  putPiece,
  rotateOrientation,
  turnOrientation,
  turnedInPlace,
  type Adhesive,
  type BodyPiece,
  type CarDesign,
  type PieceKind,
  type Quat,
  type Vec3,
} from './bodyParts';
import { groupOf, makeGroup } from './assembly';
import {
  createDragPlane,
  findDefaultHandPlacement,
  resolveHandPlacement,
  resolvePieceDrag,
  type PointerRay,
  type SupportPlane,
} from './placement';

const DECK = 0.105;

function onDeck(id: string, kind: PieceKind, x: number, z: number, adhesive: Adhesive = 'tape', rot = defaultRot(kind)): BodyPiece {
  const halfY =
    kind === 'ruler' ? 0.004 : kind === 'eraser' ? 0.02 : kind === 'brick' ? 0.024 : kind === 'cube' ? 0.035 : 0.04;
  return { id, kind, x, y: DECK + halfY, z, rot, adhesive, seat: [0, 1, 0] };
}

function put(design: CarDesign, piece: BodyPiece): CarDesign {
  const res = putPiece(design, piece);
  if (!res.design) throw new Error(`refused: ${res.problem}`);
  return res.design;
}

function rayTo(origin: Vec3, target: Vec3): PointerRay {
  const d: Vec3 = [target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  return { origin, dir: [d[0] / len, d[1] / len, d[2] / len] };
}

describe('overhanging & multi-surface placement', () => {
  it('drags a ruler past the side and front edges of the deck and bonds by its remaining overlap', () => {
    const start = put(emptyDesign(), onDeck('r', 'ruler', 0, 0, 'tape'));
    const plane = createDragPlane(start, 'r', [0, DECK + 0.008, 0])!;
    const cam: Vec3 = [0.5, 0.9, 0.7];

    // Drag to x = 0.17 (ruler center is past deck edge 0.135; left portion [0.02, 0.135] overlaps deck).
    const sideRes = resolvePieceDrag(
      start,
      'r',
      { hit: null, ray: rayTo(cam, [0.17, DECK + 0.008, 0]), shift: false },
      plane,
      'tape',
    );
    expect(sideRes.result.design).not.toBeNull();
    const sideRuler = sideRes.result.design!.pieces[0];
    expect(sideRuler.x).toBeCloseTo(0.17, 4);
    expect(sideRuler.y).toBeCloseTo(DECK + 0.004, 4);
    const sideBond = jointBond(sideRes.result.design!, sideRes.result.design!.joints[0])!;
    // Tape bond spans x in [0.02, 0.135], so bond center sits at x = 0.0775 (not at ruler center 0.17).
    expect(sideBond.center[0]).toBeCloseTo(0.0775, 4);

    // Drag a longitudinally oriented ruler forward to z = 0.29 (center past deck front edge 0.23, max z = 0.44).
    const longStart = put(emptyDesign(), onDeck('r', 'ruler', 0, 0.1, 'tape', turnOrientation(IDENTITY, 'y', 2)));
    const longPlane = createDragPlane(longStart, 'r', [0, DECK + 0.008, 0.1])!;
    const frontRes = resolvePieceDrag(
      longStart,
      'r',
      { hit: null, ray: rayTo(cam, [0, DECK + 0.008, 0.29]), shift: false },
      longPlane,
      'tape',
    );
    expect(frontRes.result.design).not.toBeNull();
    const frontRuler = frontRes.result.design!.pieces[0];
    expect(frontRuler.z).toBeCloseTo(0.29, 4);
    const frontBond = jointBond(frontRes.result.design!, frontRes.result.design!.joints[0])!;
    // Overlap on deck Z is [0.14, 0.23], so tape bond is centered at z = 0.185.
    expect(frontBond.center[2]).toBeCloseTo(0.185, 4);
  });

  it('preserves grab offset instead of jumping piece center to the pointer', () => {
    const start = put(emptyDesign(), onDeck('r', 'ruler', 0, 0, 'tape'));
    const grab: Vec3 = [0.12, DECK + 0.008, 0];
    const plane = createDragPlane(start, 'r', grab)!;
    const cam: Vec3 = [0.4, 0.9, 0.6];

    // Move grab point +0.02 in X while ray still hits the deck: center moves to +0.02, not +0.14.
    const moved = resolvePieceDrag(
      start,
      'r',
      { hit: { point: [0.13, DECK, 0], normal: [0, 1, 0], target: BASE }, ray: rayTo(cam, [0.14, DECK + 0.008, 0]), shift: false },
      plane,
      'tape',
    );
    expect(moved.switched).toBe(false);
    expect(moved.result.design!.pieces[0].x).toBeCloseTo(0.02, 4);
  });

  it('stays on top of a supporting block when overhanging even if the ray hits the lower deck behind, then drops when clear', () => {
    let d = put(emptyDesign(), onDeck('c', 'cube', 0, 0.05, 'tape'));
    d = put(d, { id: 'r', kind: 'ruler', x: 0, y: DECK + 0.07 + 0.004, z: 0.05, rot: IDENTITY, adhesive: 'tape', seat: [0, 1, 0] });
    const plane = createDragPlane(d, 'r', [0, DECK + 0.07 + 0.008, 0.05])!;
    const cam: Vec3 = [0.5, 0.9, 0.6];

    // Cursor moves to x = 0.12 (off the cube [-0.035, 0.035], hitting the deck behind at y = 0.105).
    const overhang = resolvePieceDrag(
      d,
      'r',
      { hit: { point: [0.12, DECK, 0.05], normal: [0, 1, 0], target: BASE }, ray: rayTo(cam, [0.12, DECK + 0.07 + 0.008, 0.05]), shift: false },
      plane,
      'tape',
    );
    expect(overhang.switched).toBe(false);
    expect(overhang.result.design).not.toBeNull();
    const overRuler = overhang.result.design!.pieces.find((p) => p.id === 'r')!;
    expect(overRuler.y).toBeCloseTo(DECK + 0.07 + 0.004, 4);
    expect(overRuler.x).toBeCloseTo(0.12, 4);
    expect(overhang.result.design!.joints).toContainEqual({ a: 'c', b: 'r', kind: 'tape' });

    // Moving completely past the cube along Z onto the open middle deck (z = -0.03) drops smoothly onto the deck.
    const dropRes = resolvePieceDrag(
      d,
      'r',
      { hit: { point: [0, DECK, -0.03], normal: [0, 1, 0], target: BASE }, ray: rayTo(cam, [0, DECK + 0.07 + 0.008, -0.03]), shift: false },
      plane,
      'tape',
    );
    expect(dropRes.switched).toBe(true);
    expect(dropRes.result.design).not.toBeNull();
    const deckRuler = dropRes.result.design!.pieces.find((p) => p.id === 'r')!;
    expect(deckRuler.y).toBeCloseTo(DECK + 0.004, 4);
    expect(dropRes.result.design!.joints).toContainEqual({ a: BASE, b: 'r', kind: 'tape' });
  });

  it('switches up onto a block in front when dragging an eraser from the deck onto it', () => {
    let d = put(emptyDesign(), onDeck('c', 'cube', 0, 0.12, 'tape'));
    d = put(d, onDeck('e', 'eraser', 0, -0.05, 'tape'));
    const plane = createDragPlane(d, 'e', [0, DECK + 0.04, -0.05])!;
    const cam: Vec3 = [0.4, 0.9, 0.6];

    const climb = resolvePieceDrag(
      d,
      'e',
      { hit: { point: [0, DECK + 0.07, 0.12], normal: [0, 1, 0], target: 'c' }, ray: rayTo(cam, [0, DECK + 0.07, 0.12]), shift: false },
      plane,
      'tape',
    );
    expect(climb.switched).toBe(true);
    expect(climb.result.design).not.toBeNull();
    const moved = climb.result.design!.pieces.find((p) => p.id === 'e')!;
    expect(moved.y).toBeCloseTo(DECK + 0.07 + 0.02, 4);
    expect(climb.result.design!.joints).toContainEqual({ a: 'c', b: 'e', kind: 'tape' });
  });

  it('keeps lift height and 30° tilt intact when dragging horizontally', () => {
    // 1) +1.5 cm lifted cube (hot glue) dragged horizontally even with deck hits behind it.
    const liftedStart = put(emptyDesign(), {
      id: 'c',
      kind: 'cube',
      x: 0,
      y: DECK + 0.035 + 0.015,
      z: 0,
      rot: IDENTITY,
      adhesive: 'hotglue',
      seat: [0, 1, 0],
    });
    const liftPlane = createDragPlane(liftedStart, 'c', [0, DECK + 0.07 + 0.015, 0])!;
    const cam: Vec3 = [0.5, 0.85, 0.6];
    const liftMoved = resolvePieceDrag(
      liftedStart,
      'c',
      { hit: { point: [0.06, DECK, 0], normal: [0, 1, 0], target: BASE }, ray: rayTo(cam, [0.06, DECK + 0.07 + 0.015, 0]), shift: false },
      liftPlane,
      'hotglue',
    );
    expect(liftMoved.switched).toBe(false);
    expect(liftMoved.result.design).not.toBeNull();
    expect(liftMoved.result.design!.pieces[0].y).toBeCloseTo(DECK + 0.035 + 0.015, 4);
    expect(liftMoved.result.design!.pieces[0].x).toBeCloseTo(0.06, 4);

    // 2) 30° tilted cube keeps its tilt and center height while sliding horizontally.
    const rot30 = rotateOrientation(IDENTITY, 'z', (30 * Math.PI) / 180);
    const tilted = turnedInPlace(onDeck('t', 'cube', 0, 0, 'hotglue'), rot30);
    const tiltedStart = put(emptyDesign(), tilted);
    const tiltPlane = createDragPlane(tiltedStart, 't', [0, tilted.y, 0])!;
    const tiltMoved = resolvePieceDrag(
      tiltedStart,
      't',
      { hit: null, ray: rayTo(cam, [0.05, tilted.y, -0.04]), shift: false },
      tiltPlane,
      'hotglue',
    );
    expect(tiltMoved.result.design).not.toBeNull();
    const nextTilted = tiltMoved.result.design!.pieces[0];
    expect(nextTilted.y).toBeCloseTo(tilted.y, 4);
    expect(nextTilted.rot).toEqual(tilted.rot);
    expect(nextTilted.x).toBeCloseTo(0.05, 4);
    expect(nextTilted.z).toBeCloseTo(-0.04, 4);
  });

  it('allows hot-glue gap drag up to 3 cm off the deck edge and rejects beyond 3 cm', () => {
    const start = put(emptyDesign(), onDeck('c', 'cube', 0, 0, 'hotglue'));
    const plane = createDragPlane(start, 'c', [0, DECK + 0.07, 0])!;
    const cam: Vec3 = [0.5, 0.9, 0.6];

    // Deck ends at x = 0.135; cube half is 0.035 -> x = 0.19 gives 2 cm gap (<= 3 cm).
    const gap2cm = resolvePieceDrag(
      start,
      'c',
      { hit: null, ray: rayTo(cam, [0.19, DECK + 0.07, 0]), shift: false },
      plane,
      'hotglue',
    );
    expect(gap2cm.result.design).not.toBeNull();

    // x = 0.21 gives 4 cm gap (> 3 cm).
    const gap4cm = resolvePieceDrag(
      start,
      'c',
      { hit: null, ray: rayTo(cam, [0.21, DECK + 0.07, 0]), shift: false },
      plane,
      'hotglue',
    );
    expect(gap4cm.result.design).toBeNull();
    expect(gap4cm.result.problem).toBe('hotglue');
  });

  it('supports overhanging drag on the vertical front bumper face and horizontal fallback from a side view', () => {
    // Ruler flat against front bumper face (z = 0.260, y_mid = 0.075, x in [-0.145, 0.145]).
    const upright: Quat = rotateOrientation(IDENTITY, 'x', Math.PI / 2);
    const frontRuler: BodyPiece = {
      id: 'fr',
      kind: 'ruler',
      x: 0,
      y: 0.075,
      z: 0.264,
      rot: upright,
      adhesive: 'tape',
      seat: [0, 0, 1],
    };
    const start = put(emptyDesign(), frontRuler);
    const grab: Vec3 = [0, 0.075, 0.268];
    const plane = createDragPlane(start, 'fr', grab)!;

    // Front camera dragging past the bumper side edge (+X = 0.17, remaining end [0.02, 0.145] still taped, max x = 0.32).
    const frontCam: Vec3 = [0.1, 0.25, 1.2];
    const sideOver = resolvePieceDrag(
      start,
      'fr',
      { hit: null, ray: rayTo(frontCam, [0.17, 0.075, 0.268]), shift: false },
      plane,
      'tape',
    );
    expect(sideOver.result.design).not.toBeNull();
    expect(sideOver.result.design!.pieces[0].x).toBeCloseTo(0.17, 4);
    expect(sideOver.result.design!.pieces[0].z).toBeCloseTo(0.264, 4);

    // Hot-glue cube on front bumper viewed edge-on from the side: falls back to horizontal plane so +2cm forward succeeds.
    const frontGlue = put(emptyDesign(), {
      id: 'fc',
      kind: 'cube',
      x: 0,
      y: 0.075,
      z: 0.26 + 0.035,
      rot: IDENTITY,
      adhesive: 'hotglue',
      seat: [0, 0, 1],
    });
    const glueGrab: Vec3 = [0.035, 0.075, 0.295];
    const gluePlane = createDragPlane(frontGlue, 'fc', glueGrab)!;
    const sideCam: Vec3 = [1.0, 0.35, 0.295];
    const forwardGap = resolvePieceDrag(
      frontGlue,
      'fc',
      { hit: null, ray: rayTo(sideCam, [0.035, 0.075, 0.315]), shift: false },
      gluePlane,
      'hotglue',
    );
    expect(forwardGap.result.design).not.toBeNull();
    expect(forwardGap.result.design!.pieces[0].z).toBeCloseTo(0.315, 4);
  });

  it('snaps to 1 mm grid when shift is held', () => {
    const start = put(emptyDesign(), onDeck('c', 'cube', 0, 0, 'tape'));
    const plane = createDragPlane(start, 'c', [0, DECK + 0.07, 0])!;
    const cam: Vec3 = [0.4, 0.9, 0.6];

    const fine = resolvePieceDrag(
      start,
      'c',
      { hit: null, ray: rayTo(cam, [0.003, DECK + 0.07, 0.002]), shift: true },
      plane,
      'tape',
    );
    expect(fine.result.design!.pieces[0].x).toBeCloseTo(0.003, 4);
    expect(fine.result.design!.pieces[0].z).toBeCloseTo(0.002, 4);

    const fineHand = resolveHandPlacement(
      emptyDesign(),
      { hit: { point: [0.003, DECK, 0.002], normal: [0, 1, 0], target: BASE }, ray: rayTo(cam, [0.003, DECK, 0.002]), shift: true },
      { kind: 'cube', rot: IDENTITY },
      'tape',
    )!;
    expect(fineHand.pieces[0].x).toBeCloseTo(0.003, 4);
    expect(fineHand.pieces[0].z).toBeCloseTo(0.002, 4);
  });

  it('places from the tray when aiming at empty space near a bondable edge and returns null when far away', () => {
    const cam: Vec3 = [0.5, 0.9, 0.6];

    // Ruler aimed at empty space just past deck side edge (x = 0.17, max x = 0.32, y = DECK).
    const rulerEdge = resolveHandPlacement(
      emptyDesign(),
      { hit: null, ray: rayTo(cam, [0.17, DECK, 0]), shift: false },
      { kind: 'ruler', rot: IDENTITY },
      'tape',
    );
    expect(rulerEdge?.result.design).not.toBeNull();
    expect(rulerEdge!.pieces[0].x).toBeCloseTo(0.17, 4);

    // Hot-glue cube aimed 1.5 cm outside deck side edge (gap from deck edge 0.135 to 0.15 is 1.5 cm <= 3 cm).
    const glueEdge = resolveHandPlacement(
      emptyDesign(),
      { hit: null, ray: rayTo(cam, [0.185, DECK, 0]), shift: false },
      { kind: 'cube', rot: IDENTITY },
      'hotglue',
    );
    expect(glueEdge?.result.design).not.toBeNull();
    expect(glueEdge!.pieces[0].x).toBeCloseTo(0.185, 4);

    // Aimed far away from the car returns null.
    const far = resolveHandPlacement(
      emptyDesign(),
      { hit: null, ray: rayTo(cam, [0.55, DECK, 0]), shift: false },
      { kind: 'ruler', rot: IDENTITY },
      'tape',
    );
    expect(far).toBeNull();
  });

  it('continues on lastPlane or BASE deck plane for hand overhang instead of failing on a lower step', () => {
    const d = put(emptyDesign(), onDeck('c', 'cube', 0, 0, 'tape'));
    const cam: Vec3 = [0.5, 0.9, 0.6];
    const cubeTop: SupportPlane = { anchor: [0, DECK + 0.07, 0], normal: [0, 1, 0] };

    // Aim just beside cube (hit on lower deck at x = 0.06 would overlap cube, so lastPlane y = 0.175 continues).
    const onTop = resolveHandPlacement(
      d,
      { hit: { point: [0.06, DECK, 0], normal: [0, 1, 0], target: BASE }, ray: rayTo(cam, [0.06, DECK + 0.07, 0]), shift: false },
      { kind: 'ruler', rot: IDENTITY },
      'tape',
      cubeTop,
    );
    expect(onTop?.result.design).not.toBeNull();
    expect(onTop!.pieces[0].y).toBeCloseTo(DECK + 0.07 + 0.004, 4);
    expect(onTop!.plane).toEqual(cubeTop);

    // Hovering long ruler over front bumper top (y = 0.096 < 0.105): direct overlaps deck, so BASE top deck plane is used.
    const longRot = turnOrientation(IDENTITY, 'y', 2);
    const frontDeck = resolveHandPlacement(
      emptyDesign(),
      { hit: { point: [0, 0.096, 0.24], normal: [0, 1, 0], target: BASE }, ray: rayTo(cam, [0, DECK, 0.24]), shift: false },
      { kind: 'ruler', rot: longRot },
      'tape',
      null,
    );
    expect(frontDeck?.result.design).not.toBeNull();
    expect(frontDeck!.pieces[0].y).toBeCloseTo(DECK + 0.004, 4);
  });

  it('drags a grouped assembly with grab offset and overhang while preserving internal joints', () => {
    let d = put(emptyDesign(), onDeck('a', 'ruler', 0, 0, 'tape'));
    d = put(d, { id: 'b', kind: 'cube', x: 0, y: DECK + 0.008 + 0.035, z: 0, rot: IDENTITY, adhesive: 'tape', seat: [0, 1, 0] });
    d = makeGroup(d, ['a', 'b']);
    expect(groupOf(d, 'a')).toEqual(['a', 'b']);

    // Grab near the right edge of the ruler; moving +0.16 shifts group center from 0 to +0.16 (overhanging deck).
    const grab: Vec3 = [0.1, DECK + 0.008, 0];
    const plane = createDragPlane(d, 'a', grab)!;
    const cam: Vec3 = [0.5, 0.9, 0.7];
    const res = resolvePieceDrag(
      d,
      'a',
      { hit: null, ray: rayTo(cam, [0.26, DECK + 0.008, 0]), shift: false },
      plane,
      'tape',
    );
    expect(res.result.design).not.toBeNull();
    const moved = res.result.design!;
    const a = moved.pieces.find((p) => p.id === 'a')!;
    const b = moved.pieces.find((p) => p.id === 'b')!;
    expect(a.x).toBeCloseTo(0.16, 4);
    expect(b.x).toBeCloseTo(0.16, 4);
    expect(moved.joints).toContainEqual({ a: 'a', b: 'b', kind: 'tape' });
    expect(moved.joints).toContainEqual({ a: BASE, b: 'a', kind: 'tape' });
  });

  it('finds a default keyboard placement on the deck, stacks or shifts when occupied, and reports adhesive issues', () => {
    const emptyPlaced = findDefaultHandPlacement(emptyDesign(), { kind: 'cube', rot: IDENTITY }, 'tape');
    expect(emptyPlaced?.result.design).not.toBeNull();
    expect(emptyPlaced!.pieces[0].x).toBeCloseTo(0, 4);
    expect(emptyPlaced!.pieces[0].y).toBeCloseTo(DECK + 0.035, 4);
    expect(emptyPlaced!.pieces[0].z).toBeCloseTo(0, 4);

    // Occupy the center of the deck; next piece finds an alternate open spot or stacks cleanly.
    const occupied = put(emptyDesign(), onDeck('c', 'cube', 0, 0, 'tape'));
    const nextPlaced = findDefaultHandPlacement(occupied, { kind: 'cube', rot: IDENTITY }, 'tape');
    expect(nextPlaced?.result.design).not.toBeNull();
    const placedCube = nextPlaced!.pieces[0];
    expect(Math.hypot(placedCube.x, placedCube.z) > 0.05 || placedCube.y > DECK + 0.07).toBe(true);

    // Ping-pong ball cannot stick with tape (reports 'tape'), but succeeds with hotglue.
    const ballTape = findDefaultHandPlacement(emptyDesign(), { kind: 'ball', rot: IDENTITY }, 'tape');
    expect(ballTape?.result.design).toBeNull();
    expect(ballTape?.result.problem).toBe('tape');

    const ballGlue = findDefaultHandPlacement(emptyDesign(), { kind: 'ball', rot: IDENTITY }, 'hotglue');
    expect(ballGlue?.result.design).not.toBeNull();
  });
});
