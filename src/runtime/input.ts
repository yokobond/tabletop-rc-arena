import type { CarInput, PlayerId } from '../game/types';

const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space',
  'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Enter', 'ShiftLeft', 'ShiftRight',
]);

const P1 = { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', boost: ['Space'] };
const P2 = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', boost: ['Enter', 'ShiftLeft', 'ShiftRight'] };

type Binding = typeof P1;

/** Merges the keyboard and the on-screen pads into per-player inputs. */
class InputManager {
  private keys = new Set<string>();
  private touch: Record<PlayerId, CarInput> = {
    p1: { throttle: 0, steer: 0, boost: false },
    p2: { throttle: 0, steer: 0, boost: false },
  };
  private xr: CarInput = { throttle: 0, steer: 0, boost: false };
  /** Game keys only belong to the match while one is running; menus keep normal keyboard behaviour. */
  captureKeys: () => boolean = () => false;
  onPauseKey: () => void = () => {};

  attach(target: Window) {
    target.addEventListener('keydown', this.handleDown);
    target.addEventListener('keyup', this.handleUp);
    target.addEventListener('blur', this.clearKeys);
  }

  private handleDown = (e: KeyboardEvent) => {
    if (e.code === 'Escape' || e.code === 'KeyP') {
      if (!e.repeat) this.onPauseKey();
      return;
    }
    if (!GAME_KEYS.has(e.code) || !this.captureKeys()) return;
    e.preventDefault();
    this.keys.add(e.code);
  };

  private handleUp = (e: KeyboardEvent) => {
    if (!GAME_KEYS.has(e.code)) return;
    // Even when released after the match started, stop a focused button from activating.
    if (this.captureKeys()) e.preventDefault();
    this.keys.delete(e.code);
  };

  clearKeys = () => {
    this.keys.clear();
  };

  setTouch(player: PlayerId, partial: Partial<CarInput>) {
    Object.assign(this.touch[player], partial);
  }

  /** VR controllers drive 1P; whoever wears the headset is always player one. */
  setXr(partial: Partial<CarInput>) {
    Object.assign(this.xr, partial);
  }

  private readKeys(b: Binding) {
    return {
      throttle: (this.keys.has(b.up) ? 1 : 0) - (this.keys.has(b.down) ? 1 : 0),
      steer: (this.keys.has(b.right) ? 1 : 0) - (this.keys.has(b.left) ? 1 : 0),
      boost: b.boost.some((k) => this.keys.has(k)),
    };
  }

  /** With `shared` (CPU matches) the 2P keys drive 1P too, so either side of the keyboard works. */
  read(player: PlayerId, shared = false): CarInput {
    const keys = player === 'p1' ? this.readKeys(P1) : this.readKeys(P2);
    const extra = shared ? this.readKeys(P2) : { throttle: 0, steer: 0, boost: false };
    const touch = this.touch[player];
    const xr = player === 'p1' ? this.xr : { throttle: 0, steer: 0, boost: false };
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    return {
      throttle: clamp(keys.throttle + extra.throttle + touch.throttle + xr.throttle),
      steer: clamp(keys.steer + extra.steer + touch.steer + xr.steer),
      boost: keys.boost || extra.boost || touch.boost || xr.boost,
    };
  }
}

export const input = new InputManager();
