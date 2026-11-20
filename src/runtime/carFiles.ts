/** The browser side of car files: downloading a built car and reading one the user picked. */
import type { CarDesign } from '../game/bodyParts';
import { carFileName, readCarFile, writeCarFile } from '../game/carFile';
import { downloadText, readFileText } from './arenaFiles';
import { addMesh, meshBytes } from './meshStore';

/** Writes the car design and any STL looks it uses on this device to a `.car.json` file. */
export function exportCar(design: CarDesign, name: string): { lookLost: boolean } {
  const ids = new Set(design.pieces.map((p) => p.made?.mesh).filter((id): id is string => !!id));
  const meshes: Uint8Array[] = [];
  let lookLost = false;
  for (const id of ids) {
    const bytes = meshBytes(id);
    if (bytes) meshes.push(bytes);
    else lookLost = true;
  }
  downloadText(carFileName(name), writeCarFile(name, design, meshes));
  return { lookLost };
}

/**
 * Reads a picked car file and registers its STL looks in memory (not yet persisted to storage;
 * see `keepMesh`). Returns null when the file is not a valid car file.
 */
export async function importCar(file: Blob): Promise<{ name: string; design: CarDesign; lookLost: boolean } | null> {
  const text = await readFileText(file);
  const read = text === null ? null : readCarFile(text);
  if (!read) return null;
  for (const mesh of read.meshes) addMesh(mesh);
  return { name: read.name, design: read.design, lookLost: read.missingLooks };
}
