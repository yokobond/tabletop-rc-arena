/**
 * Pictures for the table top. A stage only names its picture (`local:…` or `croquet:…`);
 * the pixels are looked up here: in memory, in this device's storage, or on the session's file server.
 */
import { TABLE_HALF_X, TABLE_HALF_Z } from '../game/constants';
import type { TableArt } from '../game/types';
import { fetchData, storeData } from '../net/session';
import { loadSavedImage, saveImage } from './arenaStorage';

/** Uploaded pictures are cut to the table's shape at this size: sharp enough, and a few hundred KB. */
const IMAGE_WIDTH = 1536;
const IMAGE_HEIGHT = Math.round((IMAGE_WIDTH * TABLE_HALF_Z) / TABLE_HALF_X);

const blobs = new Map<string, Blob>();
const images = new Map<string, Promise<HTMLImageElement>>();
/** Pictures known to be on the file server of the session we are in. */
const shared = new Set<string>();

/** Other sessions cannot read this session's files, so what was shared is forgotten on leaving. */
export function forgetSharedArt() {
  shared.clear();
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image could not be read'));
    img.src = url;
  });
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/** Crops a picture to the table's proportions and re-encodes it as a JPEG of a fixed size. */
export async function prepareTableImage(file: Blob): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = IMAGE_WIDTH;
    canvas.height = IMAGE_HEIGHT;
    const g = canvas.getContext('2d')!;
    // Cover: fill the table, cutting off whatever sticks out.
    const scale = Math.max(IMAGE_WIDTH / img.naturalWidth, IMAGE_HEIGHT / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
    g.drawImage(img, (IMAGE_WIDTH - w) / 2, (IMAGE_HEIGHT - h) / 2, w, h);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('image could not be encoded'))), 'image/jpeg', 0.85),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Registers a picture this device just made under a new local name. */
export function addLocalImage(blob: Blob) {
  const src = `local:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  blobs.set(src, blob);
  return src;
}

async function artBlob(src: string): Promise<Blob> {
  const known = blobs.get(src);
  if (known) return known;
  let blob: Blob;
  const saved = await loadSavedImage(src);
  if (saved) {
    blob = saved;
  } else if (src.startsWith('croquet:')) {
    blob = new Blob([await fetchData(src.slice('croquet:'.length))], { type: 'image/jpeg' });
    shared.add(src);
  } else {
    throw new Error(`no picture for ${src}`);
  }
  blobs.set(src, blob);
  return blob;
}

/** The picture a stage names, ready to draw. Failures are not cached, so a later try can succeed. */
export function resolveArtImage(src: string) {
  let pending = images.get(src);
  if (!pending) {
    pending = artBlob(src).then(async (blob) => {
      const url = URL.createObjectURL(blob);
      try {
        return await loadImage(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    });
    pending.catch(() => images.delete(src));
    images.set(src, pending);
  }
  return pending;
}

/**
 * The same art in a form everybody in the session can load: a picture that only this device
 * has (or that belongs to an earlier session) is uploaded and named by its new place.
 */
export async function shareArt(art: TableArt): Promise<TableArt> {
  if (art.kind !== 'image' || shared.has(art.src)) return art;
  const blob = await artBlob(art.src);
  // Fetching it just now showed that it is already there.
  if (shared.has(art.src)) return art;
  const src = `croquet:${await storeData(await blob.arrayBuffer())}`;
  blobs.set(src, blob);
  shared.add(src);
  return { kind: 'image', src };
}

/**
 * Keeps a copy of a stage's picture on this device, next to the saved arena. False when the
 * arena has a picture and it could not be kept.
 */
export async function saveArtLocally(art: TableArt): Promise<boolean> {
  if (art.kind !== 'image' || (await loadSavedImage(art.src))) return true;
  try {
    return await saveImage(art.src, await artBlob(art.src));
  } catch (err) {
    console.error(err);
    return false;
  }
}

/** A stage's picture as a data URL, to put in a file; null when it has none or it cannot be read. */
export async function artDataUrl(art: TableArt): Promise<string | null> {
  if (art.kind !== 'image') return null;
  try {
    return await blobToDataUrl(await artBlob(art.src));
  } catch (err) {
    console.error(err);
    return null;
  }
}

/**
 * Takes in a picture that came in a file: decoded and encoded again like one chosen from the
 * device, so whatever the file held ends up as a plain JPEG of the table's size.
 */
export async function importArtImage(dataUrl: string): Promise<TableArt> {
  const blob = await prepareTableImage(await (await fetch(dataUrl)).blob());
  return { kind: 'image', src: addLocalImage(blob) };
}
