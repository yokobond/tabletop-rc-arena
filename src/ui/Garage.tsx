import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ADHESIVES,
  ADHESIVE_LABEL,
  BASE,
  IDENTITY,
  MAX_PIECES,
  MAX_PIECE_MASS,
  PIECES,
  PROBLEM_TEXT,
  defaultRot,
  designMass,
  emptyDesign,
  movedGroup,
  putPiece,
  readMadePart,
  removePiece,
  rotateOrientation,
  specOf,
  turnedInPlace,
  type Adhesive,
  type BodyPiece,
  type CarDesign,
  type MadePart,
  type PartType,
  type PlaceResult,
  type Quat,
} from '../game/bodyParts';
import { stripMissingMeshes } from '../game/carFile';
import {
  assemblyOf,
  assemblyReach,
  breakGroup,
  centerOf,
  groupMoved,
  groupOf,
  hangingOnAll,
  makeGroup,
  outerAdhesive,
  putGroup,
  removePieces,
  stuckTogether,
  type Assembly,
} from '../game/assembly';
import {
  createDragPlane,
  findDefaultHandPlacement,
  resolveHandPlacement,
  resolvePieceDrag,
  type DragPlane,
  type SupportPlane,
} from '../game/placement';
import type { PlayerId } from '../game/types';
import { GarageView, assemblyThumbnail, pieceThumbnail } from '../aframe/garageView';
import {
  MAX_ASSEMBLIES,
  MAX_MADE_PARTS,
  MAX_SAVED_CARS,
  assemblyParts,
  loadAssemblies,
  loadMadeParts,
  loadSavedCars,
  removeSavedCar,
  saveAssemblies,
  saveCarToLibrary,
  saveMadeParts,
  type SavedAssembly,
  type SavedCar,
  type SavedPart,
} from '../runtime/designStorage';
import { getState, openGarage, setCarDesign, setShareDesign, useGame, type OnlinePeerCar } from '../runtime/store';
import { ensureMeshes, keepMesh, meshBytes, pruneMeshes } from '../runtime/meshStore';
import { exportCar, importCar } from '../runtime/carFiles';
import { exportParts, importParts } from '../runtime/partFiles';
import { AssemblyDialog } from './AssemblyDialog';
import { CarLibrary } from './CarLibrary';
import { PartMaker } from './PartMaker';
import { RotationGizmo, type RotationPreviewResult } from './RotationGizmo';
import type { RotationAxis } from '../game/rotationGizmo';

/**
 * Something from the tray being dragged or placed; `from` is its tray card (a kind, a made
 * part's id, or a part made of parts' id).
 */
type Hand = (PartType & { rot: Quat; from: string; asm?: undefined }) | { asm: Assembly; rot: Quat; from: string };

interface TrayDragItem {
  hand: Hand;
  name: string;
  thumb: string;
  badge?: string;
}

interface TrayDragView extends TrayDragItem {
  x: number;
  y: number;
  snapped: boolean;
  isTouch: boolean;
}

interface TrayDragSession extends TrayDragItem {
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  lastShift: boolean;
  active: boolean;
  snapped: boolean;
  trayScrollable: boolean;
}

/** Naming pieces on the car as a part for the tray (`assembly`), or changing one there (`id`). */
type Naming = { assembly: Assembly } | { id: string } | null;

type Note = { ok: boolean; text: string } | null;

const HINT_START = 'したのトレイから物を車の上へドラッグしてくっつけよう！';

const TOOL_NOTE: Record<Adhesive, string> = {
  hotglue: '次の物はホットグルーでくっつけます。3cm までのすき間も埋めるけれど、はがれやすい。',
  superglue: '次の物は瞬間接着剤でくっつけます。平らな面どうしだけれど、とても外れにくい。',
};

const TOOL_SUB: Record<Adhesive, string> = {
  hotglue: 'すき間を埋める・はがれやすい',
  superglue: '平らな面どうし・強力',
};

/** How "stuck it on with" reads in Japanese. */
const stuckWith = (a: Adhesive) => `${ADHESIVE_LABEL[a]}でくっつけ`;

const label = (t: PartType) => specOf(t).label;
const groupName = (count: number) => `組み部品（${count}こ）`;
let madeCount = 0;
const newPartId = () => `m${Date.now().toString(36)}${(madeCount++).toString(36)}`;

/** Tries `run` with `adhesive`, falling back to hot glue when a turn or lift leaves flat faces misaligned for superglue. */
function tryWithHotglueFallback(adhesive: Adhesive, run: (a: Adhesive) => PlaceResult) {
  const first = run(adhesive);
  if (adhesive !== 'superglue' || first.problem !== 'superglue') {
    return { result: first, switchedToHotglue: false };
  }
  const glued = run('hotglue');
  if (glued.design) return { result: glued, switchedToHotglue: true };
  // Report why even hot glue failed (e.g. gap > 3 cm) instead of the superglue-only message.
  return { result: glued.problem ? glued : first, switchedToHotglue: false };
}

/**
 * The garage: build a car body from everyday things on a turntable. Drag something from the tray
 * onto the car where it should go; it sticks with the adhesive chosen (hot glue fills small gaps
 * too and lets go easily; superglue holds flat faces only, much stronger). Pieces on the car are
 * tapped to pick them, dragged to move them, and turned, lifted or taken off with the gizmo and buttons.
 */
export function Garage() {
  const slot = useGame((s) => s.garage) as PlayerId;
  const saved = useGame((s) => s.designs[slot]);
  const online = useGame((s) => s.online.status === 'on');
  const peerCars = useGame((s) => s.online.peerCars);
  const shareDesign = useGame((s) => s.shareDesign);
  const mode = useGame((s) => s.mode);

  const [design, setDesign] = useState<CarDesign>(() => saved ?? emptyDesign());
  const [past, setPast] = useState<CarDesign[]>([]);
  const [dirty, setDirty] = useState(false);
  const [trayDrag, setTrayDrag] = useState<TrayDragView | null>(null);
  const [tool, setTool] = useState<Adhesive>('hotglue');
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<Note>({ ok: true, text: HINT_START });
  const [made, setMade] = useState<SavedPart[]>(() => loadMadeParts());
  const [assemblies, setAssemblies] = useState<SavedAssembly[]>(() => loadAssemblies());
  const [savedCars, setSavedCars] = useState<SavedCar[]>(() => loadSavedCars());
  const [naming, setNaming] = useState<Naming>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [carName, setCarName] = useState('');
  /** The part maker: open on a new part (`null`) or on a saved one (its id); closed is `false`. */
  const [making, setMaking] = useState<string | null | false>(false);

  const host = useRef<HTMLDivElement>(null);
  const trayRef = useRef<HTMLElement>(null);
  const dragGhostRef = useRef<HTMLDivElement>(null);
  const view = useRef<GarageView | null>(null);
  const [garageView, setGarageView] = useState<GarageView | null>(null);
  const trayDragPlane = useRef<SupportPlane | null>(null);
  const trayDragRef = useRef<TrayDragSession | null>(null);
  const trayDragCleanupRef = useRef<(() => void) | null>(null);
  const pointerOutcomeRef = useRef<{ from: string; kind: 'drag' | 'tap' | 'scroll'; at: number } | null>(null);
  const dragPlane = useRef<DragPlane | null>(null);
  const lastDragNote = useRef<string | null>(null);
  // The 3D view calls back long after a render: it reads the latest state through this.
  const live = useRef({ design, tool, selected });
  live.current = { design, tool, selected };

  const thumbs = useMemo(() => Object.fromEntries(PIECES.map((p) => [p.kind, pieceThumbnail({ kind: p.kind }, slot)])), [slot]);
  const madeThumbs = useMemo(() => Object.fromEntries(made.map((m) => [m.id, pieceThumbnail({ kind: 'made', made: m.part }, slot)])), [made, slot]);
  const asmThumbs = useMemo(() => Object.fromEntries(assemblies.map((a) => [a.id, assemblyThumbnail(a.assembly, slot)])), [assemblies, slot]);

  const commit = (next: CarDesign) => {
    setPast((p) => [...p.slice(-29), live.current.design]);
    setDesign(next);
    setDirty(true);
  };

  const say = (ok: boolean, text: string) => setNote({ ok, text });

  /** Takes a placing that was worked out (`added` pieces new to the car); says why not when it cannot be. */
  const tryResult = (result: PlaceResult, added: number, done: string) => {
    if (!result.design) {
      say(false, PROBLEM_TEXT[result.problem!]);
      return false;
    }
    const lost = live.current.design.pieces.length + added - result.design.pieces.length;
    commit(result.design);
    say(true, lost > 0 ? `${done}（つながりが切れた ${lost} 個が外れました）` : done);
    return true;
  };

  /** Tries a piece where it is now; says why not when it cannot be there. */
  const tryPut = (piece: BodyPiece, done: string) =>
    tryResult(putPiece(live.current.design, piece), live.current.design.pieces.some((p) => p.id === piece.id) ? 0 : 1, done);

  /** Tries a part made of pieces already on the car where it is now (moved, turned or stuck again). */
  const tryGroup = (group: BodyPiece[], riders: BodyPiece[], adhesive: Adhesive, done: string) => tryResult(putGroup(live.current.design, group, [], adhesive, riders), 0, done);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const v = new GarageView(el, slot, {
      canDrag: (id) => !trayDragRef.current?.active && live.current.design.pieces.some((p) => p.id === id),
      group: (id) => {
        const ids = groupOf(live.current.design, id);
        return [...ids, ...hangingOnAll(live.current.design, ids)];
      },
      tap: (target) => {
        const d = live.current.design;
        const hit = target.hit;
        const id = hit && hit.target !== BASE ? hit.target : null;
        setSelected(id);
        if (id) {
          const p = d.pieces.find((q) => q.id === id)!;
          const ids = groupOf(d, id);
          if (ids.length > 1) say(true, `${groupName(ids.length)}をえらびました。ドラッグで端まで動かせます。まわりの矢印で回したり上下にずらせます。`);
          else say(true, `${label(p)}をえらびました（${ADHESIVE_LABEL[p.adhesive]}）。ドラッグで端まで動かせます。まわりの矢印で回したり上下にずらせます。`);
        }
      },
      dragStart: (id, grabPoint) => {
        dragPlane.current = createDragPlane(live.current.design, id, grabPoint);
        lastDragNote.current = null;
      },
      drag: (id, target) => {
        const d = live.current.design;
        const p = d.pieces.find((q) => q.id === id);
        const plane = dragPlane.current ?? createDragPlane(d, id, target.hit?.point ?? [p?.x ?? 0, p?.y ?? 0, p?.z ?? 0]);
        if (!p || !plane) return v.setGhost(null);
        const res = resolvePieceDrag(d, id, target, plane, live.current.tool);
        dragPlane.current = res.nextPlane;
        v.setGhost(res.pieces, res.result.design !== null);
        const nextMsg = res.result.design
          ? 'くっつけられる所なら、端でもそのまま動かせます（Shiftで 0.1cmずつ）。'
          : res.result.problem
            ? PROBLEM_TEXT[res.result.problem]
            : null;
        if (nextMsg && nextMsg !== lastDragNote.current) {
          lastDragNote.current = nextMsg;
          say(res.result.design !== null, nextMsg);
        }
      },
      drop: (id, target) => {
        v.setGhost(null);
        const d = live.current.design;
        const p = d.pieces.find((q) => q.id === id);
        const plane = dragPlane.current;
        dragPlane.current = null;
        lastDragNote.current = null;
        if (!p || !plane) return;
        setSelected(id);
        const res = resolvePieceDrag(d, id, target, plane, live.current.tool);
        const ids = groupOf(d, id);
        const name = ids.length > 1 ? groupName(ids.length) : label(p);
        if (!res.result.design) {
          tryResult(res.result, 0, `${name}を動かしました。`);
          return;
        }
        const moved = res.pieces.some((np) => {
          const op = d.pieces.find((q) => q.id === np.id);
          return !op || np.x !== op.x || np.y !== op.y || np.z !== op.z || np.rot.some((rv, i) => rv !== op.rot[i]);
        });
        if (moved) {
          tryResult(res.result, 0, `${name}を動かしました。`);
        } else {
          say(true, `${name}をえらびました。ドラッグで端まで動かせます。`);
        }
      },
      cancelDrag: () => {
        dragPlane.current = null;
        lastDragNote.current = null;
      },
    });
    view.current = v;
    setGarageView(v);
    return () => {
      v.dispose();
      view.current = null;
      setGarageView(null);
    };
    // The view lives as long as the garage is open on one car.
  }, [slot]);

  useEffect(() => view.current?.setDesign(design), [design]);
  const piece = design.pieces.find((p) => p.id === selected) ?? null;
  /** The picked piece, or all of the part made of pieces it is in. */
  const members = piece ? groupOf(design, piece.id) : [];
  const isGroup = members.length > 1;
  const membersKey = members.join(',');
  useEffect(() => view.current?.select(membersKey ? membersKey.split(',') : []), [membersKey]);

  const stopTrayDragListeners = () => {
    trayDragCleanupRef.current?.();
    trayDragCleanupRef.current = null;
  };

  const cancelTrayDrag = (announce = false) => {
    const session = trayDragRef.current;
    stopTrayDragListeners();
    trayDragRef.current = null;
    trayDragPlane.current = null;
    lastDragNote.current = null;
    view.current?.setGhost(null);
    setTrayDrag(null);
    if (announce && session?.active) {
      say(true, `${session.name}をトレイに戻しました。`);
    }
  };

  useEffect(() => {
    return () => {
      trayDragCleanupRef.current?.();
      trayDragCleanupRef.current = null;
      trayDragRef.current = null;
      trayDragPlane.current = null;
      lastDragNote.current = null;
      view.current?.setGhost(null);
    };
  }, []);

  // Switching cars starts from that car's saved body.
  const switchSlot = (next: PlayerId) => {
    if (next === slot) return;
    // The car being left keeps what was built or chosen on it.
    if (dirty || JSON.stringify(design) !== JSON.stringify(saved)) setCarDesign(slot, design);
    openGarage(next);
  };
  useEffect(() => {
    cancelTrayDrag(false);
    dragPlane.current = null;
    lastDragNote.current = null;
    setDesign(saved ?? emptyDesign());
    setPast([]);
    setDirty(false);
    setSelected(null);
    setNaming(null);
    setLibraryOpen(false);
    setCarName('');
    setNote({ ok: true, text: HINT_START });
    // Only when the car changes, not when this car's saved body does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot]);

  const isOverTray = (clientX: number, clientY: number) => {
    const rect = trayRef.current?.getBoundingClientRect();
    return Boolean(rect && clientY >= rect.top && clientX >= rect.left && clientX <= rect.right && clientY <= rect.bottom);
  };

  const updateTrayPreview = (session: TrayDragSession, clientX: number, clientY: number, shift: boolean) => {
    session.lastX = clientX;
    session.lastY = clientY;
    session.lastShift = shift;
    if (dragGhostRef.current) {
      dragGhostRef.current.style.transform = `translate3d(${clientX}px, ${clientY}px, 0)`;
    }

    const showDragNote = (ok: boolean, text: string) => {
      if (text !== lastDragNote.current) {
        lastDragNote.current = text;
        say(ok, text);
      }
    };

    const { design: d, tool: t } = live.current;
    let nextSnapped = false;
    if (isOverTray(clientX, clientY)) {
      trayDragPlane.current = null;
      view.current?.setGhost(null);
      showDragNote(true, `${session.name}を車の上へ動かして離すとくっつきます。`);
    } else {
      const target = view.current?.pickTarget(clientX, clientY, shift);
      const res = target ? resolveHandPlacement(d, target, session.hand, t, trayDragPlane.current) : null;
      if (res) {
        if (res.result.design) trayDragPlane.current = res.plane;
        view.current?.setGhost(res.pieces, res.result.design !== null);
        nextSnapped = true;
        if (res.result.design) {
          showDragNote(true, `ここで離すと${stuckWith(t)}ます（Shiftで 0.1cmずつ）。`);
        } else if (res.result.problem) {
          showDragNote(false, PROBLEM_TEXT[res.result.problem]);
        }
      } else {
        trayDragPlane.current = null;
        view.current?.setGhost(null);
        showDragNote(true, `${session.name}を車の上へ動かして離すとくっつきます。`);
      }
    }

    if (nextSnapped !== session.snapped) {
      session.snapped = nextSnapped;
      setTrayDrag({
        hand: session.hand,
        name: session.name,
        thumb: session.thumb,
        badge: session.badge,
        x: clientX,
        y: clientY,
        snapped: nextSnapped,
        isTouch: session.pointerType === 'touch',
      });
    }
  };

  const beginTrayDown = (e: React.PointerEvent<HTMLButtonElement>, item: TrayDragItem) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (trayDragRef.current) return;
    if (e.pointerType !== 'touch') e.preventDefault();

    const trayScrollable = (trayRef.current?.scrollWidth ?? 0) > (trayRef.current?.clientWidth ?? 0) + 2;
    const session: TrayDragSession = {
      ...item,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      lastShift: e.shiftKey,
      active: false,
      snapped: false,
      trayScrollable,
    };
    trayDragRef.current = session;

    let keyListenersAdded = false;
    const onKeyDown = (ev: KeyboardEvent) => {
      const s = trayDragRef.current;
      if (!s || !s.active) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        cancelTrayDrag(true);
        return;
      }
      if (ev.key === 'Shift' && !s.lastShift) {
        updateTrayPreview(s, s.lastX, s.lastY, true);
      }
    };
    const onKeyUp = (ev: KeyboardEvent) => {
      const s = trayDragRef.current;
      if (!s || !s.active) return;
      if (ev.key === 'Shift' && s.lastShift) {
        updateTrayPreview(s, s.lastX, s.lastY, false);
      }
    };
    const onBlur = () => {
      cancelTrayDrag(false);
    };

    const onWindowMove = (ev: PointerEvent) => {
      const s = trayDragRef.current;
      if (!s || ev.pointerId !== s.pointerId) return;
      if (!s.active) {
        const dx = ev.clientX - s.startX;
        const dy = ev.clientY - s.startY;
        const threshold = s.pointerType === 'touch' ? 8 : 6;
        if (Math.hypot(dx, dy) <= threshold) return;
        if (s.pointerType === 'touch' && s.trayScrollable && !(dy < 0 && Math.abs(dy) >= Math.abs(dx) * 0.65)) {
          stopTrayDragListeners();
          trayDragRef.current = null;
          pointerOutcomeRef.current = { from: s.hand.from, kind: 'scroll', at: performance.now() };
          return;
        }
        s.active = true;
        setSelected(null);
        trayDragPlane.current = null;
        lastDragNote.current = null;
        if (!keyListenersAdded) {
          keyListenersAdded = true;
          window.addEventListener('keydown', onKeyDown);
          window.addEventListener('keyup', onKeyUp);
          window.addEventListener('blur', onBlur);
        }
        setTrayDrag({
          hand: s.hand,
          name: s.name,
          thumb: s.thumb,
          badge: s.badge,
          x: ev.clientX,
          y: ev.clientY,
          snapped: false,
          isTouch: s.pointerType === 'touch',
        });
        updateTrayPreview(s, ev.clientX, ev.clientY, ev.shiftKey);
        return;
      }
      updateTrayPreview(s, ev.clientX, ev.clientY, ev.shiftKey);
    };

    const finishTrayDrag = (ev: PointerEvent, cancelled: boolean) => {
      const s = trayDragRef.current;
      if (!s || ev.pointerId !== s.pointerId) return;
      const prevPlane = trayDragPlane.current;
      const wasActive = s.active;
      stopTrayDragListeners();
      trayDragRef.current = null;
      trayDragPlane.current = null;
      lastDragNote.current = null;
      view.current?.setGhost(null);
      setTrayDrag(null);

      if (!wasActive) {
        if (!cancelled) {
          pointerOutcomeRef.current = { from: s.hand.from, kind: 'tap', at: performance.now() };
          say(true, `${s.name}を車の上へドラッグしてくっつけよう。`);
        } else {
          pointerOutcomeRef.current = { from: s.hand.from, kind: 'scroll', at: performance.now() };
        }
        return;
      }

      pointerOutcomeRef.current = { from: s.hand.from, kind: 'drag', at: performance.now() };
      if (cancelled || isOverTray(ev.clientX, ev.clientY)) {
        say(true, `${s.name}をトレイに戻しました。`);
        return;
      }

      const target = view.current?.pickTarget(ev.clientX, ev.clientY, ev.shiftKey);
      const { design: d, tool: t } = live.current;
      const res = target ? resolveHandPlacement(d, target, s.hand, t, prevPlane) : null;
      if (!res) {
        say(true, `${s.name}をトレイに戻しました。`);
        return;
      }
      if (tryResult(res.result, res.pieces.length, `${s.name}を${stuckWith(t)}ました。`)) {
        setSelected(res.pieces[0].id);
      }
    };

    const onWindowUp = (ev: PointerEvent) => finishTrayDrag(ev, false);
    const onWindowCancel = (ev: PointerEvent) => finishTrayDrag(ev, true);

    window.addEventListener('pointermove', onWindowMove);
    window.addEventListener('pointerup', onWindowUp);
    window.addEventListener('pointercancel', onWindowCancel);
    trayDragCleanupRef.current = () => {
      window.removeEventListener('pointermove', onWindowMove);
      window.removeEventListener('pointerup', onWindowUp);
      window.removeEventListener('pointercancel', onWindowCancel);
      if (keyListenersAdded) {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('blur', onBlur);
      }
    };
  };

  const handleTrayClick = (e: React.MouseEvent<HTMLButtonElement>, item: TrayDragItem) => {
    const outcome = pointerOutcomeRef.current;
    if (e.detail !== 0 && outcome && outcome.from === item.hand.from && performance.now() - outcome.at < 400) {
      pointerOutcomeRef.current = null;
      return;
    }
    pointerOutcomeRef.current = null;
    if (e.detail === 0) {
      const { design: d, tool: t } = live.current;
      const res = findDefaultHandPlacement(d, item.hand, t);
      if (!res) {
        say(false, '車の上に置ける場所が見つかりませんでした。');
        return;
      }
      if (tryResult(res.result, res.pieces.length, `${item.name}を${stuckWith(t)}ました。`)) {
        setSelected(res.pieces[0].id);
      }
      return;
    }
    say(true, `${item.name}を車の上へドラッグしてくっつけよう。`);
  };

  /** False (and says so) when the device would not keep the tray's parts, or the look of `part`. */
  const keepMade = (next: SavedPart[], ...parts: MadePart[]) => {
    setMade(next);
    const kept = saveMadeParts(next) && parts.every((p) => !p.mesh || keepMesh(p.mesh));
    if (!kept) say(false, 'この端末には部品を保存できませんでした。ページを閉じるまでは使えます。');
    return kept;
  };

  /** A part from the maker: a new one goes in the tray ready to drag onto the car. */
  const saveMade = (part: MadePart) => {
    if (making === false) return;
    if (making === null) {
      const id = newPartId();
      const kept = keepMade([...made, { id, part }], part);
      setMaking(false);
      setSelected(null);
      if (kept) say(true, `${part.name}をつくりました。トレイから車の上へドラッグしてくっつけよう。`);
      return;
    }
    const id = making;
    const kept = keepMade(
      made.map((m) => (m.id === id ? { id, part } : m)),
      part,
    );
    setMaking(false);
    if (kept) say(true, `${part.name}をなおしました。もう車についている物は、そのままです。`);
  };

  const partFiles = useRef<HTMLInputElement>(null);

  /**
   * Adds made-up parts and assemblies to the tray without duplicating items already there.
   * Each taken item is stored on this device as an independent copy.
   */
  const addPartsToTray = (
    found: MadePart[],
    foundAsm: Assembly[],
    options: { unreadable?: number; verb?: string; extraNote?: string } = {},
  ): { ok: boolean; text: string } => {
    const { unreadable = 0, verb = 'トレイに入れました', extraNote = '' } = options;
    const freshOf = <T,>(list: T[], there: T[], keyOf: (item: T) => string) => {
      const known = new Set(there.map(keyOf));
      return list.filter((x) => {
        const key = keyOf(x);
        if (known.has(key)) return false;
        known.add(key);
        return true;
      });
    };
    const fresh = freshOf(found, made.map((m) => m.part), (p) => JSON.stringify(p));
    const freshAsm = freshOf(
      foundAsm,
      assemblies.map((a) => a.assembly),
      (a) => JSON.stringify({ pieces: a.pieces, joints: a.joints }),
    );
    const taken = fresh.slice(0, Math.max(0, MAX_MADE_PARTS - made.length));
    const takenAsm = freshAsm.slice(0, Math.max(0, MAX_ASSEMBLIES - assemblies.length));
    if (taken.length === 0 && takenAsm.length === 0) {
      return {
        ok: false,
        text: fresh.length || freshAsm.length ? 'トレイがいっぱいです。' : 'どれも、もうトレイにある部品でした。',
      };
    }
    if (taken.length && !keepMade([...made, ...taken.map((part) => ({ id: newPartId(), part }))], ...taken)) {
      return { ok: false, text: 'この端末には部品を保存できませんでした。ページを閉じるまでは使えます。' };
    }
    if (takenAsm.length && !keepAssemblies([...assemblies, ...takenAsm.map((assembly) => ({ id: newPartId(), assembly }))], ...takenAsm)) {
      return { ok: false, text: 'この端末には部品を保存できませんでした。ページを閉じるまでは使えます。' };
    }
    const left = fresh.length - taken.length + freshAsm.length - takenAsm.length;
    return {
      ok: !extraNote,
      text:
        `${[...taken, ...takenAsm].map((p) => p.name).join('、')}を${verb}。` +
        (left ? `トレイがいっぱいで、${left}こは入りませんでした。` : '') +
        (unreadable ? `読めないファイルが${unreadable}こありました。` : '') +
        extraNote,
    };
  };

  /** Parts from files go in the tray after the ones there (a part already there is not added twice). */
  const loadParts = async (files: File[]) => {
    const found: MadePart[] = [];
    const foundAsm: Assembly[] = [];
    let unreadable = 0;
    for (const file of files) {
      const read = await importParts(file).catch(() => null);
      if (read) {
        found.push(...read.parts);
        foundAsm.push(...read.assemblies);
      } else unreadable++;
    }
    if (found.length === 0 && foundAsm.length === 0) {
      say(false, unreadable ? '部品のファイルではありませんでした。' : 'ファイルに部品が入っていませんでした。');
      return;
    }
    const res = addPartsToTray(found, foundAsm, { unreadable, verb: '読み込みました' });
    say(res.ok, res.text);
  };

  const dropMade = () => {
    if (typeof making !== 'string') return;
    const gone = made.find((m) => m.id === making);
    const kept = keepMade(made.filter((m) => m.id !== making));
    setMaking(false);
    if (kept) say(true, `${gone?.part.name ?? '部品'}をトレイからすてました。もう車についている物は、そのままです。`);
  };

  /** The adhesive the picked part made of pieces is stuck to the rest of the car with. */
  const groupAdhesive = () => outerAdhesive(design, members) ?? tool;

  /** Evaluates rotating the selected piece or group by `deltaDeg` degrees around `axis` from the committed design. */
  const evaluateRotation = (axis: RotationAxis, deltaDeg: number) => {
    const d = live.current.design;
    const p = d.pieces.find((q) => q.id === live.current.selected);
    if (!p) {
      return {
        pieces: [] as BodyPiece[],
        movingIds: [] as string[],
        result: { design: null, problem: null } as PlaceResult,
        switchedToHotglue: false,
        labelName: '',
      };
    }
    const m = groupOf(d, p.id);
    const radians = (deltaDeg * Math.PI) / 180;
    if (m.length > 1) {
      // Turned about its middle, still resting on what it was put on.
      const rot = rotateOrientation(IDENTITY, axis, radians);
      const seat = p.seat ?? [0, 1, 0];
      const asm = assemblyOf(d, m, '');
      const from = centerOf(m.map((id) => d.pieces.find((q) => q.id === id)!));
      const shift = assemblyReach(asm, rot, seat) - assemblyReach(asm, IDENTITY, seat);
      const { group, riders } = groupMoved(d, m, rot, [from[0] + seat[0] * shift, from[1] + seat[1] * shift, from[2] + seat[2] * shift]);
      const adhesive = outerAdhesive(d, m) ?? live.current.tool;
      const { result, switchedToHotglue } = tryWithHotglueFallback(adhesive, (a) => putGroup(d, group, [], a, riders));
      return {
        pieces: [...group, ...riders],
        movingIds: [...m, ...riders.map((r) => r.id)],
        result,
        switchedToHotglue,
        labelName: groupName(m.length),
      };
    }
    const turned = turnedInPlace(p, rotateOrientation(p.rot, axis, radians));
    const pieces = movedGroup(d, turned);
    const movingIds = pieces.map((q) => q.id);
    // Tilted, superglue seldom meets a flat face any more: hot glue takes over
    // rather than the turn failing.
    const { result, switchedToHotglue } = tryWithHotglueFallback(turned.adhesive, (a) => putPiece(d, { ...turned, adhesive: a }));
    return { pieces, movingIds, result, switchedToHotglue, labelName: label(p) };
  };

  const previewRotate = (axis: RotationAxis, deltaDeg: number): RotationPreviewResult => {
    const ev = evaluateRotation(axis, deltaDeg);
    if (ev.movingIds.length > 0) {
      view.current?.hide(ev.movingIds);
      view.current?.setPreview(ev.pieces, ev.result.design ? 'solid' : 'bad');
    }
    if (!ev.result.design) {
      if (ev.result.problem) say(false, PROBLEM_TEXT[ev.result.problem]);
      return { ok: false, problem: ev.result.problem, switchedToHotglue: false };
    }
    say(
      true,
      ev.switchedToHotglue
        ? '平らな面が合わないので、ホットグルーでくっつけ直します。'
        : '輪の中で 15°ずつ・輪の外で 1°ずつ 回せます。',
    );
    return { ok: true, problem: null, switchedToHotglue: ev.switchedToHotglue };
  };

  const commitRotate = (axis: RotationAxis, deltaDeg: number) => {
    view.current?.setPreview(null);
    view.current?.hide([]);
    if (deltaDeg === 0) return;
    const ev = evaluateRotation(axis, deltaDeg);
    const signed = deltaDeg > 0 ? `+${deltaDeg}°` : `${deltaDeg}°`;
    const done = ev.switchedToHotglue
      ? `${ev.labelName}を ${signed} 回しました。平らな面が合わないので、ホットグルーでくっつけ直しました。`
      : `${ev.labelName}を ${signed} 回しました。`;
    tryResult(ev.result, 0, done);
  };

  const cancelRotate = () => {
    view.current?.setPreview(null);
    view.current?.hide([]);
  };

  /** Evaluates lifting or lowering the selected piece or group by `deltaM` meters along +Y from the committed design. */
  const evaluateLift = (deltaM: number) => {
    const d = live.current.design;
    const p = d.pieces.find((q) => q.id === live.current.selected);
    if (!p) {
      return {
        pieces: [] as BodyPiece[],
        movingIds: [] as string[],
        result: { design: null, problem: null } as PlaceResult,
        switchedToHotglue: false,
        labelName: '',
      };
    }
    const m = groupOf(d, p.id);
    if (m.length > 1) {
      const to = centerOf(m.map((id) => d.pieces.find((q) => q.id === id)!));
      to[1] = Math.round((to[1] + deltaM) * 10000) / 10000;
      const { group, riders } = groupMoved(d, m, IDENTITY, to);
      const adhesive = outerAdhesive(d, m) ?? live.current.tool;
      const { result, switchedToHotglue } = tryWithHotglueFallback(adhesive, (a) => putGroup(d, group, [], a, riders));
      return {
        pieces: [...group, ...riders],
        movingIds: [...m, ...riders.map((r) => r.id)],
        result,
        switchedToHotglue,
        labelName: groupName(m.length),
      };
    }
    const moved = { ...p, y: Math.round((p.y + deltaM) * 10000) / 10000 };
    const pieces = movedGroup(d, moved);
    const movingIds = pieces.map((q) => q.id);
    const { result, switchedToHotglue } = tryWithHotglueFallback(moved.adhesive, (a) => putPiece(d, { ...moved, adhesive: a }));
    return { pieces, movingIds, result, switchedToHotglue, labelName: label(p) };
  };

  const previewLift = (deltaM: number): RotationPreviewResult => {
    const ev = evaluateLift(deltaM);
    if (ev.movingIds.length > 0) {
      view.current?.hide(ev.movingIds);
      view.current?.setPreview(ev.pieces, ev.result.design ? 'solid' : 'bad');
    }
    if (!ev.result.design) {
      if (ev.result.problem) say(false, PROBLEM_TEXT[ev.result.problem]);
      return { ok: false, problem: ev.result.problem, switchedToHotglue: false };
    }
    say(
      true,
      ev.switchedToHotglue
        ? 'すき間ができたので、ホットグルーでくっつけ直します。'
        : '上下にドラッグで 0.5cmずつ 動かせます（Shiftで 0.1cmずつ）。',
    );
    return { ok: true, problem: null, switchedToHotglue: ev.switchedToHotglue };
  };

  const commitLift = (deltaM: number) => {
    view.current?.setPreview(null);
    view.current?.hide([]);
    if (deltaM === 0) return;
    const ev = evaluateLift(deltaM);
    const cm = Math.round(Math.abs(deltaM) * 1000) / 10;
    const dirLabel = deltaM >= 0 ? '上' : '下';
    const done = ev.switchedToHotglue
      ? `${ev.labelName}を ${cm}cm ${dirLabel}にずらしました。すき間ができたので、ホットグルーでくっつけ直しました。`
      : `${ev.labelName}を ${cm}cm ${dirLabel}にずらしました。`;
    tryResult(ev.result, 0, done);
  };

  /** The adhesive for the next thing from the tray. */
  const chooseTool = (next: Adhesive) => {
    setTool(next);
    say(true, TOOL_NOTE[next]);
  };

  /** The adhesive the picked piece (or part) would be stuck on with again: the other one. */
  const restickTo = (p: BodyPiece | null): Adhesive | null => {
    if (!p) return null;
    const now = isGroup ? groupAdhesive() : p.adhesive;
    return now === 'hotglue' ? 'superglue' : 'hotglue';
  };

  /** Sticks the picked piece again with another adhesive. */
  const restick = () => {
    const next = restickTo(piece);
    if (!piece || !next) return;
    if (isGroup) {
      const d = live.current.design;
      tryGroup(members.map((id) => d.pieces.find((p) => p.id === id)!), [], next, `${stuckWith(next)}直しました。`);
      return;
    }
    tryPut({ ...piece, adhesive: next }, `${stuckWith(next)}直しました。`);
  };

  const remove = () => {
    if (!piece) return;
    if (isGroup) {
      const next = removePieces(design, members);
      const lost = design.pieces.length - members.length - next.pieces.length;
      commit(next);
      setSelected(null);
      say(true, lost > 0 ? `外しました。それにくっついていた ${lost} 個も外れました。` : `${groupName(members.length)}を外しました。`);
      return;
    }
    const next = removePiece(design, piece.id);
    const lost = design.pieces.length - 1 - next.pieces.length;
    commit(next);
    setSelected(null);
    say(true, lost > 0 ? `外しました。それにくっついていた ${lost} 個も外れました。` : `${label(piece)}を外しました。`);
  };

  /** What is stuck to the picked piece through other pieces: what "まとめる" makes into one. */
  const stuck = piece ? stuckTogether(design, piece.id) : [];
  const canMerge = stuck.length > 1 && stuck.length > members.length;

  /** The picked piece and what is stuck to it, made into one part on the car. */
  const merge = () => {
    if (!canMerge) return;
    commit(makeGroup(design, stuck));
    say(true, `${stuck.length}こを1つの組み部品にまとめました。ドラッグでいっしょに動かせます。トレイに入れることもできます。`);
  };

  const breakUp = () => {
    if (!piece || !isGroup) return;
    commit(breakGroup(design, piece.id));
    say(true, 'ばらばらに戻しました。1つずつ動かせます。');
  };

  /** False (and says so) when the device would not keep the tray's parts made of parts, or their looks. */
  const keepAssemblies = (next: SavedAssembly[], ...added: Assembly[]) => {
    setAssemblies(next);
    const looks = assemblyParts(added.map((assembly) => ({ id: '', assembly })));
    const kept = saveAssemblies(next) && looks.every((p) => !p.mesh || keepMesh(p.mesh));
    if (!kept) say(false, 'この端末には部品を保存できませんでした。ページを閉じるまでは使えます。');
    return kept;
  };

  const namingAssembly = !naming ? null : 'assembly' in naming ? naming.assembly : (assemblies.find((a) => a.id === naming.id)?.assembly ?? null);

  /** A name from the dialog: the picked part goes in the tray, or the tray's one is renamed. */
  const saveNamed = (name: string) => {
    if (!naming || !namingAssembly) return;
    const assembly = { ...namingAssembly, name };
    if ('assembly' in naming) {
      if (assemblies.length >= MAX_ASSEMBLIES) {
        say(false, `トレイがいっぱいです。組み部品は ${MAX_ASSEMBLIES} こまでです。`);
        setNaming(null);
        return;
      }
      const kept = keepAssemblies([...assemblies, { id: newPartId(), assembly }], assembly);
      setNaming(null);
      if (kept) say(true, `${name}をトレイに入れました。トレイからドラッグすると、この組み合わせのままくっつけられます。`);
      return;
    }
    const id = naming.id;
    const kept = keepAssemblies(assemblies.map((a) => (a.id === id ? { id, assembly } : a)));
    setNaming(null);
    if (kept) say(true, `${name}に名前を変えました。`);
  };

  const dropAssembly = () => {
    if (!naming || !('id' in naming)) return;
    const id = naming.id;
    const gone = assemblies.find((a) => a.id === id);
    const kept = keepAssemblies(assemblies.filter((a) => a.id !== id));
    setNaming(null);
    if (kept) say(true, `${gone?.assembly.name ?? '組み部品'}をトレイからすてました。もう車についている物は、そのままです。`);
  };

  const undo = () => {
    const previous = past[past.length - 1];
    if (!previous) return;
    setPast(past.slice(0, -1));
    setDesign(previous);
    setDirty(true);
    setSelected(null);
  };

  const clearAll = () => {
    if (design.pieces.length === 0) return;
    commit(emptyDesign());
    setSelected(null);
    say(true, 'ぜんぶ外しました。');
  };

  const finish = () => {
    setCarDesign(slot, design);
    openGarage(null);
  };

  const pruneUnusedMeshes = (cars: SavedCar[]) => {
    const stored = getState().designs;
    pruneMeshes(
      [...made.map((m) => m.part), ...assemblyParts(assemblies)],
      [stored.p1, stored.p2, live.current.design, ...past, ...cars.map((c) => c.design)],
    );
  };

  const saveCar = (rawName: string): Note => {
    const current = live.current.design;
    const meshesKept = current.pieces.every((p) => !p.made?.mesh || keepMesh(p.made.mesh));
    const next = saveCarToLibrary(rawName, current);
    if (!next) {
      pruneUnusedMeshes(savedCars);
      return {
        ok: false,
        text: `保存できませんでした。保存できるのは ${MAX_SAVED_CARS} 台までです。古い車体を削除するか、端末の空きを確認してください。`,
      };
    }
    setSavedCars(next);
    const savedName = next[0]?.name ?? rawName.trim();
    setCarName(savedName);
    setDirty(false);
    return meshesKept
      ? { ok: true, text: `「${savedName}」を端末に保存しました。` }
      : { ok: false, text: `「${savedName}」を保存しましたが、STL 部品の見た目は端末に保存できませんでした。` };
  };

  /**
   * Saves the current car to this device before switching to another car if it has unsaved changes.
   * Returns the saved name when an auto-save took place, or null otherwise.
   */
  const autoSaveBeforeSwitch = (): string | null => {
    const current = live.current.design;
    if (!dirty || current.pieces.length === 0) return null;
    const currentJson = JSON.stringify(current);
    const trimmed = carName.trim();
    if (trimmed) {
      const existing = savedCars.find((c) => c.name === trimmed);
      if (existing && JSON.stringify(existing.design) === currentJson) return null;
    } else if (savedCars.some((c) => JSON.stringify(c.design) === currentJson)) {
      return null;
    }
    let targetName = trimmed;
    if (!targetName) {
      const base = 'マイカー';
      targetName = base;
      let n = 2;
      while (savedCars.some((c) => c.name === targetName)) {
        targetName = `${base} ${n++}`;
      }
    }
    for (const p of current.pieces) if (p.made?.mesh) keepMesh(p.made.mesh);
    const next = saveCarToLibrary(targetName, current);
    if (!next) return null;
    setSavedCars(next);
    return next[0]?.name ?? targetName;
  };

  const switchDesignTo = (next: CarDesign, nextName: string) => {
    setPast((p) => [...p.slice(-29), live.current.design]);
    setDesign(next);
    setDirty(false);
    setSelected(null);
    setCarName(nextName);
    setLibraryOpen(false);
  };

  const loadCar = (car: SavedCar) => {
    const autoSaved = autoSaveBeforeSwitch();
    switchDesignTo(car.design, car.name);
    const prefix = autoSaved && autoSaved !== car.name ? `いまの車を「${autoSaved}」に保存して、` : '';
    say(true, `${prefix}「${car.name}」に切り替えました。「元に戻す」で前の車に戻せます。`);
  };

  const exportCarDesign = (target: CarDesign, rawName: string): Note => {
    const { lookLost } = exportCar(target, rawName);
    return lookLost
      ? { ok: false, text: 'ファイルに書き出しましたが、一部の STL 部品の見た目は入れられませんでした。' }
      : { ok: true, text: 'ファイルに書き出しました。' };
  };

  const importCarFile = async (file: File): Promise<Note | null> => {
    const loaded = await importCar(file).catch(() => null);
    if (!loaded) {
      return { ok: false, text: '車体のファイルではないので、読み込めませんでした。' };
    }
    const autoSaved = autoSaveBeforeSwitch();
    switchDesignTo(loaded.design, loaded.name);
    const shown = loaded.name ? `「${loaded.name}」` : '車体';
    const prefix = autoSaved ? `いまの車を「${autoSaved}」に保存して、` : '';
    say(
      !loaded.lookLost,
      loaded.lookLost
        ? `${prefix}${shown}を読み込みましたが、一部の STL 部品の見た目が使えませんでした。`
        : `${prefix}${shown}を読み込みました。「元に戻す」で前の車に戻せます。`,
    );
    return null;
  };

  const deleteCar = (car: SavedCar): Note => {
    const next = removeSavedCar(car.id);
    setSavedCars(next);
    if (carName.trim() === car.name) {
      setCarName('');
    }
    pruneUnusedMeshes(next);
    return { ok: true, text: `「${car.name}」を削除しました。` };
  };

  const loadPeerCar = async (peer: OnlinePeerCar): Promise<Note | null> => {
    if (!peer.shared || !peer.design) {
      return { ok: false, text: '相手は車体を提供していません。' };
    }
    await ensureMeshes(peer.design);
    const cleaned = stripMissingMeshes(peer.design, (id) => meshBytes(id) !== null);
    const autoSaved = autoSaveBeforeSwitch();
    switchDesignTo(cleaned.design, '');
    const prefix = autoSaved ? `いまの車を「${autoSaved}」に保存して、` : '';
    say(
      !cleaned.lookLost,
      cleaned.lookLost
        ? `${prefix}${peer.label}に切り替えました（一部の STL 部品は基本の形になりました）。部品をえらんで「トレイに入れる」と自分の部品として使えます。`
        : `${prefix}${peer.label}に切り替えました。部品をえらんで「トレイに入れる」と自分の部品として使えます（「元に戻す」で前の車に戻せます）。`,
    );
    return null;
  };

  const classic = () => {
    setCarDesign(slot, null);
    openGarage(null);
  };

  const mass = designMass(design);
  const count = (a: Adhesive) => design.joints.filter((j) => j.kind === a).length;
  const restickNext = restickTo(piece);
  const slots: { id: PlayerId; label: string }[] = online
    ? [{ id: 'p1', label: 'あなたの車' }]
    : [
        { id: 'p1', label: '1P の車' },
        { id: 'p2', label: mode === 'cpu' ? 'CPU の車' : '2P の車' },
      ];
  const memberPieces = useMemo(
    () => (piece ? members.map((id) => design.pieces.find((p) => p.id === id)).filter((p): p is BodyPiece => !!p) : []),
    [design.pieces, members, piece],
  );
  const selectedMadeParts = useMemo(() => {
    const out: MadePart[] = [];
    const seen = new Set<string>();
    for (const p of memberPieces) {
      if (p.kind !== 'made' || !p.made) continue;
      const copy = readMadePart(p.made);
      if (!copy) continue;
      const key = JSON.stringify(copy);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(copy);
    }
    return out;
  }, [memberPieces]);

  const takeSelectedMadeParts = () => {
    if (selectedMadeParts.length === 0) return;
    const res = addPartsToTray(selectedMadeParts, [], { verb: 'トレイに入れました' });
    say(res.ok, res.text);
  };

  const selectedPieces =
    piece && !trayDrag && !naming && making === false && !libraryOpen
      ? memberPieces
      : [];
  const pickedName = isGroup ? groupName(members.length) : piece ? label(piece) : 'なし';
  const partCardProps = (item: TrayDragItem) => ({
    'aria-label': `${item.name}（車の上へドラッグしてくっつける・Enterキーで配置）`,
    title: '車の上へドラッグしてくっつけます',
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => beginTrayDown(e, item),
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => handleTrayClick(e, item),
  });

  return (
    <section className={`garage garage-${slot}${trayDrag ? ' is-tray-dragging' : ''}`} aria-labelledby="garage-title">
      <div className="garage-stage">
        <div className="garage-canvas-host" ref={host} />
        <RotationGizmo
          view={garageView}
          pieces={selectedPieces}
          onPreview={previewRotate}
          onCommit={commitRotate}
          onPreviewLift={previewLift}
          onCommitLift={commitLift}
          onCancel={cancelRotate}
        />
      </div>

      <header className="garage-head">
        <h2 id="garage-title" className="garage-title">
          <span className="garage-badge">GARAGE</span>
          車をつくる
        </h2>
        <div className="garage-slots" role="tablist" aria-label="つくる車">
          {slots.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={s.id === slot} className={`garage-slot slot-${s.id}`} onClick={() => switchSlot(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="garage-head-actions">
          <button type="button" className="g-button" disabled={past.length === 0} onClick={undo}>
            元に戻す
          </button>
          <button
            type="button"
            className="g-button"
            onClick={() => {
              cancelTrayDrag(false);
              setLibraryOpen(true);
            }}
          >
            車体を選ぶ
          </button>
          <button type="button" className="g-button" onClick={() => openGarage(null)}>
            やめる
          </button>
          <button type="button" className="g-button g-go" onClick={finish}>
            決定！
          </button>
        </div>
      </header>

      <p className={`garage-note ${note?.ok === false ? 'is-bad' : ''}`} role="status" aria-live="polite">
        {note?.text}
      </p>

      <aside className="garage-side garage-left" aria-label="くっつけ方">
        <span className="g-label">次の物のくっつけ方</span>
        <div className="g-tool" role="radiogroup" aria-label="くっつけ方">
          {ADHESIVES.map((a) => (
            <button key={a} type="button" role="radio" aria-checked={tool === a} className={`g-tool-${a}`} onClick={() => chooseTool(a)}>
              {a === 'hotglue' ? <HotGlueIcon /> : <SuperGlueIcon />}
              <span className="g-tool-name">{ADHESIVE_LABEL[a]}</span>
              <span className="g-tool-sub">{TOOL_SUB[a]}</span>
            </button>
          ))}
        </div>
        <dl className="g-stats">
          <div>
            <dt>パーツ</dt>
            <dd>
              {design.pieces.length} / {MAX_PIECES}
            </dd>
          </div>
          {ADHESIVES.map((a) => (
            <div key={a}>
              <dt>{ADHESIVE_LABEL[a]}</dt>
              <dd>{count(a)} か所</dd>
            </div>
          ))}
        </dl>
        <div className="g-weight" aria-label={`重さ ${Math.round((mass / MAX_PIECE_MASS) * 100)}%`}>
          <span className="g-label">重さ</span>
          <span className="g-meter">
            <span className="g-meter-fill" style={{ width: `${Math.min(100, (mass / MAX_PIECE_MASS) * 100)}%` }} />
          </span>
          <span className="g-weight-note">重いほど押されにくいけれど、加速がにぶくなる</span>
        </div>
      </aside>

      <aside className="garage-side garage-right" aria-label={trayDrag ? '持っている物' : 'えらんだ物'}>
        <span className="g-label">{trayDrag ? `持っている物：${trayDrag.name}` : `えらんだ物：${pickedName}`}</span>
        <div className="g-pad">
          <button type="button" className={`g-button g-${restickNext ?? 'hotglue'}-button`} disabled={!piece} onClick={restick}>
            {restickNext ? `${ADHESIVE_LABEL[restickNext]}で付け直す` : '付け直す'}
          </button>
          <button type="button" className="g-button g-danger" disabled={!piece} onClick={remove}>
            外す
          </button>
          <button type="button" className="g-button" disabled={design.pieces.length === 0} onClick={clearAll}>
            ぜんぶ外す
          </button>
          <button type="button" className="g-button" onClick={classic}>
            いつもの車に戻す
          </button>
        </div>
        <div className="g-pad g-group-pad" aria-label="組み部品">
          {isGroup ? (
            <>
              <button type="button" className="g-button g-asm-button" onClick={() => setNaming({ assembly: assemblyOf(design, members, '') })}>
                トレイに入れる
              </button>
              <button type="button" className="g-button" onClick={breakUp}>
                ばらす
              </button>
            </>
          ) : (
            <>
              {selectedMadeParts.length > 0 && (
                <button
                  type="button"
                  className="g-button g-asm-button"
                  title="えらんだ自作部品を自分のトレイに入れます"
                  onClick={takeSelectedMadeParts}
                >
                  トレイに入れる
                </button>
              )}
              <button
                type="button"
                className="g-button g-asm-button"
                disabled={!canMerge}
                title="えらんだ物と、それにくっついている物を1つの部品にします"
                onClick={merge}
              >
                1つにまとめる
              </button>
            </>
          )}
        </div>
      </aside>

      <nav ref={trayRef} className="garage-tray" aria-label="くっつける物">
        {PIECES.map((p) => {
          const type: PartType = { kind: p.kind };
          const item: TrayDragItem = {
            hand: { ...type, rot: defaultRot(type), from: p.kind },
            name: p.label,
            thumb: thumbs[p.kind] ?? '',
          };
          return (
            <button
              key={p.kind}
              type="button"
              className={`g-card g-card-part${trayDrag?.hand.from === p.kind ? ' is-dragging' : ''}`}
              {...partCardProps(item)}
            >
              {thumbs[p.kind] ? <img src={thumbs[p.kind]} alt="" draggable={false} /> : <span className="g-card-blank" />}
              <span className="g-card-name">{p.label}</span>
            </button>
          );
        })}
        {made.map((m) => {
          const type: PartType = { kind: 'made', made: m.part };
          const item: TrayDragItem = {
            hand: { ...type, rot: defaultRot(type), from: m.id },
            name: m.part.name,
            thumb: madeThumbs[m.id] ?? '',
          };
          return (
            <div key={m.id} className="g-card-made">
              <button
                type="button"
                className={`g-card g-card-part${trayDrag?.hand.from === m.id ? ' is-dragging' : ''}`}
                {...partCardProps(item)}
              >
                {madeThumbs[m.id] ? <img src={madeThumbs[m.id]} alt="" draggable={false} /> : <span className="g-card-blank" />}
                <span className="g-card-name">{m.part.name}</span>
              </button>
              <button type="button" className="g-card-edit" aria-label={`${m.part.name}をなおす`} title="なおす" onClick={() => setMaking(m.id)}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3 13 L3.6 10.4 L10.6 3.4 L12.6 5.4 L5.6 12.4 Z M9.6 4.4 L11.6 6.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          );
        })}
        {assemblies.map((a) => {
          const item: TrayDragItem = {
            hand: { asm: a.assembly, rot: IDENTITY, from: a.id },
            name: a.assembly.name,
            thumb: asmThumbs[a.id] ?? '',
            badge: `×${a.assembly.pieces.length}`,
          };
          return (
            <div key={a.id} className="g-card-made">
              <button
                type="button"
                className={`g-card g-card-part g-card-asm${trayDrag?.hand.from === a.id ? ' is-dragging' : ''}`}
                {...partCardProps(item)}
              >
                {asmThumbs[a.id] ? <img src={asmThumbs[a.id]} alt="" draggable={false} /> : <span className="g-card-blank" />}
                <span className="g-card-name">{a.assembly.name}</span>
                <span className="g-card-badge" aria-label={`${a.assembly.pieces.length}この組み部品`}>
                  ×{a.assembly.pieces.length}
                </span>
              </button>
              <button type="button" className="g-card-edit" aria-label={`${a.assembly.name}をなおす`} title="なおす" onClick={() => setNaming({ id: a.id })}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3 13 L3.6 10.4 L10.6 3.4 L12.6 5.4 L5.6 12.4 Z M9.6 4.4 L11.6 6.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          );
        })}
        {made.length < MAX_MADE_PARTS && (
          <button type="button" className="g-card g-card-new" onClick={() => setMaking(null)}>
            <span className="g-card-plus" aria-hidden="true">
              ＋
            </span>
            <span className="g-card-name">部品をつくる</span>
          </button>
        )}
        <button
          type="button"
          className="g-card g-card-new"
          aria-label="部品のファイルを読み込む"
          title="書き出した部品のファイルを読み込みます"
          onClick={() => partFiles.current?.click()}
        >
          <span className="g-card-plus" aria-hidden="true">
            <FileArrow down={false} />
          </span>
          <span className="g-card-name">読み込む</span>
        </button>
        {(made.length > 0 || assemblies.length > 0) && (
          <button
            type="button"
            className="g-card g-card-new"
            aria-label="つくった部品をぜんぶファイルに書き出す"
            title="つくった部品と組み部品をぜんぶ、1つのファイルにします"
            onClick={() =>
              exportParts(
                made.map((m) => m.part),
                'じぶんの部品',
                assemblies.map((a) => a.assembly),
              )
            }
          >
            <span className="g-card-plus" aria-hidden="true">
              <FileArrow down />
            </span>
            <span className="g-card-name">書き出す</span>
          </button>
        )}
        <input
          ref={partFiles}
          type="file"
          accept=".json,application/json"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            // Cleared, so that choosing the same file again is a change too.
            e.target.value = '';
            if (files.length) void loadParts(files);
          }}
        />
      </nav>

      {trayDrag && (
        <div
          ref={dragGhostRef}
          className={`g-drag-ghost${trayDrag.snapped ? ' is-snapped' : ''}${trayDrag.isTouch ? ' is-touch' : ''}`}
          style={{ transform: `translate3d(${trayDrag.x}px, ${trayDrag.y}px, 0)` }}
          aria-hidden="true"
        >
          <div className="g-drag-ghost-card">
            {trayDrag.thumb ? <img src={trayDrag.thumb} alt="" draggable={false} /> : <span className="g-card-blank" />}
            <span className="g-card-name">{trayDrag.name}</span>
            {trayDrag.badge && <span className="g-card-badge">{trayDrag.badge}</span>}
          </div>
        </div>
      )}

      {naming && namingAssembly && (
        <AssemblyDialog
          player={slot}
          assembly={namingAssembly}
          editing={'id' in naming}
          onSave={saveNamed}
          onExport={(name) => exportParts([], name, [{ ...namingAssembly, name }])}
          onDelete={'id' in naming ? dropAssembly : null}
          onClose={() => setNaming(null)}
        />
      )}

      {making !== false && (
        <PartMaker
          player={slot}
          editing={making === null ? null : (made.find((m) => m.id === making)?.part ?? null)}
          onSave={saveMade}
          onDelete={making === null ? null : dropMade}
          onClose={() => setMaking(false)}
        />
      )}

      {libraryOpen && (
        <CarLibrary
          player={slot}
          design={design}
          name={carName}
          savedCars={savedCars}
          online={online}
          shareDesign={shareDesign}
          peerCars={peerCars}
          onName={setCarName}
          onSave={saveCar}
          onLoad={loadCar}
          onExport={exportCarDesign}
          onImport={importCarFile}
          onDelete={deleteCar}
          onShareDesign={setShareDesign}
          onLoadPeer={loadPeerCar}
          onClose={() => setLibraryOpen(false)}
        />
      )}
    </section>
  );
}

/** A sheet with an arrow: out of it (`down`, writing a file) or into it (reading one). */
function FileArrow({ down }: { down: boolean }) {
  return (
    <svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true">
      <path d="M8 4 H19 L25 10 V28 H8 Z M19 4 V10 H25" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      {down ? (
        <path d="M16.5 13 V23 M12.5 19 L16.5 23 L20.5 19" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M16.5 23 V13 M12.5 17 L16.5 13 L20.5 17" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function SuperGlueIcon() {
  return (
    <svg className="g-icon" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M4 10 L10 4 L20 14 L14 20 Z" fill="#DBEAFE" stroke="#1D4ED8" strokeWidth="2" strokeLinejoin="round" />
      <path d="M8 10 L11 7 L17 13 L14 16 Z" fill="#FFFFFF" stroke="#2563EB" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M18.5 15.5 L24 24 L15.5 18.5 Z" fill="#FFFFFF" stroke="#1D4ED8" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M27 24.5 C28.8 26.8 29 28 29 28.8 A2 2 0 1 1 25 28.8 C25 28 25.2 26.8 27 24.5 Z" fill="#60A5FA" stroke="#1D4ED8" strokeWidth="1.6" />
    </svg>
  );
}

function HotGlueIcon() {
  return (
    <svg className="g-icon" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M4 9 H21 V17 H12 L10 27 H5 L7 17 H4 Z" fill="#F9A8D4" stroke="#DB2777" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M21 11 L27 12.5 V14 L21 15.5 Z" fill="#E2E8F0" stroke="#DB2777" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M1 12 H4" stroke="#FDF4FF" strokeWidth="3" strokeLinecap="round" />
      <circle cx="29" cy="17.5" r="2" fill="#FDF4FF" stroke="#F472B6" strokeWidth="1.2" />
    </svg>
  );
}
