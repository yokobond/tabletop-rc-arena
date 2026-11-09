import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { PlayerId } from '../game/types';
import { input } from '../runtime/input';
import { useGame } from '../runtime/store';

const DEAD_ZONE = 0.14;

function Stick({ player, flipped }: { player: PlayerId; flipped: boolean }) {
  const base = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const pointerId = useRef<number | null>(null);

  const move = (e: ReactPointerEvent) => {
    const rect = base.current!.getBoundingClientRect();
    const radius = rect.width / 2;
    let x = (e.clientX - (rect.left + radius)) / radius;
    let y = (e.clientY - (rect.top + radius)) / radius;
    // The facing layout turns the pad 180 degrees, so its "up" is the other way on screen.
    if (flipped) {
      x = -x;
      y = -y;
    }
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
  };

  const release = (e: ReactPointerEvent) => {
    if (e.pointerId !== pointerId.current) return;
    pointerId.current = null;
    setKnob({ x: 0, y: 0 });
    input.setTouch(player, { steer: 0, throttle: 0 });
  };

  return (
    <div
      ref={base}
      className="stick"
      role="application"
      aria-label={`${player === 'p1' ? '1P' : '2P'} 走行スティック`}
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

function BoostButton({ player }: { player: PlayerId }) {
  const [held, setHeld] = useState(false);
  const set = (on: boolean) => {
    setHeld(on);
    input.setTouch(player, { boost: on });
  };
  return (
    <button
      type="button"
      className={`boost-button ${held ? 'is-held' : ''}`}
      aria-label={`${player === 'p1' ? '1P' : '2P'} ブースト`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        set(true);
      }}
      onPointerUp={() => set(false)}
      onPointerCancel={() => set(false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      BOOST
    </button>
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
  flipped,
}: {
  player: PlayerId;
  axis: 'steer' | 'throttle';
  flipped: boolean;
}) {
  const zone = useRef<HTMLDivElement>(null);
  const pointerId = useRef<number | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const [st, setSt] = useState<AxisState>({ active: false, x: 0, y: 0, v: 0 });
  const travel = useRef(propoTravel());

  /** Pointer position in the zone's own (possibly rotated) frame. */
  const local = (e: ReactPointerEvent) => {
    const r = zone.current!.getBoundingClientRect();
    return flipped
      ? { x: r.right - e.clientX, y: r.bottom - e.clientY }
      : { x: e.clientX - r.left, y: e.clientY - r.top };
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

  const label = `${player === 'p1' ? '1P' : '2P'} ${axis === 'steer' ? 'ハンドル' : 'アクセル・バック'}`;
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

function PropoPad({ player, facing }: { player: PlayerId; facing: boolean }) {
  return (
    <div className={`propo propo-${player} ${facing ? 'propo-facing' : ''}`}>
      <PropoAxis player={player} axis="steer" flipped={facing} />
      <PropoAxis player={player} axis="throttle" flipped={facing} />
    </div>
  );
}

function Pad({ player, facing, propo }: { player: PlayerId; facing: boolean; propo: boolean }) {
  useEffect(
    () => () => input.setTouch(player, { throttle: 0, steer: 0, boost: false }),
    [player, propo],
  );
  if (propo) return <PropoPad player={player} facing={facing} />;
  return (
    <div className={`pad pad-${player} ${facing ? 'pad-facing' : ''}`}>
      {player === 'p1' ? (
        <>
          <Stick player={player} flipped={false} />
          <BoostButton player={player} />
        </>
      ) : (
        <>
          <BoostButton player={player} />
          <Stick player={player} flipped={facing} />
        </>
      )}
    </div>
  );
}

export function TouchPads() {
  const mode = useGame((s) => s.mode);
  const layout = useGame((s) => s.touchLayout);
  const style = useGame((s) => s.touchStyle);
  const online = useGame((s) => s.online.status === 'on');
  const propo = style === 'propo';
  const twoPads = mode === 'pvp' && !online;
  // Online every browser drives one car with the 1P pad.
  return (
    <div className={`touch-layer ${twoPads ? 'is-two' : 'is-one'} layout-${layout}`}>
      <Pad player="p1" facing={false} propo={propo} />
      {twoPads && <Pad player="p2" facing={layout === 'facing'} propo={propo} />}
    </div>
  );
}
