/** The browser side of part files: handing parts to the person as a download, and taking in a picked file. */
import type { MadePart } from '../game/bodyParts';
import type { Assembly } from '../game/assembly';
import { partFileName, readPartFile, writePartFile } from '../game/partFile';
import { downloadText, readFileText } from './arenaFiles';
import { addMesh, meshBytes } from './meshStore';

/** The looks an assembly's pieces name that are on this device. */
function looksOf(assembly: Assembly) {
  const ids = new Set(assembly.pieces.map((p) => p.made?.mesh).filter((id): id is string => !!id));
  return [...ids].map(meshBytes).filter((b): b is Uint8Array => !!b);
}

/** Writes the parts (and parts made of parts), their looks inside, to a file named after `name`. */
export function exportParts(parts: MadePart[], name: string, assemblies: Assembly[] = []) {
  const entries = parts.map((part) => ({ part, mesh: part.mesh ? meshBytes(part.mesh) : null }));
  downloadText(partFileName(name), writePartFile(entries, assemblies.map((assembly) => ({ assembly, meshes: looksOf(assembly) }))));
}

/**
 * The parts in a picked file, their looks taken in (not yet kept on this device: see
 * `keepMesh`), or null when it is not a parts file.
 */
export async function importParts(file: Blob): Promise<{ parts: MadePart[]; assemblies: Assembly[] } | null> {
  const text = await readFileText(file);
  const read = text === null ? null : readPartFile(text);
  if (!read) return null;
  for (const { mesh } of read.parts) if (mesh) addMesh(mesh);
  for (const { meshes } of read.assemblies) for (const mesh of meshes) addMesh(mesh);
  return { parts: read.parts.map((e) => e.part), assemblies: read.assemblies.map((e) => e.assembly) };
}
