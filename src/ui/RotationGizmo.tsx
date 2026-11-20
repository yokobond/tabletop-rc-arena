import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { BodyPiece, PlaceProblem } from '../game/bodyParts';
import {
  PROTRACTOR_INNER_RADIUS,
  PROTRACTOR_LOCAL_RADIUS,
  layoutRotationGizmo,
  pointerOnProtractor,
  selectionBounds,
  stepDragAngle,
  stepLiftDelta,
  type GizmoLayout,
  type HandleSides,
  type LiftAxisScreen,
  type ProtractorPlane,
  type RotationAxis,
} from '../game/rotationGizmo';
import type { GarageView } from '../aframe/garageView';

export interface RotationPreviewResult {
  ok: boolean;
  problem: PlaceProblem | null;
  switchedToHotglue: boolean;
}

interface Props {
  view: GarageView | null;
  pieces: readonly BodyPiece[];
  onPreview: (axis: RotationAxis, deltaDeg: number) => RotationPreviewResult;
  onCommit: (axis: RotationAxis, deltaDeg: number) => void;
  onPreviewLift: (deltaM: number) => RotationPreviewResult;
  onCommitLift: (deltaM: number) => void;
  onCancel: () => void;
}

interface DragSession {
  axis: RotationAxis;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  moved: boolean;
  plane: ProtractorPlane;
  startAngleDeg: number;
  prevAngleDeg: number;
  unwrappedDeg: number;
  deltaDeg: number;
  mode: 'snap' | 'fine';
  step: number;
  pointerU: number;
  pointerV: number;
  ok: boolean;
  handleX: number;
  handleY: number;
}

interface LiftDragSession {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  lastClientX: number;
  lastClientY: number;
  moved: boolean;
  axis: LiftAxisScreen;
  originScreenX: number;
  originScreenY: number;
  deltaM: number;
  stepM: number;
  ok: boolean;
  handleX: number;
  handleY: number;
}

interface AngleEdit {
  axis: RotationAxis;
  x: number;
  y: number;
  value: string;
}

interface LiftEdit {
  x: number;
  y: number;
  value: string;
}

const AXIS_LABEL: Record<RotationAxis, string> = {
  y: 'くるっと回す（Y軸）',
  x: '前に倒す（X軸）',
  z: '横に倒す（Z軸）',
};

const DRAG_THRESHOLD_PX = 4;

function normalizeNumberString(raw: string): string {
  return raw
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[−ー－]/g, '-')
    .replace(/＋/g, '+')
    .replace(/．/g, '.')
    .trim();
}

function normalizeAngleInput(raw: string): number | null {
  const s = normalizeNumberString(raw);
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || Math.abs(n) > 360) return null;
  return Math.round(n);
}

function normalizeCmInput(raw: string): number | null {
  const s = normalizeNumberString(raw);
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || Math.abs(n) > 50) return null;
  return Math.round(n * 10) / 10 + 0;
}

function clamp(v: number, lo: number, hi: number) {
  return hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
}

function sectorPath(innerR: number, outerR: number, startDeg: number, deltaDeg: number): string {
  if (deltaDeg === 0) return '';
  const clamped = Math.abs(deltaDeg) >= 180 ? (deltaDeg > 0 ? 179.9 : -179.9) : deltaDeg;
  const a0 = (startDeg * Math.PI) / 180;
  const a1 = ((startDeg + clamped) * Math.PI) / 180;
  const sweep = clamped >= 0 ? 1 : 0;
  const large = Math.abs(clamped) > 180 ? 1 : 0;
  const ox0 = Math.cos(a0) * outerR;
  const oy0 = Math.sin(a0) * outerR;
  const ox1 = Math.cos(a1) * outerR;
  const oy1 = Math.sin(a1) * outerR;
  const ix1 = Math.cos(a1) * innerR;
  const iy1 = Math.sin(a1) * innerR;
  const ix0 = Math.cos(a0) * innerR;
  const iy0 = Math.sin(a0) * innerR;
  return [
    `M ${ox0.toFixed(2)} ${oy0.toFixed(2)}`,
    `A ${outerR} ${outerR} 0 ${large} ${sweep} ${ox1.toFixed(2)} ${oy1.toFixed(2)}`,
    `L ${ix1.toFixed(2)} ${iy1.toFixed(2)}`,
    `A ${innerR} ${innerR} 0 ${large} ${1 - sweep} ${ix0.toFixed(2)} ${iy0.toFixed(2)}`,
    'Z',
  ].join(' ');
}

function annulusPath(innerR: number, outerR: number): string {
  return [
    `M ${outerR} 0 A ${outerR} ${outerR} 0 1 0 ${-outerR} 0 A ${outerR} ${outerR} 0 1 0 ${outerR} 0 Z`,
    `M ${innerR} 0 A ${innerR} ${innerR} 0 1 1 ${-innerR} 0 A ${innerR} ${innerR} 0 1 1 ${innerR} 0 Z`,
  ].join(' ');
}

const RING_BAND_PATH = annulusPath(PROTRACTOR_INNER_RADIUS, PROTRACTOR_LOCAL_RADIUS);

export function RotationGizmo({ view, pieces, onPreview, onCommit, onPreviewLift, onCommitLift, onCancel }: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const sidesRef = useRef<HandleSides | undefined>(undefined);
  const dragRef = useRef<DragSession | null>(null);
  const liftDragRef = useRef<LiftDragSession | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const latestCallbacks = useRef({ onPreview, onCommit, onPreviewLift, onCommitLift, onCancel });
  latestCallbacks.current = { onPreview, onCommit, onPreviewLift, onCommitLift, onCancel };

  const [layout, setLayout] = useState<GizmoLayout | null>(null);
  const [viewSize, setViewSize] = useState<{ w: number; h: number }>({ w: 1, h: 1 });
  const [hiddenByPosDrag, setHiddenByPosDrag] = useState(false);
  const [drag, setDrag] = useState<DragSession | null>(null);
  const [liftDrag, setLiftDrag] = useState<LiftDragSession | null>(null);
  const [editing, setEditing] = useState<AngleEdit | null>(null);
  const [liftEdit, setLiftEdit] = useState<LiftEdit | null>(null);

  const bounds = useMemo(() => selectionBounds(pieces), [pieces]);
  const selectionKey = pieces.map((p) => `${p.id}:${p.x}:${p.y}:${p.z}:${p.rot.join(',')}`).join('|');

  const stopDragListeners = () => {
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
  };

  useEffect(() => stopDragListeners, []);

  useEffect(() => {
    if (dragRef.current || liftDragRef.current) {
      stopDragListeners();
      dragRef.current = null;
      liftDragRef.current = null;
      setDrag(null);
      setLiftDrag(null);
      latestCallbacks.current.onCancel();
    }
    setEditing(null);
    setLiftEdit(null);
  }, [selectionKey]);

  useEffect(() => {
    if (!view || !bounds) {
      setLayout(null);
      sidesRef.current = undefined;
      return;
    }

    const sync = () => {
      if (dragRef.current || liftDragRef.current) return;
      const posDragging = view.isPositionDragging();
      setHiddenByPosDrag(posDragging);
      if (posDragging) return;
      const snap = view.cameraSnapshot();
      setViewSize({ w: snap.width, h: snap.height });
      const next = layoutRotationGizmo({
        bounds,
        cameraPos: snap.pos,
        width: snap.width,
        height: snap.height,
        project: (p) => view.projectPoint(p),
        prevSides: sidesRef.current,
      });
      sidesRef.current = next.sides;
      setLayout(next);
    };

    sync();
    return view.onCameraChange(sync);
  }, [view, bounds]);

  const anyDrag = drag !== null || liftDrag !== null;
  const anyDragMoved = !!drag?.moved || !!liftDrag?.moved;
  const anyEdit = editing !== null || liftEdit !== null;

  // Cancel drag with Escape, and refresh snap step immediately when Shift toggles mid-drag.
  useEffect(() => {
    if (!anyDrag) return;
    const applyKeyShift = (shiftKey: boolean) => {
      const d = dragRef.current;
      if (d && d.moved) {
        const radiusNorm = Math.hypot(d.pointerU, d.pointerV) / PROTRACTOR_LOCAL_RADIUS;
        const stepped = stepDragAngle({
          prevAngleDeg: d.prevAngleDeg,
          currAngleDeg: d.prevAngleDeg,
          prevUnwrappedDeg: d.unwrappedDeg,
          radiusNorm,
          shiftKey,
        });
        if (stepped.deltaDeg === d.deltaDeg && stepped.step === d.step && stepped.mode === d.mode) return;
        const res = stepped.deltaDeg !== d.deltaDeg ? latestCallbacks.current.onPreview(d.axis, stepped.deltaDeg) : { ok: d.ok };
        const next: DragSession = {
          ...d,
          deltaDeg: stepped.deltaDeg,
          mode: stepped.mode,
          step: stepped.step,
          ok: res.ok,
        };
        dragRef.current = next;
        setDrag(next);
        return;
      }
      const l = liftDragRef.current;
      if (l && l.moved) {
        const stepped = stepLiftDelta({
          dx: l.lastClientX - l.startClientX,
          dy: l.lastClientY - l.startClientY,
          axis: l.axis,
          shiftKey,
        });
        if (stepped.deltaM === l.deltaM && stepped.stepM === l.stepM) return;
        const res = stepped.deltaM !== l.deltaM ? latestCallbacks.current.onPreviewLift(stepped.deltaM) : { ok: l.ok };
        const next: LiftDragSession = {
          ...l,
          deltaM: stepped.deltaM,
          stepM: stepped.stepM,
          ok: res.ok,
        };
        liftDragRef.current = next;
        setLiftDrag(next);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        stopDragListeners();
        dragRef.current = null;
        liftDragRef.current = null;
        setDrag(null);
        setLiftDrag(null);
        latestCallbacks.current.onCancel();
        return;
      }
      if (e.key === 'Shift') applyKeyShift(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') applyKeyShift(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [anyDrag]);

  // Close the direct-input popover when tapping outside or pressing Escape.
  useEffect(() => {
    if (!anyEdit) return;
    const onOutside = (e: PointerEvent) => {
      if (formRef.current && !formRef.current.contains(e.target as Node)) {
        setEditing(null);
        setLiftEdit(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setEditing(null);
        setLiftEdit(null);
      }
    };
    window.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [anyEdit]);

  if (!view || !bounds || !layout || hiddenByPosDrag) return null;

  const toLayerPoint = (clientX: number, clientY: number) => {
    const rect = layerRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };

  const beginHandleDown = (axis: RotationAxis, handleX: number, handleY: number, e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    stopDragListeners();
    setEditing(null);
    setLiftEdit(null);

    const plane = layout.planes[axis];
    const { x: sx, y: sy } = toLayerPoint(e.clientX, e.clientY);
    let pt = pointerOnProtractor(plane, sx, sy);
    if (!pt || Math.hypot(pt.u, pt.v) < 4) {
      pt = pointerOnProtractor(plane, handleX, handleY) ?? { u: PROTRACTOR_LOCAL_RADIUS, v: 0, angleDeg: 0, radiusNorm: 1 };
    }
    const session: DragSession = {
      axis,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
      plane,
      startAngleDeg: pt.angleDeg,
      prevAngleDeg: pt.angleDeg,
      unwrappedDeg: 0,
      deltaDeg: 0,
      mode: pt.radiusNorm <= 1.1 ? 'snap' : 'fine',
      step: e.shiftKey ? 5 : 15,
      pointerU: pt.u,
      pointerV: pt.v,
      ok: true,
      handleX,
      handleY,
    };
    dragRef.current = session;
    setDrag(session);

    const onWindowMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d || ev.pointerId !== d.pointerId) return;
      if (!d.moved && Math.hypot(ev.clientX - d.startClientX, ev.clientY - d.startClientY) <= DRAG_THRESHOLD_PX) return;

      const { x: lx, y: ly } = toLayerPoint(ev.clientX, ev.clientY);
      const nextPt = pointerOnProtractor(d.plane, lx, ly);
      if (!nextPt) return;

      const currAngle = Math.hypot(nextPt.u, nextPt.v) < 4 ? d.prevAngleDeg : nextPt.angleDeg;
      const stepped = stepDragAngle({
        prevAngleDeg: d.prevAngleDeg,
        currAngleDeg: currAngle,
        prevUnwrappedDeg: d.unwrappedDeg,
        radiusNorm: nextPt.radiusNorm,
        shiftKey: ev.shiftKey,
      });

      const res =
        !d.moved || stepped.deltaDeg !== d.deltaDeg
          ? latestCallbacks.current.onPreview(d.axis, stepped.deltaDeg)
          : { ok: d.ok, problem: null, switchedToHotglue: false };

      const next: DragSession = {
        ...d,
        moved: true,
        prevAngleDeg: currAngle,
        unwrappedDeg: stepped.unwrappedDeg,
        deltaDeg: stepped.deltaDeg,
        mode: stepped.mode,
        step: stepped.step,
        pointerU: nextPt.u,
        pointerV: nextPt.v,
        ok: res.ok,
      };
      dragRef.current = next;
      setDrag(next);
    };

    const finishDrag = (ev: PointerEvent, cancelled: boolean) => {
      const d = dragRef.current;
      if (!d || ev.pointerId !== d.pointerId) return;
      stopDragListeners();
      dragRef.current = null;
      setDrag(null);

      if (cancelled) {
        latestCallbacks.current.onCancel();
        return;
      }
      if (!d.moved) {
        latestCallbacks.current.onCancel();
        setEditing({
          axis: d.axis,
          x: d.handleX,
          y: d.handleY,
          value: '',
        });
        return;
      }
      if (d.deltaDeg !== 0) latestCallbacks.current.onCommit(d.axis, d.deltaDeg);
      else latestCallbacks.current.onCancel();
    };

    const onWindowUp = (ev: PointerEvent) => finishDrag(ev, false);
    const onWindowCancel = (ev: PointerEvent) => finishDrag(ev, true);

    window.addEventListener('pointermove', onWindowMove);
    window.addEventListener('pointerup', onWindowUp);
    window.addEventListener('pointercancel', onWindowCancel);
    dragCleanupRef.current = () => {
      window.removeEventListener('pointermove', onWindowMove);
      window.removeEventListener('pointerup', onWindowUp);
      window.removeEventListener('pointercancel', onWindowCancel);
    };
  };

  const beginLiftDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    stopDragListeners();
    setEditing(null);
    setLiftEdit(null);

    const { x: handleX, y: handleY, axis } = layout.lift;
    const session: LiftDragSession = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
      moved: false,
      axis,
      originScreenX: handleX,
      originScreenY: handleY,
      deltaM: 0,
      stepM: e.shiftKey ? 0.001 : 0.005,
      ok: true,
      handleX,
      handleY,
    };
    liftDragRef.current = session;
    setLiftDrag(session);

    const onWindowMove = (ev: PointerEvent) => {
      const l = liftDragRef.current;
      if (!l || ev.pointerId !== l.pointerId) return;
      const dx = ev.clientX - l.startClientX;
      const dy = ev.clientY - l.startClientY;
      if (!l.moved && Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return;

      const stepped = stepLiftDelta({
        dx,
        dy,
        axis: l.axis,
        shiftKey: ev.shiftKey,
      });

      const res =
        !l.moved || stepped.deltaM !== l.deltaM
          ? latestCallbacks.current.onPreviewLift(stepped.deltaM)
          : { ok: l.ok, problem: null, switchedToHotglue: false };

      const next: LiftDragSession = {
        ...l,
        lastClientX: ev.clientX,
        lastClientY: ev.clientY,
        moved: true,
        deltaM: stepped.deltaM,
        stepM: stepped.stepM,
        ok: res.ok,
      };
      liftDragRef.current = next;
      setLiftDrag(next);
    };

    const finishLift = (ev: PointerEvent, cancelled: boolean) => {
      const l = liftDragRef.current;
      if (!l || ev.pointerId !== l.pointerId) return;
      stopDragListeners();
      liftDragRef.current = null;
      setLiftDrag(null);

      if (cancelled) {
        latestCallbacks.current.onCancel();
        return;
      }
      if (!l.moved) {
        latestCallbacks.current.onCancel();
        setLiftEdit({
          x: l.handleX,
          y: l.handleY,
          value: '',
        });
        return;
      }
      if (l.deltaM !== 0) latestCallbacks.current.onCommitLift(l.deltaM);
      else latestCallbacks.current.onCancel();
    };

    const onWindowUp = (ev: PointerEvent) => finishLift(ev, false);
    const onWindowCancel = (ev: PointerEvent) => finishLift(ev, true);

    window.addEventListener('pointermove', onWindowMove);
    window.addEventListener('pointerup', onWindowUp);
    window.addEventListener('pointercancel', onWindowCancel);
    dragCleanupRef.current = () => {
      window.removeEventListener('pointermove', onWindowMove);
      window.removeEventListener('pointerup', onWindowUp);
      window.removeEventListener('pointercancel', onWindowCancel);
    };
  };

  const submitAngle = (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const deg = normalizeAngleInput(editing.value);
    const axis = editing.axis;
    setEditing(null);
    if (deg !== null && deg !== 0) onCommit(axis, deg);
  };

  const submitLift = (e: FormEvent) => {
    e.preventDefault();
    if (!liftEdit) return;
    const cm = normalizeCmInput(liftEdit.value);
    setLiftEdit(null);
    if (cm !== null && cm !== 0) {
      const meters = Math.round((cm / 100) * 10000) / 10000;
      if (meters !== 0) onCommitLift(meters);
    }
  };

  const renderProtractor = () => {
    if (!drag || !drag.moved) return null;
    const p = drag.plane;
    const tickStep = drag.mode === 'snap' && drag.step === 5 ? 5 : 15;
    const tickCount = Math.round(360 / tickStep);
    const ticks = Array.from({ length: tickCount }, (_, i) => {
      const offsetDeg = i * tickStep;
      const rad = ((drag.startAngleDeg + offsetDeg) * Math.PI) / 180;
      const major = offsetDeg % 45 === 0;
      const fine = offsetDeg % 15 !== 0;
      const inner = major ? PROTRACTOR_INNER_RADIUS + 2 : fine ? PROTRACTOR_LOCAL_RADIUS - 8 : PROTRACTOR_LOCAL_RADIUS - 14;
      const outer = PROTRACTOR_LOCAL_RADIUS;
      return {
        key: i,
        major,
        fine,
        x1: Math.cos(rad) * inner,
        y1: Math.sin(rad) * inner,
        x2: Math.cos(rad) * outer,
        y2: Math.sin(rad) * outer,
      };
    });

    const startRad = (drag.startAngleDeg * Math.PI) / 180;
    const currRad = ((drag.startAngleDeg + drag.deltaDeg) * Math.PI) / 180;
    const zeroX = Math.cos(startRad) * PROTRACTOR_LOCAL_RADIUS;
    const zeroY = Math.sin(startRad) * PROTRACTOR_LOCAL_RADIUS;
    const knobX = Math.cos(currRad) * PROTRACTOR_LOCAL_RADIUS;
    const knobY = Math.sin(currRad) * PROTRACTOR_LOCAL_RADIUS;
    const sweep = sectorPath(PROTRACTOR_INNER_RADIUS, PROTRACTOR_LOCAL_RADIUS, drag.startAngleDeg, drag.deltaDeg);
    const readoutX = clamp(p.cx, 78, viewSize.w - 78);
    const readoutY = p.cy - p.screenRadius - 28 < 68 ? clamp(p.cy + p.screenRadius + 28, 40, viewSize.h - 40) : p.cy - p.screenRadius - 28;

    return (
      <>
        <svg
          className={`g-rot-protractor axis-${drag.axis}${drag.ok ? '' : ' is-bad'}`}
          viewBox={`0 0 ${viewSize.w} ${viewSize.h}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <g transform={`matrix(${p.a.toFixed(4)} ${p.b.toFixed(4)} ${p.c.toFixed(4)} ${p.d.toFixed(4)} ${p.cx.toFixed(2)} ${p.cy.toFixed(2)})`}>
            {drag.mode === 'fine' && <circle className="g-rot-fine-ring" cx="0" cy="0" r="118" vectorEffect="non-scaling-stroke" />}
            <path className="g-rot-ring-fill" d={RING_BAND_PATH} fillRule="evenodd" />
            {sweep && <path className="g-rot-sweep" d={sweep} />}
            <circle className="g-rot-ring-edge" cx="0" cy="0" r={PROTRACTOR_LOCAL_RADIUS} vectorEffect="non-scaling-stroke" />
            <circle className="g-rot-ring-inner" cx="0" cy="0" r={PROTRACTOR_INNER_RADIUS} vectorEffect="non-scaling-stroke" />
            {ticks.map((t) => (
              <line
                key={t.key}
                className={t.major ? 'g-rot-tick major' : t.fine ? 'g-rot-tick fine' : 'g-rot-tick'}
                x1={t.x1}
                y1={t.y1}
                x2={t.x2}
                y2={t.y2}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <line className="g-rot-zero" x1="0" y1="0" x2={zeroX} y2={zeroY} vectorEffect="non-scaling-stroke" />
            {drag.mode === 'fine' && (
              <>
                <line className="g-rot-ray" x1={knobX} y1={knobY} x2={drag.pointerU} y2={drag.pointerV} vectorEffect="non-scaling-stroke" />
                <circle className="g-rot-pointer-dot" cx={drag.pointerU} cy={drag.pointerV} r="4.5" vectorEffect="non-scaling-stroke" />
              </>
            )}
            <line className="g-rot-needle" x1="0" y1="0" x2={knobX} y2={knobY} vectorEffect="non-scaling-stroke" />
            <circle className="g-rot-knob" cx={knobX} cy={knobY} r="6.5" vectorEffect="non-scaling-stroke" />
          </g>
        </svg>
        <div
          className={`g-rot-readout axis-${drag.axis}${drag.ok ? '' : ' is-bad'}`}
          style={{ left: `${readoutX}px`, top: `${readoutY}px` }}
          aria-live="polite"
        >
          <span className="g-rot-deg">{drag.deltaDeg > 0 ? `+${drag.deltaDeg}°` : `${drag.deltaDeg}°`}</span>
          <span className="g-rot-step">{drag.step}°ずつ</span>
        </div>
      </>
    );
  };

  const renderLiftGuide = () => {
    if (!liftDrag || !liftDrag.moved) return null;
    const { axis, originScreenX: ox, originScreenY: oy, deltaM, stepM, ok } = liftDrag;
    const spanPx = deltaM * axis.pxPerMeter;
    const kx = ox + axis.dirX * spanPx;
    const ky = oy + axis.dirY * spanPx;
    const railHalfPx = Math.max(0.03 * axis.pxPerMeter, Math.abs(spanPx) + 18);
    const x1 = ox - axis.dirX * railHalfPx;
    const y1 = oy - axis.dirY * railHalfPx;
    const x2 = ox + axis.dirX * railHalfPx;
    const y2 = oy + axis.dirY * railHalfPx;

    const tickIntervalPx = 0.005 * axis.pxPerMeter;
    const tickCount = Math.min(20, Math.floor(railHalfPx / tickIntervalPx));
    const nx = -axis.dirY;
    const ny = axis.dirX;
    const ticks: { key: number; major: boolean; x1: number; y1: number; x2: number; y2: number }[] = [];
    for (let i = -tickCount; i <= tickCount; i++) {
      if (i === 0) continue;
      const major = i % 2 === 0;
      const halfLen = major ? 7 : 4;
      const tx = ox + axis.dirX * (i * tickIntervalPx);
      const ty = oy + axis.dirY * (i * tickIntervalPx);
      ticks.push({
        key: i,
        major,
        x1: tx - nx * halfLen,
        y1: ty - ny * halfLen,
        x2: tx + nx * halfLen,
        y2: ty + ny * halfLen,
      });
    }

    const cm = Math.round(deltaM * 1000) / 10;
    const signedCm = cm > 0 ? `+${cm} cm` : `${cm} cm`;
    const stepCm = Math.round(stepM * 1000) / 10;
    const readoutX = kx + 84 > viewSize.w - 20 ? clamp(kx - 76, 72, viewSize.w - 72) : clamp(kx + 76, 72, viewSize.w - 72);
    const readoutY = clamp(ky, 44, viewSize.h - 44);

    return (
      <>
        <svg
          className={`g-lift-guide${ok ? '' : ' is-bad'}`}
          viewBox={`0 0 ${viewSize.w} ${viewSize.h}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line className="g-lift-rail" x1={x1} y1={y1} x2={x2} y2={y2} />
          {ticks.map((t) => (
            <line key={t.key} className={t.major ? 'g-lift-tick major' : 'g-lift-tick'} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
          ))}
          <line className="g-lift-span" x1={ox} y1={oy} x2={kx} y2={ky} />
          <circle className="g-lift-origin" cx={ox} cy={oy} r="4.5" />
          <circle className="g-lift-knob" cx={kx} cy={ky} r="6.5" />
        </svg>
        <div
          className={`g-lift-readout${ok ? '' : ' is-bad'}`}
          style={{ left: `${readoutX}px`, top: `${readoutY}px` }}
          aria-live="polite"
        >
          <span className="g-rot-deg">{signedCm}</span>
          <span className="g-rot-step">{stepCm}cmずつ</span>
        </div>
      </>
    );
  };

  return (
    <div ref={layerRef} className={`g-rot-layer${anyDrag ? ' is-dragging' : ''}`}>
      {renderProtractor()}
      {renderLiftGuide()}
      {layout.lift.visible && (
        <button
          type="button"
          className={`g-lift-handle${anyDragMoved ? ' is-hidden' : ''}`}
          style={{ left: `${layout.lift.x}px`, top: `${layout.lift.y}px` }}
          aria-label="上下にずらす（ドラッグで移動・クリックで数値入力）"
          title="上下にずらす：ドラッグで移動／クリックで数値入力"
          onPointerDown={beginLiftDown}
          onWheel={(e) => {
            e.preventDefault();
            view.zoom(Math.exp(e.deltaY * 0.0012));
          }}
        >
          <svg viewBox="-22 -22 44 44" aria-hidden="true">
            <g transform={`rotate(${layout.lift.axis.angleDeg.toFixed(2)})`}>
              <path className="g-lift-arrow-halo" d="M 0 -10 L 0 10" />
              <path className="g-lift-heads-halo" d="M 0 -16 L -5.5 -8.5 L 5.5 -8.5 Z M 0 16 L -5.5 8.5 L 5.5 8.5 Z" />
              <path className="g-lift-arrow" d="M 0 -10 L 0 10" />
              <path className="g-lift-heads" d="M 0 -16 L -5.5 -8.5 L 5.5 -8.5 Z M 0 16 L -5.5 8.5 L 5.5 8.5 Z" />
            </g>
          </svg>
        </button>
      )}
      {layout.handles.map((h) => {
        if (!h.visible) return null;
        return (
          <button
            key={h.axis}
            type="button"
            className={`g-rot-handle axis-${h.axis}${anyDragMoved ? ' is-hidden' : ''}`}
            style={{ left: `${h.x}px`, top: `${h.y}px` }}
            aria-label={`${AXIS_LABEL[h.axis]}（ドラッグで回転・クリックで角度入力）`}
            title={`${AXIS_LABEL[h.axis]}：ドラッグで回転／クリックで角度入力`}
            onPointerDown={(e) => beginHandleDown(h.axis, h.x, h.y, e)}
            onWheel={(e) => {
              e.preventDefault();
              view.zoom(Math.exp(e.deltaY * 0.0012));
            }}
          >
            <svg viewBox="-22 -22 44 44" aria-hidden="true">
              <path className="g-rot-arrow-halo" d={h.arc} />
              <path className="g-rot-heads-halo" d={h.heads} />
              <path className="g-rot-arrow" d={h.arc} />
              <path className="g-rot-heads" d={h.heads} />
            </svg>
          </button>
        );
      })}
      {editing && (
        <form
          ref={formRef}
          className={`g-rot-edit axis-${editing.axis}`}
          style={{
            left: `${clamp(editing.x, 96, viewSize.w - 96)}px`,
            top: `${clamp(editing.y - 46, 54, viewSize.h - 54)}px`,
          }}
          onSubmit={submitAngle}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="g-rot-edit-label">{AXIS_LABEL[editing.axis]}</span>
          <div className="g-rot-edit-row">
            <input
              type="text"
              inputMode="numeric"
              aria-label="回す角度（度）"
              placeholder="例: 45, -15"
              autoFocus
              value={editing.value}
              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
            />
            <span className="g-rot-edit-unit">°</span>
            <button type="submit" className="g-button g-rot-edit-ok">
              OK
            </button>
          </div>
        </form>
      )}
      {liftEdit && (
        <form
          ref={formRef}
          className="g-rot-edit g-lift-edit"
          style={{
            left: `${clamp(liftEdit.x, 96, viewSize.w - 96)}px`,
            top: `${clamp(liftEdit.y - 46, 54, viewSize.h - 54)}px`,
          }}
          onSubmit={submitLift}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="g-rot-edit-label">上下にずらす（+上 / -下）</span>
          <div className="g-rot-edit-row">
            <input
              type="text"
              inputMode="decimal"
              aria-label="上下にずらす距離（cm）"
              placeholder="例: 1, -0.5"
              autoFocus
              value={liftEdit.value}
              onChange={(e) => setLiftEdit({ ...liftEdit, value: e.target.value })}
            />
            <span className="g-rot-edit-unit">cm</span>
            <button type="submit" className="g-button g-rot-edit-ok">
              OK
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
