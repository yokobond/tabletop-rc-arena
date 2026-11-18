import { useEffect, useRef } from 'react';
import type { MadePart } from '../game/bodyParts';
import type { PlayerId } from '../game/types';
import { PartPreview } from '../aframe/partPreview';

interface Props {
  part: MadePart | null;
  player: PlayerId;
  /** Draw the shape it bumps with as red lines. */
  outline: boolean;
}

/** How far a drag of one pixel turns the part. */
const TURN = 0.012;
const KEY_TURN = Math.PI / 12;
const KEY_PAN = 24;
/** Two taps this close in time and place are a double tap. */
const DOUBLE_TAP_MS = 320;
const TAP_SLOP = 8;

/**
 * The part maker's picture of the part, in 3D. Drag to turn it; drag with the right button or
 * Shift, or with two fingers, to move it; scroll or pinch to zoom toward the pointer; double-click
 * (double-tap) a point of the part to turn and zoom around it. Arrow keys turn it (with Shift,
 * move it), + and − zoom, 0 goes back.
 */
export function PartView({ part, player, outline }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const preview = useRef<PartPreview | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const view = new PartPreview(canvas);
    preview.current = view;
    const resized = new ResizeObserver(() => view.resize());
    resized.observe(canvas);
    const local = (e: { clientX: number; clientY: number }) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    // A wheel over the picture zooms it rather than scrolling the panel: that needs a listener that is not passive.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const at = local(e);
      view.zoomBy(Math.exp(-e.deltaY * 0.0015), at.x, at.y);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    interface Touch {
      x: number;
      y: number;
      pan: boolean;
      startX: number;
      startY: number;
      at: number;
    }
    const pointers = new Map<number, Touch>();
    let lastTap = { at: 0, x: 0, y: 0 };
    const pair = () => {
      const [a, b] = [...pointers.values()];
      return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, spread: Math.hypot(a.x - b.x, a.y - b.y) };
    };
    const down = (e: PointerEvent) => {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // A pointer the browser does not know (made up by a script): it still turns the part.
      }
      const at = local(e);
      pointers.set(e.pointerId, { ...at, pan: e.button === 2 || e.shiftKey, startX: at.x, startY: at.y, at: performance.now() });
    };
    const move = (e: PointerEvent) => {
      const last = pointers.get(e.pointerId);
      if (!last) return;
      const at = local(e);
      if (pointers.size === 1) {
        if (last.pan) view.pan(at.x - last.x, at.y - last.y);
        else view.orbit(-(at.x - last.x) * TURN, (at.y - last.y) * TURN);
        pointers.set(e.pointerId, { ...last, ...at });
        return;
      }
      // Two fingers: the middle between them moves the part, their spread zooms toward it.
      const before = pair();
      pointers.set(e.pointerId, { ...last, ...at });
      const after = pair();
      view.pan(after.mid.x - before.mid.x, after.mid.y - before.mid.y);
      if (before.spread > 0) view.zoomBy(after.spread / before.spread, after.mid.x, after.mid.y);
    };
    const up = (e: PointerEvent) => {
      const last = pointers.get(e.pointerId);
      pointers.delete(e.pointerId);
      if (!last || pointers.size > 0) return;
      // A tap that did not move: two of them, close together, put the middle there.
      const now = performance.now();
      const still = Math.hypot(last.x - last.startX, last.y - last.startY) < TAP_SLOP && now - last.at < DOUBLE_TAP_MS;
      if (!still) return;
      if (now - lastTap.at < DOUBLE_TAP_MS && Math.hypot(last.x - lastTap.x, last.y - lastTap.y) < TAP_SLOP * 3) {
        view.focusAt(last.x, last.y);
        lastTap = { at: 0, x: 0, y: 0 };
      } else {
        lastTap = { at: now, x: last.x, y: last.y };
      }
    };
    const cancel = (e: PointerEvent) => pointers.delete(e.pointerId);
    const noMenu = (e: Event) => e.preventDefault();
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', cancel);
    canvas.addEventListener('contextmenu', noMenu);
    return () => {
      resized.disconnect();
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('contextmenu', noMenu);
      view.dispose();
      preview.current = null;
    };
  }, []);

  useEffect(() => {
    preview.current?.setPart(part ? { kind: 'made', made: part } : null, player, outline);
  }, [part, player, outline]);

  const onKey = (e: React.KeyboardEvent) => {
    const view = preview.current;
    if (!view) return;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const arrow = arrows[e.key];
    if (arrow) {
      e.preventDefault();
      if (e.shiftKey) view.pan(arrow[0] * KEY_PAN, arrow[1] * KEY_PAN);
      else view.orbit(-arrow[0] * KEY_TURN, -arrow[1] * KEY_TURN);
      return;
    }
    const keys: Record<string, () => void> = {
      '+': () => view.zoomBy(1.25),
      '=': () => view.zoomBy(1.25),
      '-': () => view.zoomBy(0.8),
      '0': () => view.reset(),
    };
    const act = keys[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  };

  return (
    <div className="pm-view">
      <canvas
        ref={canvasRef}
        className="pm-view-canvas"
        tabIndex={0}
        role="img"
        aria-label={`${part?.name ?? '部品'}の3Dのすがた。矢印キーで回し、Shiftと矢印キーで動かし、プラスとマイナスでズームできます`}
        onKeyDown={onKey}
      />
      <div className="pm-view-tools">
        <button type="button" aria-label="ちかづける" title="ちかづける" onClick={() => preview.current?.zoomBy(1.25)}>
          ＋
        </button>
        <button type="button" aria-label="はなす" title="はなす" onClick={() => preview.current?.zoomBy(0.8)}>
          −
        </button>
        <button type="button" aria-label="むきと まんなかを もどす" title="むきと まんなかを もどす" onClick={() => preview.current?.reset()}>
          ↺
        </button>
      </div>
    </div>
  );
}
