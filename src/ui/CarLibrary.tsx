import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { designMass, type CarDesign } from '../game/bodyParts';
import { CAR_NAME_LIMIT, cleanCarName } from '../game/carFile';
import type { PlayerId } from '../game/types';
import { designThumbnail } from '../aframe/garageView';
import { MAX_SAVED_CARS, type SavedCar } from '../runtime/designStorage';

export type CarLibraryNote = { ok: boolean; text: string } | null;

interface Props {
  player: PlayerId;
  design: CarDesign;
  name: string;
  savedCars: SavedCar[];
  onName: (name: string) => void;
  onSave: (name: string) => CarLibraryNote;
  onLoad: (car: SavedCar) => void;
  onExport: (design: CarDesign, name: string) => CarLibraryNote;
  onImport: (file: File) => Promise<CarLibraryNote | null>;
  onDelete: (car: SavedCar) => CarLibraryNote;
  onClose: () => void;
}

const savedAtText = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Saving and loading car bodies in the garage: keep built cars under a name on this device
 * (up to 30, with 3D thumbnails), or exchange `.car.json` files across devices.
 */
export function CarLibrary({
  player,
  design,
  name,
  savedCars,
  onName,
  onSave,
  onLoad,
  onExport,
  onImport,
  onDelete,
  onClose,
}: Props) {
  const titleId = useId();
  const inputId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<CarLibraryNote>(null);
  const [busy, setBusy] = useState(false);

  const clean = cleanCarName(name);
  const currentThumb = useMemo(() => designThumbnail(design, player, false), [design, player]);
  const savedThumbs = useMemo(
    () => Object.fromEntries(savedCars.map((c) => [c.id, designThumbnail(c.design, player, true)])),
    [savedCars, player],
  );
  const currentGrams = Math.round(designMass(design) * 1000);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = () => {
    if (!clean) return;
    if (savedCars.some((c) => c.name === clean) && !window.confirm(`「${clean}」はすでにあります。上書きしますか？`)) return;
    setNote(onSave(clean));
  };

  const remove = (car: SavedCar) => {
    if (!window.confirm(`「${car.name}」を削除しますか？元には戻せません。`)) return;
    setNote(onDelete(car));
  };

  const handleFile = async (file: File) => {
    setBusy(true);
    try {
      const res = await onImport(file);
      if (res) setNote(res);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pm-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pm-panel car-lib-panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h3 id={titleId} className="pm-title">
          車体の保存・読み込み
        </h3>

        <section className="car-lib-current" aria-label="いまの車体">
          <div className="car-lib-thumb-box">
            {currentThumb ? <img className="car-lib-thumb" src={currentThumb} alt="" draggable={false} /> : <span className="car-lib-thumb" />}
            <span className="car-lib-meta">
              パーツ {design.pieces.length} こ・{currentGrams}g
            </span>
          </div>
          <form
            className="car-lib-form"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <label className="pm-name" htmlFor={inputId}>
              <span className="g-label">なまえ</span>
              <input
                id={inputId}
                type="text"
                value={name}
                maxLength={CAR_NAME_LIMIT}
                placeholder="たとえば ブルドーザー"
                autoComplete="off"
                enterKeyHint="done"
                autoFocus
                onChange={(e) => onName(e.target.value)}
              />
            </label>
            <div className="car-lib-row">
              <button type="submit" className="g-button g-go" disabled={!clean || busy}>
                端末に保存
              </button>
              <button
                type="button"
                className="g-button"
                disabled={busy}
                title="ほかの端末や友だちに渡せるファイルにします"
                onClick={() => setNote(onExport(design, clean || 'マイカー'))}
              >
                ファイルに書き出す
              </button>
            </div>
          </form>
        </section>

        <section className="car-lib-section" aria-label="保存済みの車体">
          <div className="car-lib-section-head">
            <span className="g-label">
              保存済みの車体（{savedCars.length} / {MAX_SAVED_CARS}）
            </span>
            <button type="button" className="g-button" disabled={busy} onClick={() => fileInput.current?.click()}>
              {busy ? '読み込んでいます…' : 'ファイルから読み込む'}
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Cleared, so that picking the same file again triggers onChange.
              e.target.value = '';
              if (file) void handleFile(file);
            }}
          />

          {savedCars.length === 0 ? (
            <p className="car-lib-empty">まだありません。なまえを付けて「端末に保存」を押すと、ここに並びます。</p>
          ) : (
            <ul className="car-lib-list">
              {savedCars.map((car) => {
                const grams = Math.round(designMass(car.design) * 1000);
                const thumb = savedThumbs[car.id];
                const dateText = car.savedAt ? savedAtText.format(car.savedAt) : '';
                return (
                  <li key={car.id} className="car-lib-item">
                    {thumb ? <img className="car-lib-item-thumb" src={thumb} alt="" draggable={false} /> : <span className="car-lib-item-thumb" />}
                    <div className="car-lib-item-info">
                      <span className="car-lib-item-name">{car.name}</span>
                      <span className="car-lib-meta">
                        パーツ {car.design.pieces.length} こ・{grams}g{dateText ? `・${dateText}` : ''}
                      </span>
                    </div>
                    <div className="car-lib-item-actions">
                      <button type="button" className="g-button g-go car-lib-btn" disabled={busy} onClick={() => onLoad(car)}>
                        読み込む
                      </button>
                      <button
                        type="button"
                        className="g-button car-lib-btn"
                        disabled={busy}
                        onClick={() => setNote(onExport(car.design, car.name))}
                      >
                        書き出す
                      </button>
                      <button type="button" className="g-button g-danger car-lib-btn" disabled={busy} onClick={() => remove(car)}>
                        削除
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <p className={`car-lib-status${note && !note.ok ? ' is-bad' : ''}`} role="status" aria-live="polite">
          {note?.text ??
            `この端末に ${MAX_SAVED_CARS} 台まで保存できます（今 ${savedCars.length} 台）。ファイルに書き出すと、ほかの端末や友だちと共有できます。`}
        </p>

        <div className="car-lib-foot">
          <button type="button" className="g-button" onClick={onClose}>
            とじる
          </button>
        </div>
      </div>
    </div>
  );
}
