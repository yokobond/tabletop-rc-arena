/**
 * An arena as a file: what "書き出す" writes and "読み込む" reads, so an arena can be carried to
 * another device. Reading trusts nothing: the layout goes through the same check as any arena
 * from outside, and the picture is only accepted as an image the browser can decode again.
 */
import { applyArenaEdit } from './arena';
import { STAGES } from './stages';
import type { StageDefinition } from './types';

export const ARENA_NAME_LIMIT = 24;
const FORMAT = 'rc-sumo-arena';
const VERSION = 1;
/** A table picture is a few hundred KB; this is far above it and still quick to check. */
const MAX_IMAGE_CHARS = 6_000_000;
const IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A name as it is shown and stored: one line, no padding, not too long. */
export function cleanArenaName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return [...name.replace(/\s+/g, ' ').trim()].slice(0, ARENA_NAME_LIMIT).join('').trim();
}

/** Any layout as a custom arena of its own (a preset too), checked and rebuilt; null when it is not one. */
export function asCustomStage(stage: unknown): StageDefinition | null {
  return isRecord(stage) ? applyArenaEdit(STAGES.standard, { op: 'load', stage }) : null;
}

/** The file's text. `image` is the table picture as a data URL, when the arena has one. */
export function writeArenaFile(name: string, stage: StageDefinition, image: string | null): string {
  return JSON.stringify({ format: FORMAT, version: VERSION, name: cleanArenaName(name), stage, ...(image ? { image } : {}) });
}

export interface ArenaFileContent {
  name: string;
  /** With a preset design when the file's picture is missing or unusable. */
  stage: StageDefinition;
  /** The picture to put on the table: the caller stores it and names it in `stage.art`. */
  image: string | null;
}

export function readArenaFile(text: string): ArenaFileContent | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.format !== FORMAT || data.version !== VERSION) return null;
  const stage = asCustomStage(data.stage);
  if (!stage) return null;
  const name = cleanArenaName(data.name);
  if (stage.art.kind !== 'image') return { name, stage, image: null };
  // The name the picture had on the device that wrote the file means nothing here.
  const plain: StageDefinition = { ...stage, art: { kind: 'preset', id: 'dohyo' } };
  const image = data.image;
  const usable = typeof image === 'string' && image.length <= MAX_IMAGE_CHARS && IMAGE_DATA_URL.test(image);
  return { name, stage: plain, image: usable ? image : null };
}
