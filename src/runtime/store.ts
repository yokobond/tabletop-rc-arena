import { useSyncExternalStore } from 'react';
import { GameEngine } from '../game/engine';
import { CpuController } from '../game/ai';
import { ARENA_ITEMS, ROTATE_STEP, applyArenaEdit, findFreeSpot, type ArenaEdit, type ArenaItemType, type ArenaList } from '../game/arena';
import { asCustomStage, cleanArenaName, readArenaFile, writeArenaFile } from '../game/arenaFile';
import { STAGES } from '../game/stages';
import type {
  CameraPreset,
  CarStatus,
  CpuDifficulty,
  GameMode,
  MatchPhase,
  PlayerId,
  StageDefinition,
  StageId,
  TableArt,
  TableArtPreset,
} from '../game/types';
import { currentModel, currentView, isOnline, leaveOnline, connectOnline, onlineHooks, sessionUrl } from '../net/session';
import type { ArSize } from '../ar/marker';
import { arenaFileName, downloadText, readFileText } from './arenaFiles';
import { loadLibrary, loadSavedStage, pruneImages, removeFromLibrary, saveStage, saveToLibrary, type SavedArena } from './arenaStorage';
import { audio } from './audio';
import { input } from './input';
import { addLocalImage, artDataUrl, forgetSharedArt, importArtImage, prepareTableImage, saveArtLocally, shareArt } from './tableArt';

export const TOP_SPEED_KMH_SCALE = 34;

export interface CarTelemetry {
  speed: number;
  boost: number;
  boosting: boolean;
  status: CarStatus;
  invulnerable: boolean;
  respawnIn: number;
}

/** Who may change the arena. Offline that is simply the person at this device. */
export interface ArenaAccess {
  canEdit: boolean;
  /** This browser is the arena master, or stands in while the master is away. */
  isMaster: boolean;
  /** Everybody may edit, not only the master. */
  open: boolean;
  /** The master as the others know them: 1P / 2P / 観戦. */
  master: string;
  /** Participants the role can be handed to. */
  others: { viewId: string; label: string }[];
}

/** An arena saved on this device under a name, as the list shows it. */
export interface SavedArenaInfo {
  id: string;
  name: string;
  savedAt: number;
}

/** What saving or loading an arena last led to. */
export interface LibraryNote {
  ok: boolean;
  text: string;
}

/** What is picked up in the arena editor: an object by its id, or a start position by its player. */
export interface ArenaSelection {
  list: ArenaList | 'spawns';
  id: string;
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
  arena: ArenaAccess;
}

export type TouchStyle = 'propo' | 'stick';

export interface GameState {
  mode: GameMode;
  cpuDifficulty: CpuDifficulty;
  /** The arena on screen: the engine's stage, mirrored for React and the scene. */
  stage: StageDefinition;
  /** The arena editor is open (title screen only). */
  editing: boolean;
  editSelection: ArenaSelection | null;
  canUndo: boolean;
  /** A picture for the table is being prepared or uploaded. */
  artBusy: boolean;
  artError: string | null;
  /** Arenas saved on this device under a name, newest first. */
  savedArenas: SavedArenaInfo[];
  libraryNote: LibraryNote | null;
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
  /**
   * Touch controller per input slot. `propo`: left thumb steers, right thumb throttles
   * (RC transmitter style). `stick`: one joystick. Online and in CPU matches only 1P's is used.
   */
  touchStyle: Record<PlayerId, TouchStyle>;
  vrSupported: boolean;
  vrActive: boolean;
  vrError: string | null;
  /** AR: the camera picture behind the scene, with the arena on a printed marker. A view setting of this device. */
  arSupported: boolean;
  arActive: boolean;
  /** False until the marker is found, and again once it has been out of sight for a moment. */
  arTracking: boolean;
  arError: string | null;
  /** The table's width in marker widths. */
  arSize: ArSize;
  phase: MatchPhase;
  paused: boolean;
  /** The in-match settings panel is open; a local match waits until it closes. */
  settingsOpen: boolean;
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
  emit({ stage: getEngine().stage, savedArenas: loadLibrary().map(arenaInfo) });
}

const arenaInfo = ({ id, name, savedAt }: SavedArena): SavedArenaInfo => ({ id, name, savedAt });

const offlineState = (): OnlineState => ({
  status: 'off',
  url: '',
  seat: null,
  humans: { p1: false, p2: false },
  viewers: 0,
  synced: false,
  error: null,
  arena: { canEdit: true, isMaster: true, open: false, master: '', others: [] },
});

let state: GameState = {
  mode: 'cpu',
  cpuDifficulty: 'normal',
  stage: STAGES.standard,
  editing: false,
  editSelection: null,
  canUndo: false,
  artBusy: false,
  artError: null,
  savedArenas: [],
  libraryNote: null,
  targetScore: 3,
  cameraPreset: 'angled',
  cameraHeight: 0,
  cameraAngle: 0,
  sound: true,
  touchControls: detectTouch(),
  touchLayout: 'side',
  touchStyle: { p1: 'propo', p2: 'propo' },
  vrSupported: false,
  vrActive: false,
  vrError: null,
  arSupported: false,
  arActive: false,
  arTracking: false,
  arError: null,
  arSize: 6,
  phase: 'idle',
  paused: false,
  settingsOpen: false,
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
/**
 * A local match stands still while the settings panel is open. An online match keeps going:
 * it is shared, and one player's settings should not stop everyone else.
 */
export const heldForSettings = (s: GameState = state) => s.settingsOpen && !isOnline();
const isRunning = () => RUNNING.includes(state.phase) && !state.paused && !heldForSettings();

input.captureKeys = isRunning;
input.onPauseKey = () => togglePause();

export function startMatch() {
  audio.unlock();
  input.clearKeys();
  (document.activeElement as HTMLElement | null)?.blur?.();
  if (isOnline()) {
    currentView()?.sendStart();
    emit({ banner: null, showGo: false, editing: false, editSelection: null });
    return;
  }
  const engine = getEngine();
  cpu = state.mode === 'cpu' ? new CpuController(state.cpuDifficulty, 'p2') : null;
  engine.startMatch({ targetScore: state.targetScore });
  emit({
    editing: false,
    editSelection: null,
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
  getEngine().loadStage();
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

export function setSettingsOpen(settingsOpen: boolean) {
  if (settingsOpen === state.settingsOpen) return;
  input.clearKeys();
  // Opening the panel from the pause dialog swaps one hold for the other, so closing the panel
  // resumes the match. A shared online pause stays; App just hides its dialog behind the panel.
  const leavePause = settingsOpen && state.paused && !isOnline();
  emit(leavePause ? { settingsOpen, paused: false } : { settingsOpen });
  if (heldForSettings()) audio.silenceEngines();
}

export function pauseIfRunning() {
  if (isRunning()) togglePause();
}

/** Rule changes restart a running match; view settings just apply. */
export function updateSettings(patch: Partial<GameState>) {
  emit(patch);
  if ('sound' in patch) audio.setMuted(!state.sound);
  const rulesChanged = ['mode', 'cpuDifficulty', 'targetScore'].some((k) => k in patch);
  if (!rulesChanged) return;
  if (isOnline()) {
    // Shared rules belong to the model; the view only asks for a change.
    const { targetScore, cpuDifficulty } = patch;
    currentView()?.sendRules({ targetScore, cpuDifficulty });
    return;
  }
  if (state.phase !== 'idle') startMatch();
}

// ---------------------------------------------------------------------------
// The arena: which stage is on the table, and editing it.
// ---------------------------------------------------------------------------
/** May this browser change the arena right now? */
export const canEditArena = (s: GameState = state) => s.online.status !== 'connecting' && s.online.arena.canEdit;

/** Stages before each edit made here, newest last, for "undo". */
const history: StageDefinition[] = [];
const HISTORY_LIMIT = 20;

function clearHistory() {
  history.length = 0;
}

/**
 * Makes one change to the arena: applied here when offline, sent to the model when online
 * (after the same check the model will make). Returns the stage it leads to, or null when the
 * rules refuse it. Only loading a whole arena is possible during a match, and restarts it.
 */
export function applyEdit(edit: ArenaEdit, options: { record?: boolean } = {}): StageDefinition | null {
  const engine = getEngine();
  const before = engine.stage;
  const running = engine.phase !== 'idle';
  if (running && edit.op !== 'load') return null;
  const next = applyArenaEdit(before, edit);
  if (!next) return null;
  if (isOnline()) {
    const view = currentView();
    if (!view || !canEditArena()) return null;
    view.sendArenaEdit(edit);
  } else {
    engine.loadStage(next);
    emit({ stage: next });
    if (running) startMatch();
  }
  if (options.record !== false) {
    history.push(before);
    if (history.length > HISTORY_LIMIT) history.shift();
  }
  emit({ canUndo: history.length > 0 });
  // The custom arena made on this device is kept, so it can be chosen again later, in any session.
  if (next.id === 'custom') {
    saveStage(next);
    void saveArtLocally(next.art).then(forgetUnusedImages);
  }
  return next;
}

/** Pictures are kept only for the arenas this device still has: the one on the table, the custom one, the library. */
function forgetUnusedImages() {
  const keep = new Set<string>();
  for (const stage of [getEngine().stage, loadSavedStage(), ...loadLibrary().map((a) => a.stage)]) {
    if (stage?.art.kind === 'image') keep.add(stage.art.src);
  }
  return pruneImages(keep);
}

/** Loads a whole arena. Online, its picture has to be where the others can fetch it first. */
async function loadWholeStage(stage: StageDefinition, record = true) {
  emit({ editSelection: null });
  if (stage.id !== 'custom') return applyEdit({ op: 'load', stage: stage.id }, { record });
  let art = stage.art;
  if (isOnline() && art.kind === 'image') {
    emit({ artBusy: true, artError: null });
    try {
      art = await shareArt(art);
    } catch (err) {
      console.error(err);
      art = { kind: 'preset', id: 'dohyo' };
      emit({ artError: 'テーブルの画像を共有できなかったので、土俵の絵にしました。' });
    }
    emit({ artBusy: false });
  }
  return applyEdit({ op: 'load', stage: { ...stage, art } }, { record });
}

/** A preset, or `custom`: the arena saved on this device (the one on the table if none is saved yet). */
export function chooseStage(id: StageId) {
  if (id !== 'custom') {
    void loadWholeStage(STAGES[id]);
    return;
  }
  const current = getEngine().stage;
  void loadWholeStage(loadSavedStage() ?? { ...current, id: 'custom' });
}

export function setEditing(editing: boolean) {
  if (editing && (state.phase !== 'idle' || !canEditArena())) return;
  emit({ editing, editSelection: null, artError: null, libraryNote: null });
}

// ---------------------------------------------------------------------------
// Saving and loading arenas: under a name on this device, or as a file.
// ---------------------------------------------------------------------------
const libraryNote = (ok: boolean, text: string) => emit({ libraryNote: { ok, text } });

/** Saves the arena on the table under a name; an arena that already has the name is replaced. */
export async function saveArenaAs(rawName: string) {
  const name = cleanArenaName(rawName);
  if (!name) return libraryNote(false, '名前を入れてください。');
  const stage = asCustomStage(getEngine().stage);
  if (!stage) return libraryNote(false, 'このアリーナは保存できません。');
  const pictureKept = await saveArtLocally(stage.art);
  const list = saveToLibrary(name, stage);
  if (!list) {
    return libraryNote(false, '保存できませんでした。保存できるのは 30 件までです。古いアリーナを削除するか、端末の空きを確認してください。');
  }
  emit({ savedArenas: list.map(arenaInfo) });
  libraryNote(pictureKept, pictureKept ? `「${name}」を保存しました。` : `「${name}」を保存しましたが、テーブルの画像は端末に保存できませんでした。`);
  void forgetUnusedImages();
}

/** Puts a saved arena on the table. Online that needs the right to edit, like any other change. */
export async function loadSavedArena(id: string) {
  const saved = loadLibrary().find((a) => a.id === id);
  if (!saved) return libraryNote(false, 'このアリーナは見つかりません。');
  const next = await loadWholeStage(saved.stage);
  libraryNote(next !== null, next ? `「${saved.name}」を読み込みました。` : '読み込めませんでした。');
}

export function deleteSavedArena(id: string) {
  const name = state.savedArenas.find((a) => a.id === id)?.name;
  emit({ savedArenas: removeFromLibrary(id).map(arenaInfo) });
  if (name) libraryNote(true, `「${name}」を削除しました。`);
  void forgetUnusedImages();
}

/** Hands the arena on the table to the person as a file, picture included. */
export async function exportArena(rawName: string) {
  const stage = asCustomStage(getEngine().stage);
  if (!stage) return libraryNote(false, 'このアリーナは書き出せません。');
  const name = cleanArenaName(rawName) || 'アリーナ';
  const image = await artDataUrl(stage.art);
  const pictureLost = stage.art.kind === 'image' && !image;
  // Without its picture the file names a design every device has.
  const written: StageDefinition = pictureLost ? { ...stage, art: { kind: 'preset', id: 'dohyo' } } : stage;
  downloadText(arenaFileName(name), writeArenaFile(name, written, image));
  libraryNote(!pictureLost, pictureLost ? 'ファイルに書き出しましたが、テーブルの画像は入れられませんでした。' : 'ファイルに書き出しました。');
}

/** Puts the arena of a file on the table. Returns the name the file gives it, or null when it was not loaded. */
export async function importArena(file: Blob): Promise<string | null> {
  emit({ artBusy: true, artError: null, libraryNote: null });
  try {
    const text = await readFileText(file);
    const content = text === null ? null : readArenaFile(text);
    if (!content) {
      libraryNote(false, 'アリーナのファイルではないので、読み込めませんでした。');
      return null;
    }
    let stage = content.stage;
    let pictureLost = false;
    if (content.image) {
      try {
        stage = { ...stage, art: await importArtImage(content.image) };
      } catch (err) {
        console.error(err);
        pictureLost = true;
      }
    }
    const next = await loadWholeStage(stage);
    if (!next) {
      libraryNote(false, '読み込めませんでした。');
      return null;
    }
    const shown = content.name ? `「${content.name}」` : 'アリーナ';
    libraryNote(!pictureLost, pictureLost ? `${shown}を読み込みましたが、テーブルの画像は使えませんでした。` : `${shown}を読み込みました。`);
    return content.name;
  } catch (err) {
    console.error(err);
    libraryNote(false, 'ファイルを読み込めませんでした。');
    return null;
  } finally {
    emit({ artBusy: false });
  }
}

export function selectArenaItem(editSelection: ArenaSelection | null) {
  const now = state.editSelection;
  if (now?.list === editSelection?.list && now?.id === editSelection?.id) return;
  emit({ editSelection });
}

/** Puts a new object from the palette on the nearest free spot and selects it. */
export function addArenaItem(item: ArenaItemType) {
  const edit = findFreeSpot(getEngine().stage, item);
  const next = edit && applyEdit(edit);
  if (!next) return;
  const list = ARENA_ITEMS.find((i) => i.type === item)!.list;
  const added = next[list][next[list].length - 1];
  emit({ editSelection: { list, id: added.id } });
}

/** The selected object with its pose, or null when a start position or nothing is selected. */
function selectedObject() {
  const sel = state.editSelection;
  const stage = getEngine().stage;
  if (sel?.list === 'obstacles') {
    const o = stage.obstacles.find((item) => item.id === sel.id);
    return o ? { id: o.id, x: o.x, z: o.z, rotation: o.rotation } : null;
  }
  if (sel?.list === 'props') {
    const p = stage.props.find((item) => item.id === sel.id);
    return p ? { id: p.id, x: p.x, z: p.z, rotation: p.angle } : null;
  }
  return null;
}

/** Turns the selected object by a number of steps (positive is counter-clockwise seen from above). */
export function rotateSelected(steps: number) {
  const item = selectedObject();
  return item ? applyEdit({ op: 'move', id: item.id, x: item.x, z: item.z, rotation: item.rotation + steps * ROTATE_STEP }) !== null : false;
}

/** Makes the selected object larger (positive steps) or smaller, as far as the rules allow. */
export function resizeSelected(steps: number) {
  const item = selectedObject();
  return item ? applyEdit({ op: 'resize', id: item.id, steps }) !== null : false;
}

export function removeSelected() {
  const item = selectedObject();
  if (item && applyEdit({ op: 'remove', id: item.id })) emit({ editSelection: null });
}

export function undoArenaEdit() {
  const previous = history.pop();
  emit({ canUndo: history.length > 0 });
  if (previous) void loadWholeStage(previous, false);
}

export function setTableArtPreset(id: TableArtPreset) {
  emit({ artError: null });
  applyEdit({ op: 'art', art: { kind: 'preset', id } });
}

/** A picture from this device becomes the table top; online it is uploaded for the others first. */
export async function setTableImage(file: Blob) {
  emit({ artBusy: true, artError: null });
  try {
    const blob = await prepareTableImage(file);
    let art: TableArt = { kind: 'image', src: addLocalImage(blob) };
    if (isOnline()) art = await shareArt(art);
    if (!applyEdit({ op: 'art', art })) throw new Error('the picture was not accepted');
  } catch (err) {
    console.error(err);
    emit({ artError: isOnline() ? '画像を共有できませんでした。接続を確認して、もう一度選んでください。' : '画像を読み込めませんでした。別の画像を選んでください。' });
  }
  emit({ artBusy: false });
}

export function setArenaOpen(open: boolean) {
  currentView()?.sendArenaAccess({ open });
}

export function passArenaMaster(viewId: string) {
  currentView()?.sendArenaAccess({ master: viewId });
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
    stage: engine.stage,
    countdown: engine.countdown,
    scores: { ...engine.scores },
    winner: engine.winner,
    carTelemetry: { p1: telemetry('p1'), p2: telemetry('p2') },
    ...onlinePatch(),
  });
  // Someone else started the match, or the master took the editing back.
  if (state.editing && (state.phase !== 'idle' || !canEditArena())) emit({ editing: false, editSelection: null });
}

/** While online, the shared parts of the state come from the model. */
function onlinePatch(): Partial<GameState> {
  if (!isOnline()) return {};
  const view = currentView();
  const model = currentModel();
  if (!view || !model) return { online: { ...state.online, status: 'connecting' } };
  // Nobody has a name here; a participant is known by the car they drive.
  const label = (viewId: string) => {
    const seat = model.seatOf(viewId);
    if (seat) return seat === 'p1' ? '1P（赤）' : '2P（シアン）';
    const watching = model.viewers.filter((v) => !model.seatOf(v));
    return watching.length > 1 ? `観戦${watching.indexOf(viewId) + 1}` : '観戦';
  };
  const masterView = model.arenaMasterView();
  return {
    paused: model.paused,
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
      arena: {
        canEdit: model.canEditArena(view.viewId),
        isMaster: model.isArenaMaster(view.viewId),
        open: model.arenaOpen,
        master: masterView ? label(masterView) : '',
        others: model.viewers
          .filter((v) => v !== view.viewId && !model.isArenaMaster(v))
          .map((v) => ({ viewId: v, label: label(v) })),
      },
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
  clearHistory();
  forgetSharedArt();
  emit({ online: { ...offlineState(), status: 'connecting' }, banner: null, showGo: false, editing: false, editSelection: null, canUndo: false });
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
    clearHistory();
    forgetSharedArt();
    // Back to this device's own table, as it was before going online.
    const engine = getEngine();
    engine.loadStage();
    emit({
      online: offlineState(),
      stage: engine.stage,
      editing: false,
      editSelection: null,
      canUndo: false,
      phase: 'idle',
      paused: false,
      winner: null,
      banner: null,
      showGo: false,
      scores: { p1: 0, p2: 0 },
    });
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

// AR: like VR, the camera and the tracking live in the scene.
let arHandlers: { enter: () => Promise<unknown>; exit: () => void } | null = null;
export function setArHandlers(handlers: typeof arHandlers) {
  arHandlers = handlers;
}

/** Call from a click, so that the browser can ask for the camera. Anyone can switch, a spectator included. */
export function toggleAr() {
  if (state.arActive) {
    arHandlers?.exit();
    return;
  }
  audio.unlock();
  emit({ arError: null });
  arHandlers?.enter().catch((err: unknown) => {
    console.error(err);
    const denied = (err as { name?: string } | null)?.name === 'NotAllowedError';
    emit({
      arError: denied
        ? 'カメラの使用が許可されませんでした。ブラウザの設定でカメラを許可してください。'
        : 'カメラを開始できませんでした。ほかのアプリがカメラを使っていないか確認してください。',
    });
  });
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
