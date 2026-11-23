import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDENTITY, emptyDesign, putPiece, type CarDesign } from '../game/bodyParts';
import {
  MAX_SAVED_CARS,
  loadCarLinks,
  loadSavedCars,
  overwriteSavedCar,
  removeSavedCar,
  renameSavedCar,
  saveCarLink,
  saveCarToLibrary,
} from './designStorage';

function memoryStorage() {
  const map = new Map<string, string>();
  let failSet = false;
  return {
    setFail(next: boolean) {
      failSet = next;
    },
    storage: {
      getItem(key: string) {
        return map.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        if (failSet) throw new Error('QuotaExceededError');
        map.set(key, value);
      },
      removeItem(key: string) {
        map.delete(key);
      },
      clear() {
        map.clear();
      },
      key(index: number) {
        return [...map.keys()][index] ?? null;
      },
      get length() {
        return map.size;
      },
    } as Storage,
  };
}

function sampleDesign(kind: 'cube' | 'brick' = 'cube'): CarDesign {
  return putPiece(emptyDesign(), {
    id: 'p1',
    kind,
    x: 0,
    y: kind === 'cube' ? 0.14 : 0.129,
    z: 0,
    rot: IDENTITY,
    adhesive: 'superglue',
    seat: [0, 1, 0],
  }).design!;
}

describe('saved cars library', () => {
  const hadWindow = 'window' in globalThis;
  const originalWindow = (globalThis as { window?: unknown }).window;
  let mock: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    mock = memoryStorage();
    (globalThis as { window?: unknown }).window = { localStorage: mock.storage };
  });

  afterEach(() => {
    if (hadWindow) (globalThis as { window?: unknown }).window = originalWindow;
    else delete (globalThis as { window?: unknown }).window;
  });

  it('saves cars newest first, overwrites same names keeping id, and removes by id', () => {
    expect(loadSavedCars()).toEqual([]);

    const firstDesign = sampleDesign('cube');
    const secondDesign = sampleDesign('brick');

    const afterFirst = saveCarToLibrary('  つみき号 ', firstDesign)!;
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].name).toBe('つみき号');
    expect(afterFirst[0].design).toEqual(firstDesign);
    const firstId = afterFirst[0].id;

    const afterSecond = saveCarToLibrary('ブロック号', secondDesign)!;
    expect(afterSecond.map((c) => c.name)).toEqual(['ブロック号', 'つみき号']);

    // Saving under an existing name moves it to the front and preserves its id.
    const overwritten = saveCarToLibrary('つみき号', secondDesign)!;
    expect(overwritten.map((c) => c.name)).toEqual(['つみき号', 'ブロック号']);
    expect(overwritten[0].id).toBe(firstId);
    expect(overwritten[0].design).toEqual(secondDesign);

    const remaining = removeSavedCar(firstId);
    expect(remaining.map((c) => c.name)).toEqual(['ブロック号']);
    expect(loadSavedCars()).toEqual(remaining);
  });

  it('renames a saved car keeping its id and place, and refuses a name another car has', () => {
    saveCarToLibrary('つみき号', sampleDesign('cube'));
    const list = saveCarToLibrary('ブロック号', sampleDesign('brick'))!;
    const [block, tsumiki] = list;

    const renamed = renameSavedCar(tsumiki.id, '  はやい号 ');
    expect(renamed).not.toBe('taken');
    expect((renamed as typeof list).map((c) => c.name)).toEqual(['ブロック号', 'はやい号']);
    expect((renamed as typeof list)[1].id).toBe(tsumiki.id);
    expect(loadSavedCars()[1].name).toBe('はやい号');

    expect(renameSavedCar(tsumiki.id, 'ブロック号')).toBe('taken');
    // Its own name again is fine.
    expect(renameSavedCar(block.id, 'ブロック号')).not.toBeNull();
    expect(renameSavedCar(tsumiki.id, '   ')).toBeNull();
    expect(renameSavedCar('missing', 'なにか')).toBeNull();
  });

  it('overwrites a saved car by id, keeping its name and moving it to the front', () => {
    const first = saveCarToLibrary('つみき号', sampleDesign('cube'))![0];
    saveCarToLibrary('ブロック号', sampleDesign('brick'));
    const next = overwriteSavedCar(first.id, sampleDesign('brick'))!;
    expect(next.map((c) => c.name)).toEqual(['つみき号', 'ブロック号']);
    expect(next[0].id).toBe(first.id);
    expect(next[0].design).toEqual(sampleDesign('brick'));
    expect(overwriteSavedCar('missing', sampleDesign())).toBeNull();
  });

  it('remembers which saved car each garage car is', () => {
    expect(loadCarLinks()).toEqual({ p1: null, p2: null });
    saveCarLink('p1', 'abc');
    saveCarLink('p2', 'def');
    saveCarLink('p2', null);
    expect(loadCarLinks()).toEqual({ p1: 'abc', p2: null });
    mock.storage.setItem('rc-sumo-arena.car-links.v1', '{bad');
    expect(loadCarLinks()).toEqual({ p1: null, p2: null });
  });

  it('rejects invalid names/designs, enforces MAX_SAVED_CARS, and returns null when storage fails', () => {
    const design = sampleDesign();
    expect(saveCarToLibrary('   ', design)).toBeNull();
    expect(saveCarToLibrary('不正', { pieces: 'bad' as unknown as CarDesign['pieces'], joints: [] })).toBeNull();

    for (let i = 1; i <= MAX_SAVED_CARS; i++) {
      expect(saveCarToLibrary(`カー${i}`, design)).not.toBeNull();
    }
    expect(loadSavedCars()).toHaveLength(MAX_SAVED_CARS);
    expect(saveCarToLibrary('あふれ', design)).toBeNull();
    // Overwriting an existing name still succeeds when at capacity.
    expect(saveCarToLibrary('カー1', sampleDesign('brick'))).toHaveLength(MAX_SAVED_CARS);

    mock.setFail(true);
    expect(saveCarToLibrary('カー2', design)).toBeNull();
  });

  it('ignores corrupt entries and invalid JSON in storage', () => {
    mock.storage.setItem('rc-sumo-arena.saved-cars.v1', '{not json');
    expect(loadSavedCars()).toEqual([]);

    const valid = sampleDesign();
    mock.storage.setItem(
      'rc-sumo-arena.saved-cars.v1',
      JSON.stringify([
        null,
        { id: '', name: 'x', savedAt: 1, design: valid },
        { id: 'c1', name: '  ', savedAt: 1, design: valid },
        { id: 'c2', name: 'こわれ', savedAt: 1, design: { pieces: 'nope', joints: [] } },
        { id: 'c3', name: 'せいじょう', savedAt: 'bad', design: valid },
        { id: 'c3', name: '重複ID', savedAt: 2, design: valid },
      ]),
    );
    const loaded = loadSavedCars();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual({ id: 'c3', name: 'せいじょう', savedAt: 0, design: valid });
  });
});
