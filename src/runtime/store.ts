import { useSyncExternalStore } from 'react';
import { GameEngine } from '../game/engine';
import { CpuController } from '../game/ai';
import type {
  CameraPreset,
  CarStatus,
  CpuDifficulty,
  GameMode,
  MatchPhase,
  PlayerId,
  StagePreset,
} from '../game/types';
import { currentModel, currentView, isOnline, leaveOnline, connectOnline, onlineHooks, sessionUrl } from '../net/session';
import { audio } from './audio';
import { input } from './input';

export const TOP_SPEED_KMH_SCALE = 34;

export interface CarTelemetry {
  speed: number;
  boost: number;
  boosting: boolean;
  status: CarStatus;
  invulnerable: boolean;
  respawnIn: number;
}

export interface OnlineState {
  status: 'off' | 'connecting' | 'on' | 'error';
  url: string;
  /** This browser's car, or null while watching. */
  seat: PlayerId | null;
  /** Which cars a person drives (the others are CPU). */
  humans: Record<PlayerId, boolean>;
  viewers: number;
  synced: boolean;
  error: string | null;
}

export interface GameState {
  mode: GameMode;
  cpuDifficulty: CpuDifficulty;
  stagePreset: StagePreset;
  /** 0 is free practice. */
  targetScore: number;
  cameraPreset: CameraPreset;
  /** -1..1, added to the preset's elevation. */
  cameraHeight: number;
  /** Degrees around the table, added to the preset's azimuth. */
  cameraAngle: number;
  sound: boolean;
  touchControls: boolean;
  touchLayout: 'side' | 'facing';
  /** `propo`: left thumb steers, right thumb throttles (RC transmitter style). `stick`: one joystick. */
  touchStyle: 'propo' | 'stick';
  vrSupported: boolean;
  vrActive: boolean;
  vrError: string | null;
  phase: MatchPhase;
  paused: boolean;
  countdown: number;
  scores: Record<PlayerId, number>;
  winner: PlayerId | null;
  carTelemetry: Record<PlayerId, CarTelemetry>;
  banner: { id: number; player: PlayerId; scoredBy: PlayerId | null } | null;
  showGo: boolean;
  online: OnlineState;
}

function detectTouch() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

const initialTelemetry = (): CarTelemetry => ({
  speed: 0,
  boost: 100,
  boosting: false,
  status: 'driving',
  invulnerable: false,
  respawnIn: 0,
});

/** The local engine; created once Rapier has loaded (`initStore`). */
let localEngine: GameEngine | null = null;

/** The engine on screen: the replicated model's while online, the local one otherwise. */
export function getEngine(): GameEngine {
  const model = isOnline() ? currentModel() : null;
  if (model) return model.engine;
  localEngine ??= new GameEngine();
  return localEngine;
}

/** Call after `initPhysics()`. */
export function initStore() {
  getEngine().loadStage(state.stagePreset);
}

const offlineState = (): OnlineState => ({
  status: 'off',
  url: '',
  seat: null,
  humans: { p1: false, p2: false },
  viewers: 0,
  synced: false,
  error: null,
});

let state: GameState = {
  mode: 'cpu',
  cpuDifficulty: 'normal',
  stagePreset: 'standard',
  targetScore: 3,
  cameraPreset: 'angled',
  cameraHeight: 0,
  cameraAngle: 0,
  sound: true,
  touchControls: detectTouch(),
  touchLayout: 'side',
  touchStyle: 'propo',
  vrSupported: false,
  vrActive: false,
  vrError: null,
  phase: 'idle',
  paused: false,
  countdown: 0,
  scores: { p1: 0, p2: 0 },
  winner: null,
  carTelemetry: { p1: initialTelemetry(), p2: initialTelemetry() },
  banner: null,
  showGo: false,
  online: offlineState(),
};

const listeners = new Set<() => void>();

function emit(patch: Partial<GameState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export const getState = () => state;

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useGame<T>(selector: (s: GameState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

let cpu: CpuController | null = null;
export const getCpu = () => cpu;

const RUNNING: MatchPhase[] = ['countdown', 'playing', 'finishing'];
const isRunning = () => RUNNING.includes(state.phase) && !state.paused;

input.captureKeys = isRunning;
input.onPauseKey = () => togglePause();

export function startMatch() {
  audio.unlock();
  input.clearKeys();
  (document.activeElement as HTMLElement | null)?.blur?.();
  if (isOnline()) {
    currentView()?.sendStart();
    emit({ banner: null, showGo: false });
    return;
  }
  const engine = getEngine();
  cpu = state.mode === 'cpu' ? new CpuController(state.cpuDifficulty, 'p2') : null;
  engine.startMatch({ stage: state.stagePreset, targetScore: state.targetScore });
  emit({
    phase: engine.phase,
    paused: false,
    countdown: engine.countdown,
    scores: { p1: 0, p2: 0 },
    winner: null,
    banner: null,
    showGo: false,
    carTelemetry: { p1: initialTelemetry(), p2: initialTelemetry() },
  });
}

export function backToTitle() {
  audio.silenceEngines();
  if (isOnline()) {
    currentView()?.sendTitle();
    emit({ banner: null, showGo: false });
    return;
  }
  cpu = null;
  getEngine().loadStage(state.stagePreset);
  emit({ phase: 'idle', paused: false, winner: null, banner: null, showGo: false, scores: { p1: 0, p2: 0 } });
}

export function togglePause() {
  if (!RUNNING.includes(state.phase)) return;
  input.clearKeys();
  if (isOnline()) {
    currentView()?.sendPause();
    return;
  }
  if (!state.paused) audio.silenceEngines();
  emit({ paused: !state.paused });
}

export function pauseIfRunning() {
  if (isRunning()) togglePause();
}

/** Rule changes restart a running match; view settings just apply. */
export function updateSettings(patch: Partial<GameState>) {
  emit(patch);
  if ('sound' in patch) audio.setMuted(!state.sound);
  const rulesChanged = ['mode', 'cpuDifficulty', 'stagePreset', 'targetScore'].some((k) => k in patch);
  if (!rulesChanged) return;
  if (isOnline()) {
    // Shared rules belong to the model; the view only asks for a change.
    const { stagePreset, targetScore, cpuDifficulty } = patch;
    currentView()?.sendRules({ stagePreset, targetScore, cpuDifficulty });
    return;
  }
  if (state.phase === 'idle') getEngine().loadStage(state.stagePreset);
  else startMatch();
}

export function setCameraPreset(cameraPreset: CameraPreset) {
  emit({ cameraPreset, cameraHeight: 0, cameraAngle: 0 });
}

/** Pushes the simulation state to React; called at a modest rate by the scene manager. */
export function publishTelemetry() {
  const engine = getEngine();
  const telemetry = (id: PlayerId): CarTelemetry => {
    const car = engine.cars[id];
    return {
      speed: Math.hypot(car.vx, car.vz),
      boost: car.boost,
      boosting: car.boosting,
      status: car.status,
      invulnerable: car.invulnerable > 0,
      respawnIn: car.respawnIn,
    };
  };
  emit({
    phase: engine.phase,
    countdown: engine.countdown,
    scores: { ...engine.scores },
    winner: engine.winner,
    carTelemetry: { p1: telemetry('p1'), p2: telemetry('p2') },
    ...onlinePatch(),
  });
}

/** While online, the shared parts of the state come from the model. */
function onlinePatch(): Partial<GameState> {
  if (!isOnline()) return {};
  const view = currentView();
  const model = currentModel();
  if (!view || !model) return { online: { ...state.online, status: 'connecting' } };
  return {
    paused: model.paused,
    stagePreset: model.engine.stageId,
    targetScore: model.rules.targetScore,
    cpuDifficulty: model.rules.cpuDifficulty,
    online: {
      status: 'on',
      url: sessionUrl(),
      seat: view.seat,
      humans: { p1: model.seats.p1 !== null, p2: model.seats.p2 !== null },
      viewers: model.viewers.length,
      synced: view.synced,
      error: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Online play (Croquet). The reflector orders events; every browser runs the model.
// ---------------------------------------------------------------------------
onlineHooks.changed = () => {
  if (!isOnline()) {
    if (state.online.status === 'on') emit({ online: offlineState() });
    return;
  }
  publishTelemetry();
};

export function goOnline() {
  if (state.online.status === 'connecting' || state.online.status === 'on') return;
  audio.unlock();
  audio.silenceEngines();
  cpu = null;
  emit({ online: { ...offlineState(), status: 'connecting' }, banner: null, showGo: false });
  connectOnline()
    .then(() => publishTelemetry())
    .catch((err: unknown) => {
      console.error(err);
      emit({ online: { ...offlineState(), status: 'error', error: 'リフレクタに接続できませんでした。ネットワークを確認してください。' } });
    });
}

export function goOffline() {
  audio.silenceEngines();
  void leaveOnline().finally(() => {
    cpu = null;
    getEngine().loadStage(state.stagePreset);
    emit({ online: offlineState(), phase: 'idle', paused: false, winner: null, banner: null, showGo: false, scores: { p1: 0, p2: 0 } });
  });
}

/** Display name of a car: 1P / 2P / CPU, plus YOU for this browser's car online. */
export function playerName(s: GameState, id: PlayerId) {
  if (s.online.status === 'on') {
    if (s.online.seat === id) return 'YOU';
    if (!s.online.humans[id]) return 'CPU';
    return id === 'p1' ? '1P' : '2P';
  }
  return id === 'p1' ? '1P' : s.mode === 'cpu' ? 'CPU' : '2P';
}

// VR: the session itself lives in the scene, which registers these on load.
let vrHandlers: { enter: () => Promise<unknown>; exit: () => Promise<unknown> } | null = null;
export function setVrHandlers(handlers: typeof vrHandlers) {
  vrHandlers = handlers;
}

/** Call from a click: browsers only open an immersive session on a user gesture. */
export function enterVr(startAfter: boolean) {
  audio.unlock();
  emit({ vrError: null });
  vrHandlers
    ?.enter()
    .then(() => {
      if (startAfter) startMatch();
    })
    .catch(() => emit({ vrError: 'VRを開始できませんでした。ヘッドセットの接続とブラウザの許可を確認してください。' }));
}

function exitVrToTitle() {
  void vrHandlers?.exit().catch(() => {});
  backToTitle();
}

/** A / X button. */
export function vrPrimaryAction() {
  if (state.paused) togglePause();
  else if (state.phase === 'finished') startMatch();
}

/** B / Y button. */
export function vrSecondaryAction() {
  if (state.paused || state.phase === 'finished') exitVrToTitle();
  else if (RUNNING.includes(state.phase)) togglePause();
}

let bannerId = 0;
let bannerTimer: ReturnType<typeof setTimeout> | undefined;
export function showFallBanner(player: PlayerId, scoredBy: PlayerId | null) {
  const id = ++bannerId;
  clearTimeout(bannerTimer);
  emit({ banner: { id, player, scoredBy }, scores: { ...getEngine().scores } });
  bannerTimer = setTimeout(() => emit({ banner: null }), 1900);
}

let goTimer: ReturnType<typeof setTimeout> | undefined;
export function showGoFlash() {
  clearTimeout(goTimer);
  emit({ showGo: true });
  goTimer = setTimeout(() => emit({ showGo: false }), 750);
}
