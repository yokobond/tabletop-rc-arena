import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { designMass, type CarDesign } from '../game/bodyParts';
import { CAR_NAME_LIMIT, cleanCarName } from '../game/carFile';
import type { PlayerId } from '../game/types';
import { designThumbnail } from '../aframe/garageView';
import { MAX_SAVED_CARS, type SavedCar } from '../runtime/designStorage';
import type { OnlinePeerCar } from '../runtime/store';

export type CarLibraryNote = { ok: boolean; text: string } | null;

interface Props {
  player: PlayerId;
  design: CarDesign;
  name: string;
  savedCars: SavedCar[];
  online: boolean;
  shareDesign: boolean;
  peerCars: OnlinePeerCar[];
  onName: (name: string) => void;
  onSave: (name: string) => CarLibraryNote;
  onLoad: (car: SavedCar) => void;
  onExport: (design: CarDesign, name: string) => CarLibraryNote;
  onImport: (file: File) => Promise<CarLibraryNote | null>;
  onDelete: (car: SavedCar) => CarLibraryNote;
  onShareDesign: (next: boolean) => void;
  onLoadPeer: (peer: OnlinePeerCar) => Promise<CarLibraryNote | null>;
  onClose: () => void;
}

/**
 * Choosing, saving, and sharing car bodies in the garage: tap a car's 3D thumbnail card
 * (including an online opponent's car when they have enabled sharing) to switch the turntable
 * to it, or save the current car under a name / to a `.car.json` file.
 */
export function CarLibrary({
  player,
  design,
  name,
  savedCars,
  online,
  shareDesign,
  peerCars,
  onName,
  onSave,
  onLoad,
  onExport,
  onImport,
  onDelete,
  onShareDesign,
  onLoadPeer,
  onClose,
}: Props) {
  const titleId = useId();
  const inputId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<CarLibraryNote>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const clean = cleanCarName(name);
  const currentThumb = useMemo(() => designThumbnail(design, player, false), [design, player]);
  const savedThumbs = useMemo(
    () => Object.fromEntries(savedCars.map((c) => [c.id, designThumbnail(c.design, player, true)])),
    [savedCars, player],
  );
  const sharedPeers = useMemo(
    () => peerCars.filter((p): p is OnlinePeerCar & { design: CarDesign } => p.shared && p.design !== null),
    [peerCars],
  );
  const peerThumbs = useMemo(
    () => Object.fromEntries(sharedPeers.map((p) => [p.seat, designThumbnail(p.design, p.seat, false)])),
    [sharedPeers],
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

  const save = (force = false) => {
    if (!clean) return;
    if (!force && savedCars.some((c) => c.name === clean)) {
      setConfirmOverwrite(true);
      setNote({ ok: true, text: `「${clean}」はすでにあります。もう一度「上書き保存」を押すと上書きします。` });
      return;
    }
    setConfirmOverwrite(false);
    setNote(onSave(clean));
  };

  const remove = (car: SavedCar) => {
    setConfirmDeleteId(null);
    setNote(onDelete(car));
  };

  const runAsync = async (work: () => Promise<CarLibraryNote | null>) => {
    setBusy(true);
    try {
      const res = await work();
      if (res) setNote(res);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pm-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pm-panel car-lib-panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h3 id={titleId} className="pm-title">
          車体を選ぶ
        </h3>

        <section className="car-lib-section" aria-label="車体一覧">
          <div className="car-lib-section-head">
            <span className="g-label">
              車体一覧（サムネイルを押すと切り替わります・保存済み {savedCars.length} / {MAX_SAVED_CARS}）
            </span>
            <button type="button" className="g-button car-lib-btn" disabled={busy} onClick={() => fileInput.current?.click()}>
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
              if (file) void runAsync(() => onImport(file));
            }}
          />

          {sharedPeers.length === 0 && savedCars.length === 0 ? (
            <p className="car-lib-empty">
              まだ選べる車体がありません。下の欄でいまの車体に名前を付けて保存するか、オンライン対戦の相手が車体を提供すると、ここにサムネイルが並びます。
            </p>
          ) : (
            <div className="car-picker-grid" role="list">
              {sharedPeers.map((peer) => {
                const grams = Math.round(designMass(peer.design) * 1000);
                const thumb = peerThumbs[peer.seat];
                return (
                  <div key={`peer-${peer.seat}`} className="car-picker-card is-peer" role="listitem">
                    <button
                      type="button"
                      className="car-picker-main"
                      disabled={busy}
                      onClick={() => void runAsync(() => onLoadPeer(peer))}
                    >
                      <span className="car-picker-badge">相手の車</span>
                      {thumb ? (
                        <img className="car-picker-thumb" src={thumb} alt="" draggable={false} />
                      ) : (
                        <span className="car-picker-thumb" />
                      )}
                      <span className="car-picker-name">{peer.label}</span>
                      <span className="car-lib-meta">
                        パーツ {peer.design.pieces.length} こ・{grams}g
                      </span>
                    </button>
                  </div>
                );
              })}

              {savedCars.map((car) => {
                const grams = Math.round(designMass(car.design) * 1000);
                const thumb = savedThumbs[car.id];
                const confirming = confirmDeleteId === car.id;
                return (
                  <div key={car.id} className={`car-picker-card${confirming ? ' is-confirming' : ''}`} role="listitem">
                    <button
                      type="button"
                      className="car-picker-del"
                      disabled={busy}
                      aria-label={`「${car.name}」を削除する`}
                      title="この車体を削除する"
                      onClick={() => setConfirmDeleteId(confirming ? null : car.id)}
                    >
                      ×
                    </button>
                    <button type="button" className="car-picker-main" disabled={busy} onClick={() => onLoad(car)}>
                      {thumb ? (
                        <img className="car-picker-thumb" src={thumb} alt="" draggable={false} />
                      ) : (
                        <span className="car-picker-thumb" />
                      )}
                      <span className="car-picker-name">{car.name}</span>
                      <span className="car-lib-meta">
                        パーツ {car.design.pieces.length} こ・{grams}g
                      </span>
                    </button>
                    <div className="car-picker-actions">
                      {confirming ? (
                        <>
                          <button
                            type="button"
                            className="car-picker-sub"
                            disabled={busy}
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            やめる
                          </button>
                          <button
                            type="button"
                            className="car-picker-sub is-danger is-confirm"
                            disabled={busy}
                            onClick={() => remove(car)}
                          >
                            消す！
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="car-picker-sub"
                            disabled={busy}
                            title="ファイルに書き出す"
                            onClick={() => setNote(onExport(car.design, car.name))}
                          >
                            書き出す
                          </button>
                          <button
                            type="button"
                            className="car-picker-sub is-danger"
                            disabled={busy}
                            title="この車体を削除する"
                            onClick={() => setConfirmDeleteId(car.id)}
                          >
                            削除
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {online && sharedPeers.length === 0 && (
            <p className="car-lib-peer-hint">
              {peerCars.some((p) => p.hasCustomCar && !p.shared)
                ? '対戦相手は車体の提供をオフにしています。相手が「相手に提供」をオンにすると、ここに相手の車体も並びます。'
                : '対戦相手が車体をつくり「相手に提供」をオンにすると、ここに相手の車体も並びます。'}
            </p>
          )}
        </section>

        <section className="car-lib-current" aria-label="いまの車体を保存">
          <div className="car-lib-thumb-box">
            {currentThumb ? <img className="car-lib-thumb" src={currentThumb} alt="" draggable={false} /> : <span className="car-lib-thumb" />}
            <span className="car-lib-meta">
              いまの車体：{design.pieces.length} こ・{currentGrams}g
            </span>
          </div>
          <form
            className="car-lib-form"
            onSubmit={(e) => {
              e.preventDefault();
              save(confirmOverwrite);
            }}
          >
            <label className="pm-name" htmlFor={inputId}>
              <span className="g-label">いまの車体に名前を付けて保存</span>
              <input
                id={inputId}
                type="text"
                value={name}
                maxLength={CAR_NAME_LIMIT}
                placeholder="たとえば ブルドーザー"
                autoComplete="off"
                enterKeyHint="done"
                onChange={(e) => {
                  setConfirmOverwrite(false);
                  onName(e.target.value);
                }}
              />
            </label>
            <div className="car-lib-row">
              <button type="submit" className="g-button g-go car-lib-btn" disabled={!clean || busy}>
                {confirmOverwrite ? '上書き保存' : '端末に保存'}
              </button>
              {confirmOverwrite && (
                <button
                  type="button"
                  className="g-button car-lib-btn"
                  disabled={busy}
                  onClick={() => {
                    setConfirmOverwrite(false);
                    setNote(null);
                  }}
                >
                  やめる
                </button>
              )}
              <button
                type="button"
                className="g-button car-lib-btn"
                disabled={busy}
                title="ほかの端末や友だちに渡せるファイルにします"
                onClick={() => setNote(onExport(design, clean || 'マイカー'))}
              >
                ファイルに書き出す
              </button>
            </div>
          </form>
        </section>

        <section className="car-lib-share" aria-label="オンラインの車体提供">
          <div className="car-lib-share-row">
            <div className="car-lib-share-copy">
              <span className="g-label">自分の車体を相手に提供</span>
              <span className="car-lib-share-hint">
                「相手に提供」にすると、相手の「車体を選ぶ」にあなたの車体が追加されます。
              </span>
            </div>
            <div className="car-lib-share-toggle" role="radiogroup" aria-label="自分の車体を相手に提供">
              <button
                type="button"
                role="radio"
                aria-checked={!shareDesign}
                className="car-lib-share-option"
                onClick={() => onShareDesign(false)}
              >
                提供しない
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={shareDesign}
                className="car-lib-share-option"
                onClick={() => onShareDesign(true)}
              >
                相手に提供
              </button>
            </div>
          </div>
        </section>

        <p className={`car-lib-status${note && !note.ok ? ' is-bad' : ''}`} role="status" aria-live="polite">
          {note?.text ??
            '車体を選んで切り替えると、その車体についている自作部品や組み部品も選んで「トレイに入れる」で自分の部品にできます。'}
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
