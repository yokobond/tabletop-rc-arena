import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { PlayerId } from '../game/types';
import { input } from '../runtime/input';
import { playerName, useGame } from '../runtime/store';

const DEAD_ZONE = 0.14;
/** Pushing the stick this far toward its edge, within BOOST_ARC of straight ahead, boosts. */
const BOOST_REACH = 0.85;
const BOOST_ARC = (30 * Math.PI) / 180;
const DOUBLE_TAP_MS = 320;

const TAP_SLOP = 6;

type Offset = { x: number; y: number };
const ZERO: Offset = { x: 0, y: 0 };

// Where each pad was dragged to, per layout. Saved for this browser only; losing it just resets the pads.
const offsetKey = (slot: string) => `rc-sumo:pad-offset:${slot}`;

function loadOffset(slot: string): Offset {
  try {
    const raw = localStorage.getItem(offsetKey(slot));
    const v = raw ? JSON.parse(raw) : null;
    if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) return { x: v.x, y: v.y };
  } catch {
    // Storage blocked or bad data: use the default spot.
  }
  return ZERO;
}

function saveOffset(slot: string, offset: Offset) {
  try {
    if (offset.x === 0 && offset.y === 0) localStorage.removeItem(offsetKey(slot));
    else localStorage.setItem(offsetKey(slot), JSON.stringify(offset));
  } catch {
    // Not saved; the pad still stays put for this visit.
  }
}

/**
 * Dragging the name tag moves the whole pad; a double tap puts it back.
 * The offset is in screen pixels and applied with the `translate` property, which sits
 * outside the pad's own rotation, so the pad follows the finger in either layout.
 */
function usePadDrag(slot: string, padRef: RefObject<HTMLDivElement | null>) {
  const [offset, setOffset] = useState<Offset>(() => loadOffset(slot));
  const drag = useRef<{ id: number; x: number; y: number; from: Offset; bounds: DOMRect; moved: boolean } | null>(null);
  const lastTap = useRef(0);

  useEffect(() => setOffset(loadOffset(slot)), [slot]);

  // A saved spot can fall off screen after the tablet turns: nudge the pad back in.
  useEffect(() => {
    const fit = () => {
      const pad = padRef.current;
      if (!pad || drag.current) return;
      const r = pad.getBoundingClientRect();
      const dx = Math.max(-r.left, Math.min(window.innerWidth - r.right, 0));
      const dy = Math.max(-r.top, Math.min(window.innerHeight - r.bottom, 0));
      if (dx !== 0 || dy !== 0) setOffset((o) => ({ x: o.x + dx, y: o.y + dy }));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [padRef, offset]);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (drag.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      from: offset,
      bounds: padRef.current!.getBoundingClientRect(),
      moved: false,
    };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    let dx = e.clientX - d.x;
    let dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
    d.moved = true;
    // Keep the whole pad on screen.
    const { innerWidth: w, innerHeight: h } = window;
    dx = Math.max(-d.bounds.left, Math.min(w - d.bounds.right, dx));
    dy = Math.max(-d.bounds.top, Math.min(h - d.bounds.bottom, dy));
    setOffset({ x: d.from.x + dx, y: d.from.y + dy });
  };

  const onPointerEnd = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    if (d.moved) {
      setOffset((o) => {
        saveOffset(slot, o);
        return o;
      });
      lastTap.current = 0;
      return;
    }
    const now = performance.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      setOffset(ZERO);
      saveOffset(slot, ZERO);
      lastTap.current = 0;
    } else {
      lastTap.current = now;
    }
  };

  return {
    offset,
    handlers: { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd },
  };
}

function Stick({ player, rotation, name }: { player: PlayerId; rotation: number; name: string }) {
  const base = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const [boosting, setBoosting] = useState(false);
  const pointerId = useRef<number | null>(null);

  const move = (e: ReactPointerEvent) => {
    const rect = base.current!.getBoundingClientRect();
    const radius = rect.width / 2;
    const sx = (e.clientX - (rect.left + radius)) / radius;
    const sy = (e.clientY - (rect.top + radius)) / radius;
    // A turned pad (facing layout) has its own "up": undo the CSS rotation to get pad-local axes.
    const a = (rotation * Math.PI) / 180;
    let x = sx * Math.cos(a) + sy * Math.sin(a);
    let y = -sx * Math.sin(a) + sy * Math.cos(a);
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    setKnob({ x, y });
    input.setTouch(player, {
      steer: Math.abs(x) < DEAD_ZONE ? 0 : x,
      throttle: Math.abs(y) < DEAD_ZONE ? 0 : -y,
    });
    // Forward is -y in pad-local axes.
    const boost = len >= BOOST_REACH && Math.abs(Math.atan2(x, -y)) <= BOOST_ARC;
    setBoosting(boost);
    input.setTouch(player, { boost });
  };

  const release = (e: ReactPointerEvent) => {
    if (e.pointerId !== pointerId.current) return;
    pointerId.current = null;
    setKnob({ x: 0, y: 0 });
    setBoosting(false);
    input.setTouch(player, { steer: 0, throttle: 0, boost: false });
  };

  return (
    <div
      ref={base}
      className={`stick ${boosting ? 'is-boosting' : ''}`}
      role="application"
      aria-label={`${name} 走行スティック`}
      onPointerDown={(e) => {
        if (pointerId.current !== null) return;
        pointerId.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e);
      }}
      onPointerMove={(e) => {
        if (e.pointerId === pointerId.current) move(e);
      }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <div className="stick-knob" style={{ transform: `translate(${knob.x * 62}%, ${knob.y * 62}%)` }} />
    </div>
  );
}

/* Propo (RC transmitter) style -------------------------------------------- */

const PROPO_DEAD_ZONE = 0.06;
/** Pushing the throttle this far past full (in travels) also fires the boost. */
const BOOST_AT = 1.3;
const THROTTLE_VISUAL_MAX = 1.5;

/** Thumb travel for full deflection, in CSS px; scales with the screen but stays thumb-sized. */
function propoTravel() {
  const vmin = Math.min(window.innerWidth, window.innerHeight);
  return Math.max(56, Math.min(110, vmin * 0.13));
}

function shape(v: number) {
  const a = Math.abs(v);
  if (a < PROPO_DEAD_ZONE) return 0;
  const n = Math.min(1, (a - PROPO_DEAD_ZONE) / (1 - PROPO_DEAD_ZONE));
  // A little expo: fine control around centre, full lock still at the end of the travel.
  return Math.sign(v) * (0.7 * n + 0.3 * n * n * n);
}

type AxisState = { active: boolean; x: number; y: number; v: number };

/**
 * A floating one-axis control: wherever the thumb lands becomes neutral, and the
 * drag along the axis sets the value. It springs back to neutral on release.
 */
function PropoAxis({
  player,
  axis,
  rotation,
  name,
}: {
  player: PlayerId;
  axis: 'steer' | 'throttle';
  rotation: 0 | 90 | -90;
  name: string;
}) {
  const zone = useRef<HTMLDivElement>(null);
  const pointerId = useRef<number | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const [st, setSt] = useState<AxisState>({ active: false, x: 0, y: 0, v: 0 });
  const travel = useRef(propoTravel());

  /**
   * Pointer position in the zone's own (possibly rotated) frame. The bounding rect is the
   * turned box on screen: at 90deg the zone's x runs down the screen and its y runs right to left.
   */
  const local = (e: ReactPointerEvent) => {
    const r = zone.current!.getBoundingClientRect();
    if (rotation === 90) return { x: e.clientY - r.top, y: r.right - e.clientX };
    if (rotation === -90) return { x: r.bottom - e.clientY, y: e.clientX - r.left };
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const update = (e: ReactPointerEvent) => {
    const p = local(e);
    const t = travel.current;
    if (axis === 'steer') {
      const raw = Math.max(-1, Math.min(1, (p.x - origin.current.x) / t));
      setSt({ active: true, x: origin.current.x, y: origin.current.y, v: raw });
      input.setTouch(player, { steer: shape(raw) });
    } else {
      const raw = Math.max(-1, Math.min(THROTTLE_VISUAL_MAX, (origin.current.y - p.y) / t));
      setSt({ active: true, x: origin.current.x, y: origin.current.y, v: raw });
      input.setTouch(player, { throttle: shape(Math.min(1, raw)), boost: raw >= BOOST_AT });
    }
  };

  const release = (e: ReactPointerEvent) => {
    if (e.pointerId !== pointerId.current) return;
    pointerId.current = null;
    setSt((s) => ({ ...s, active: false, v: 0 }));
    input.setTouch(player, axis === 'steer' ? { steer: 0 } : { throttle: 0, boost: false });
  };

  const label = `${name} ${axis === 'steer' ? 'ハンドル' : 'アクセル・バック'}`;
  const v = st.v;
  const style = {
    '--travel': `${travel.current}px`,
    ...(st.active ? { '--ox': `${st.x}px`, '--oy': `${st.y}px` } : {}),
  } as CSSProperties;

  return (
    <div
      ref={zone}
      className={`propo-zone propo-${axis} ${st.active ? 'is-active' : ''} ${v >= BOOST_AT ? 'is-boost' : ''}`}
      style={style}
      role="application"
      aria-label={label}
      onPointerDown={(e) => {
        if (pointerId.current !== null) return;
        pointerId.current = e.pointerId;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // The pointer may already be gone; the move/up handlers still filter by id.
        }
        travel.current = propoTravel();
        origin.current = local(e);
        update(e);
      }}
      onPointerMove={(e) => {
        if (e.pointerId === pointerId.current) update(e);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="propo-gauge">
        {axis === 'steer' ? (
          <>
            <div className="propo-track" />
            <div className="propo-fill" style={{ '--v': v } as CSSProperties} />
            <div className="propo-knob" style={{ transform: `translate(calc(-50% + ${v} * var(--travel)), -50%)` }}>
              <svg viewBox="-20 -20 40 40" aria-hidden="true" style={{ transform: `rotate(${v * 120}deg)` }}>
                <circle r="16" fill="none" stroke="currentColor" strokeWidth="4" />
                <circle r="4" fill="currentColor" />
                <path d="M-15 -2 L-4 -1 M4 -1 L15 -2 M0 4 L0 15" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
              </svg>
            </div>
            <span className="propo-hint propo-hint-l">◀</span>
            <span className="propo-hint propo-hint-r">▶</span>
          </>
        ) : (
          <>
            <div className="propo-track" />
            <div className="propo-boost-band" />
            <div className="propo-fill" style={{ '--v': Math.min(v, 1) } as CSSProperties} />
            <div
              className="propo-knob"
              style={{ transform: `translate(-50%, calc(-50% - ${Math.min(v, THROTTLE_VISUAL_MAX)} * var(--travel)))` }}
            />
            <span className="propo-hint propo-hint-up">▲</span>
            <span className="propo-hint propo-hint-down">▼</span>
          </>
        )}
      </div>
      {!st.active && <span className="propo-caption">{axis === 'steer' ? 'ハンドル' : 'アクセル / バック'}</span>}
    </div>
  );
}

function PropoPad({ player, car, facing }: { player: PlayerId; car: PlayerId; facing: boolean }) {
  const name = useGame((s) => playerName(s, car));
  // Facing, players sit at the left and right edges: each propo is turned toward its own edge.
  const rotation = facing ? (player === 'p1' ? 90 : -90) : 0;
  return (
    <div className={`propo propo-${player} propo-color-${car} ${facing ? 'propo-facing' : ''}`}>
      <span className="pad-tag propo-tag" aria-hidden="true">
        {name}
      </span>
      <PropoAxis player={player} axis="steer" rotation={rotation} name={name} />
      <PropoAxis player={player} axis="throttle" rotation={rotation} name={name} />
    </div>
  );
}

/**
 * `player` is the input slot the pad writes to; `car` is the car it drives, which sets its color
 * and name. They differ online, where every browser writes to slot 1P whatever its seat.
 * `facing` puts the stick pads on the left and right edges, each turned toward a player sitting on that side.
 */
function StickPad({ player, car, facing }: { player: PlayerId; car: PlayerId; facing: boolean }) {
  const name = useGame((s) => playerName(s, car));
  const padRef = useRef<HTMLDivElement>(null);
  const { offset, handlers } = usePadDrag(`${player}-${facing ? 'facing' : 'side'}`, padRef);
  useEffect(
    () => () => input.setTouch(player, { throttle: 0, steer: 0, boost: false }),
    [player],
  );
  const rotation = facing ? (player === 'p1' ? 90 : -90) : 0;
  return (
    <div
      ref={padRef}
      className={`pad pad-${player} pad-color-${car} ${facing ? 'pad-facing' : ''}`}
      style={{ translate: `${offset.x}px ${offset.y}px` }}
    >
      <span
        className="pad-tag"
        title="ドラッグで移動、ダブルタップで元の位置"
        aria-hidden="true"
        onContextMenu={(e) => e.preventDefault()}
        {...handlers}
      >
        {name}
      </span>
      <Stick player={player} rotation={rotation} name={name} />
    </div>
  );
}

export function TouchPads() {
  const mode = useGame((s) => s.mode);
  const layout = useGame((s) => s.touchLayout);
  const style1 = useGame((s) => s.touchStyle.p1);
  const style2 = useGame((s) => s.touchStyle.p2);
  const online = useGame((s) => s.online.status === 'on');
  const seat = useGame((s) => s.online.seat);
  const twoPads = mode === 'pvp' && !online;
  const facing = twoPads && layout === 'facing';
  // Each player picks their own controller.
  const Pad1 = style1 === 'propo' ? PropoPad : StickPad;
  const Pad2 = style2 === 'propo' ? PropoPad : StickPad;
  // Online every browser drives its own car through the 1P slot.
  return (
    <div className={`touch-layer ${twoPads ? 'is-two' : 'is-one'} layout-${layout}`}>
      <Pad1 player="p1" car={online ? (seat ?? 'p1') : 'p1'} facing={facing} />
      {twoPads && <Pad2 player="p2" car="p2" facing={facing} />}
    </div>
  );
}
