import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDENTITY, emptyDesign, putPiece, type CarDesign } from '../game/bodyParts';
import { MAX_SAVED_CARS, loadSavedCars, removeSavedCar, saveCarToLibrary } from './designStorage';

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
    adhesive: 'tape',
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
