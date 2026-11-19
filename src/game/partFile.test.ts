import { describe, expect, it } from 'vitest';
import { readMadePart, type MadePart } from './bodyParts';
import { readAssembly } from './assembly';
import { partFileName, readPartFile, writePartFile } from './partFile';
import { bakeMesh, fitShapes, measureMesh, meshIdOf, type SourceMesh } from './stlMesh';

/** A look: a little box mesh baked as a part would be. */
function look() {
  const p = [0, 0, 0, 40, 0, 0, 0, 20, 0, 40, 20, 0, 0, 0, 30, 40, 0, 30, 0, 20, 30, 40, 20, 30];
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const mesh: SourceMesh = { pos: new Float32Array(p), idx: Uint32Array.from(quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d])) };
  const m = measureMesh(mesh);
  return bakeMesh(mesh, 0.001, fitShapes(m, 0.001).box!, [0, 20, 0]).bytes;
}

const plain = readMadePart({ name: 'ストロー', shape: { kind: 'cylinder', r: 0.008, h: 0.2 }, mass: 0.01, color: '#F97316' })!;

describe('part files', () => {
  it('carry plain parts and parts with a look, and bring them back the same', () => {
    const bytes = look();
    const id = meshIdOf(bytes);
    const stl = readMadePart({ name: 'はこ', shape: { kind: 'box', size: [0.04, 0.02, 0.03] }, mass: 0.02, color: '#22C55E', mesh: id, turn: [0, 20, 0] })!;
    const text = writePartFile([
      { part: plain, mesh: null },
      { part: stl, mesh: bytes },
    ]);
    // The look's id is not written: the reader names it from the bytes.
    expect(text).not.toContain(id);
    const read = readPartFile(text)!.parts;
    expect(read.map((e) => e.part)).toEqual([plain, stl]);
    expect(read[0].mesh).toBeNull();
    expect([...read[1].mesh!]).toEqual([...bytes]);
  });

  it('turns a part whose look is broken into its plain shape, and leaves out what is no part', () => {
    const stl: MadePart = { name: 'つつ', shape: { kind: 'cylinder', r: 0.01, h: 0.1 }, mass: 0.02, color: '#22C55E', mesh: 'm0123456789abcdef', lying: true };
    const data = JSON.parse(writePartFile([{ part: stl, mesh: look() }]));
    data.parts[0].mesh = btoa('not a mesh');
    data.parts.push({ part: { name: '', shape: { kind: 'ball', r: 0.02 }, mass: 0.01, color: '#000000' } }, 'junk');
    const read = readPartFile(JSON.stringify(data))!.parts;
    expect(read).toHaveLength(1);
    expect(read[0].mesh).toBeNull();
    expect(read[0].part).toEqual({ name: 'つつ', shape: { kind: 'cylinder', r: 0.01, h: 0.1 }, mass: 0.02, color: '#22C55E' });
  });

  it('carry parts made of parts, with the looks of their pieces', () => {
    const bytes = look();
    const id = meshIdOf(bytes);
    const stl = readMadePart({ name: 'はこ', shape: { kind: 'box', size: [0.04, 0.02, 0.03] }, mass: 0.02, color: '#22C55E', mesh: id })!;
    const assembly = readAssembly({
      name: 'のっぽ',
      pieces: [
        { id: 'a1', kind: 'cube', x: 0, y: 0, z: 0, rot: [0, 0, 0, 1], adhesive: 'tape' },
        { id: 'a2', kind: 'made', made: stl, x: 0, y: 0.045, z: 0, rot: [0, 0, 0, 1], adhesive: 'hotglue' },
      ],
      joints: [{ a: 'a1', b: 'a2', kind: 'tape' }],
    })!;
    expect(assembly).not.toBeNull();
    const text = writePartFile([], [{ assembly, meshes: [bytes] }]);
    const read = readPartFile(text)!;
    expect(read.parts).toEqual([]);
    expect(read.assemblies[0].assembly).toEqual(assembly);
    expect([...read.assemblies[0].meshes[0]]).toEqual([...bytes]);
    // Without its look, the piece comes in as its plain box.
    const lost = readPartFile(writePartFile([], [{ assembly, meshes: [] }]))!;
    expect(lost.assemblies[0].assembly.pieces[1].made).toEqual({ name: 'はこ', shape: stl.shape, mass: 0.02, color: '#22C55E' });
    expect(lost.assemblies[0].meshes).toEqual([]);
  });

  it('read files from before assemblies', () => {
    expect(readPartFile(JSON.stringify({ format: 'rc-sumo-parts', version: 1, parts: [] }))).toEqual({ parts: [], assemblies: [] });
  });

  it('refuses what is not a parts file', () => {
    expect(readPartFile('nope')).toBeNull();
    expect(readPartFile(JSON.stringify({ format: 'rc-sumo-arena', version: 1, parts: [] }))).toBeNull();
    expect(readPartFile(JSON.stringify({ format: 'rc-sumo-parts', version: 2, parts: [] }))).toBeNull();
  });

  it('names the file after the part, safe for file systems', () => {
    expect(partFileName('ロケット/2')).toBe('ロケット_2.parts.json');
    expect(partFileName('  ')).toBe('part.parts.json');
  });
});
