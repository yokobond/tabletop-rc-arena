/** The browser side of part files: handing parts to the person as a download, and taking in a picked file. */
import type { MadePart } from '../game/bodyParts';
import { partFileName, readPartFile, writePartFile } from '../game/partFile';
import { downloadText, readFileText } from './arenaFiles';
import { addMesh, meshBytes } from './meshStore';

/** Writes the parts, their looks inside, to a file named after `name`. */
export function exportParts(parts: MadePart[], name: string) {
  const entries = parts.map((part) => ({ part, mesh: part.mesh ? meshBytes(part.mesh) : null }));
  downloadText(partFileName(name), writePartFile(entries));
}

/**
 * The parts in a picked file, their looks taken in (not yet kept on this device: see
 * `keepMesh`), or null when it is not a parts file.
 */
export async function importParts(file: Blob): Promise<MadePart[] | null> {
  const text = await readFileText(file);
  const entries = text === null ? null : readPartFile(text);
  if (!entries) return null;
  for (const { mesh } of entries) if (mesh) addMesh(mesh);
  return entries.map((e) => e.part);
}
