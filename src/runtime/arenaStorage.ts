/**
 * The custom arena of this device: one layout, and the picture on its table if it has one.
 * Kept in localStorage so that an arena prepared beforehand can be brought into any session.
 */
import { applyArenaEdit } from '../game/arena';
import { STAGES } from '../game/stages';
import type { StageDefinition } from '../game/types';

const STAGE_KEY = 'rc-sumo-arena.custom.v1';
const IMAGE_KEY = 'rc-sumo-arena.custom-image.v1';

function read(key: string): unknown {
  try {
    const text = window.localStorage.getItem(key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Storage is full or blocked: the arena still works until the page is closed.
    return false;
  }
}

/** The saved arena, checked like any arena that comes from outside. */
export function loadSavedStage(): StageDefinition | null {
  const saved = read(STAGE_KEY);
  return saved ? applyArenaEdit(STAGES.standard, { op: 'load', stage: saved }) : null;
}

export function saveStage(stage: StageDefinition) {
  return write(STAGE_KEY, stage);
}

/** The saved picture as a data URL, if it is the one `src` names. */
export function loadSavedImage(src: string): string | null {
  const saved = read(IMAGE_KEY) as { src?: unknown; dataUrl?: unknown } | null;
  return saved && saved.src === src && typeof saved.dataUrl === 'string' ? saved.dataUrl : null;
}

export function saveImage(src: string, dataUrl: string) {
  return write(IMAGE_KEY, { src, dataUrl });
}
