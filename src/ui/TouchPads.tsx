import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
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

function Pad({ player, facing }: { player: PlayerId; facing: boolean }) {
  useEffect(
    () => () => input.setTouch(player, { throttle: 0, steer: 0, boost: false }),
    [player],
  );
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
  const online = useGame((s) => s.online.status === 'on');
  // Online every browser drives one car with the 1P pad.
  return (
    <div className="touch-layer">
      <Pad player="p1" facing={false} />
      {mode === 'pvp' && !online && <Pad player="p2" facing={layout === 'facing'} />}
    </div>
  );
}
