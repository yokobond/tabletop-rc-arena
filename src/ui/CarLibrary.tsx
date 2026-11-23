import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { designMass, type CarDesign } from '../game/bodyParts';
import type { PlayerId } from '../game/types';
import { designThumbnail } from '../aframe/garageView';
import { MAX_SAVED_CARS, type SavedCar } from '../runtime/designStorage';
import type { OnlinePeerCar } from '../runtime/store';
import { CarNameDialog } from './CarNameDialog';

export type CarLibraryNote = { ok: boolean; text: string } | null;

type SharedPeer = OnlinePeerCar & { design: CarDesign };

/** A car opened in the big pop-up card. */
type Detail = { kind: 'saved'; id: string } | { kind: 'peer'; seat: PlayerId } | null;

/** What the name entry screen is open for. */
type Naming = { mode: 'save' } | { mode: 'saveAs' } | { mode: 'rename'; id: string } | null;

interface Props {
  player: PlayerId;
  design: CarDesign;
  /** The saved car being edited, or null when it has no name yet. */
  currentCar: SavedCar | null;
  /** Whether the car being edited has changes not saved yet. */
  changed: boolean;
  /** A name to offer when saving a car with no name yet. */
  nameHint: string;
  savedCars: SavedCar[];
  online: boolean;
  shareDesign: boolean;
  peerCars: OnlinePeerCar[];
  onOverwrite: () => CarLibraryNote;
  onSaveAs: (name: string) => CarLibraryNote;
  onRename: (car: SavedCar, name: string) => CarLibraryNote | 'taken';
  onLoad: (car: SavedCar) => void;
  onNew: () => void;
  onExport: (design: CarDesign, name: string) => CarLibraryNote;
  onImport: (file: File) => Promise<CarLibraryNote | null>;
  onDelete: (car: SavedCar) => CarLibraryNote;
  onShareDesign: (next: boolean) => void;
  onLoadPeer: (peer: OnlinePeerCar) => Promise<CarLibraryNote | null>;
  onClose: () => void;
}

const grams = (design: CarDesign) => Math.round(designMass(design) * 1000);
const savedDate = (ms: number) =>
  ms > 0 ? new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

/**
 * Choosing, saving and naming car bodies, made for fingers on a tablet. The car being edited sits
 * on top with its name (or "名前なし") and the one save button that fits it; below, every car is a
 * big card. Tapping a card only opens that car's pop-up, where switching to it, renaming,
 * exporting and deleting are separate big buttons, and deleting asks first.
 */
export function CarLibrary({
  player,
  design,
  currentCar,
  changed,
  nameHint,
  savedCars,
  online,
  shareDesign,
  peerCars,
  onOverwrite,
  onSaveAs,
  onRename,
  onLoad,
  onNew,
  onExport,
  onImport,
  onDelete,
  onShareDesign,
  onLoadPeer,
  onClose,
}: Props) {
  const titleId = useId();
  const detailTitleId = useId();
  const confirmTitleId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<CarLibraryNote>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Detail>(null);
  const [naming, setNaming] = useState<Naming>(null);
  const [confirmDelete, setConfirmDelete] = useState<SavedCar | null>(null);

  const currentThumb = useMemo(() => designThumbnail(design, player, false), [design, player]);
  const savedThumbs = useMemo(
    () => Object.fromEntries(savedCars.map((c) => [c.id, designThumbnail(c.design, player, true)])),
    [savedCars, player],
  );
  const sharedPeers = useMemo(() => peerCars.filter((p): p is SharedPeer => p.shared && p.design !== null), [peerCars]);
  const peerThumbs = useMemo(
    () => Object.fromEntries(sharedPeers.map((p) => [p.seat, designThumbnail(p.design, p.seat, false)])),
    [sharedPeers],
  );

  const detailCar = detail?.kind === 'saved' ? (savedCars.find((c) => c.id === detail.id) ?? null) : null;
  const detailPeer = detail?.kind === 'peer' ? (sharedPeers.find((p) => p.seat === detail.seat) ?? null) : null;
  const renaming = naming?.mode === 'rename' ? (savedCars.find((c) => c.id === naming.id) ?? null) : null;

  // Escape closes the top layer only.
  const layers = useRef({ detail, confirmDelete, naming });
  layers.current = { detail, confirmDelete, naming };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      const open = layers.current;
      if (open.naming) return; // The name screen handles its own.
      if (open.confirmDelete) setConfirmDelete(null);
      else if (open.detail) setDetail(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const runAsync = async (work: () => Promise<CarLibraryNote | null>) => {
    setBusy(true);
    try {
      const res = await work();
      if (res) setNote(res);
    } finally {
      setBusy(false);
    }
  };

  const isTakenBy = (exceptId: string | null) => (name: string) => savedCars.some((c) => c.id !== exceptId && c.name === name);

  const named = !!currentCar;
  const statusText = named ? (changed ? '保存していない変更があります' : '保存済み') : design.pieces.length > 0 ? 'まだ保存していません' : 'からっぽの新しい車';

  return (
    <div className="pm-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pm-panel car-lib-panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="car-lib-top">
          <h3 id={titleId} className="pm-title">
            車体を選ぶ・保存する
          </h3>
          <button type="button" className="g-button car-lib-close" aria-label="とじる" onClick={onClose}>
            とじる
          </button>
        </div>

        {/* The car being edited, with its name plate and the save button that fits it. */}
        <section className={`car-now${named ? '' : ' is-unnamed'}${changed ? ' is-changed' : ''}`} aria-label="いま編集中の車">
          {currentThumb ? <img className="car-now-thumb" src={currentThumb} alt="" draggable={false} /> : <span className="car-now-thumb" />}
          <div className="car-now-info">
            <span className="car-now-label">いま編集中の車</span>
            <strong className="car-now-name">{currentCar?.name ?? '名前なし'}</strong>
            <span className="car-now-status">
              <span className="car-now-dot" aria-hidden="true" />
              {statusText}
            </span>
            <span className="car-now-meta">
              パーツ {design.pieces.length} こ・{grams(design)}g
            </span>
          </div>
          <div className="car-now-actions">
            {currentCar ? (
              <>
                <button
                  type="button"
                  className="g-button g-go car-big-btn"
                  disabled={!changed || busy}
                  onClick={() => setNote(onOverwrite())}
                >
                  {changed ? `「${currentCar.name}」に上書き保存` : '保存済み ✓'}
                </button>
                <div className="car-now-sub">
                  <button type="button" className="g-button car-mid-btn" disabled={busy} onClick={() => setNaming({ mode: 'rename', id: currentCar.id })}>
                    名前を変える
                  </button>
                  <button type="button" className="g-button car-mid-btn" disabled={busy || design.pieces.length === 0} onClick={() => setNaming({ mode: 'saveAs' })}>
                    別の車として保存
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                className="g-button g-go car-big-btn"
                disabled={busy || design.pieces.length === 0}
                onClick={() => setNaming({ mode: 'save' })}
              >
                名前をつけて保存
              </button>
            )}
          </div>
        </section>

        {/* Every car as a big card: tapping one opens its pop-up. */}
        <section className="car-lib-section" aria-label="保存した車">
          <div className="car-lib-section-head">
            <span className="g-label">
              保存した車 {savedCars.length} / {MAX_SAVED_CARS}
            </span>
            <button type="button" className="g-button car-mid-btn" disabled={busy} onClick={() => fileInput.current?.click()}>
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

          <div className="car-grid" role="list">
            <div role="listitem" className="car-card-slot">
              <button type="button" className="car-card is-new" disabled={busy} onClick={onNew}>
                <span className="car-card-plus" aria-hidden="true">
                  ＋
                </span>
                <span className="car-card-name">新しくつくる</span>
                <span className="car-card-meta">からっぽの車から</span>
              </button>
            </div>
            {savedCars.map((car) => {
              const thumb = savedThumbs[car.id];
              const editing = car.id === currentCar?.id;
              return (
                <div key={car.id} role="listitem" className="car-card-slot">
                  <button
                    type="button"
                    className={`car-card${editing ? ' is-editing' : ''}`}
                    disabled={busy}
                    aria-label={`${car.name}${editing ? '（いま編集中）' : ''}`}
                    onClick={() => setDetail({ kind: 'saved', id: car.id })}
                  >
                    {editing && <span className="car-card-ribbon">編集中</span>}
                    {thumb ? <img className="car-card-thumb" src={thumb} alt="" draggable={false} /> : <span className="car-card-thumb" />}
                    <span className="car-card-name">{car.name}</span>
                    <span className="car-card-meta">
                      {car.design.pieces.length} こ・{grams(car.design)}g
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
          {savedCars.length === 0 && (
            <p className="car-lib-empty">まだ保存した車はありません。上の「名前をつけて保存」で、いまの車をここに入れられます。</p>
          )}
        </section>

        {online && (
          <section className="car-lib-section" aria-label="相手の車">
            <span className="g-label">相手の車</span>
            {sharedPeers.length > 0 ? (
              <div className="car-grid" role="list">
                {sharedPeers.map((peer) => {
                  const thumb = peerThumbs[peer.seat];
                  return (
                    <div key={`peer-${peer.seat}`} role="listitem" className="car-card-slot">
                      <button type="button" className="car-card is-peer" disabled={busy} onClick={() => setDetail({ kind: 'peer', seat: peer.seat })}>
                        <span className="car-card-ribbon is-peer">相手</span>
                        {thumb ? <img className="car-card-thumb" src={thumb} alt="" draggable={false} /> : <span className="car-card-thumb" />}
                        <span className="car-card-name">{peer.label}</span>
                        <span className="car-card-meta">
                          {peer.design.pieces.length} こ・{grams(peer.design)}g
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="car-lib-peer-hint">
                {peerCars.some((p) => p.hasCustomCar && !p.shared)
                  ? '対戦相手は車体の提供をオフにしています。相手が「相手に提供」をオンにすると、ここに相手の車が並びます。'
                  : '対戦相手が車体をつくり「相手に提供」をオンにすると、ここに相手の車が並びます。'}
              </p>
            )}
          </section>
        )}

        <section className="car-lib-share" aria-label="オンラインの車体提供">
          <div className="car-lib-share-row">
            <div className="car-lib-share-copy">
              <span className="g-label">自分の車体を相手に提供</span>
              <span className="car-lib-share-hint">「相手に提供」にすると、相手の「相手の車」にあなたの車が並びます。</span>
            </div>
            <div className="car-lib-share-toggle" role="radiogroup" aria-label="自分の車体を相手に提供">
              <button type="button" role="radio" aria-checked={!shareDesign} className="car-lib-share-option" onClick={() => onShareDesign(false)}>
                提供しない
              </button>
              <button type="button" role="radio" aria-checked={shareDesign} className="car-lib-share-option" onClick={() => onShareDesign(true)}>
                相手に提供
              </button>
            </div>
          </div>
        </section>

        <p className={`car-lib-status${note && !note.ok ? ' is-bad' : ''}`} role="status" aria-live="polite">
          {note?.text ?? '車のカードを押すと、その車にする・名前を変える・消す ができます。'}
        </p>
      </div>

      {/* The pop-up card of one saved car. */}
      {detailCar && !confirmDelete && !naming && (
        <div className="pm-backdrop car-modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setDetail(null)}>
          <div className="pm-panel car-detail-panel" role="dialog" aria-modal="true" aria-labelledby={detailTitleId}>
            {savedThumbs[detailCar.id] ? (
              <img className="car-detail-thumb" src={savedThumbs[detailCar.id]!} alt="" draggable={false} />
            ) : (
              <span className="car-detail-thumb" />
            )}
            <h3 id={detailTitleId} className="car-detail-name">
              {detailCar.name}
            </h3>
            <p className="car-detail-meta">
              パーツ {detailCar.design.pieces.length} こ・{grams(detailCar.design)}g
              {savedDate(detailCar.savedAt) && <> ・ {savedDate(detailCar.savedAt)} に保存</>}
            </p>
            <div className="car-detail-actions">
              {detailCar.id === currentCar?.id ? (
                <p className="car-detail-editing">いま編集中の車です</p>
              ) : (
                <button
                  type="button"
                  className="g-button g-go car-big-btn"
                  autoFocus
                  onClick={() => {
                    setDetail(null);
                    onLoad(detailCar);
                  }}
                >
                  この車にする
                </button>
              )}
              <div className="car-detail-row">
                <button type="button" className="g-button car-mid-btn" onClick={() => setNaming({ mode: 'rename', id: detailCar.id })}>
                  名前を変える
                </button>
                <button type="button" className="g-button car-mid-btn" onClick={() => setNote(onExport(detailCar.design, detailCar.name))}>
                  ファイルに書き出す
                </button>
              </div>
              <div className="car-detail-row is-foot">
                <button type="button" className="g-button car-mid-btn car-danger-btn" onClick={() => setConfirmDelete(detailCar)}>
                  消す
                </button>
                <button type="button" className="g-button car-mid-btn" onClick={() => setDetail(null)}>
                  とじる
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* The pop-up card of an opponent's shared car. */}
      {detailPeer && (
        <div className="pm-backdrop car-modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setDetail(null)}>
          <div className="pm-panel car-detail-panel" role="dialog" aria-modal="true" aria-labelledby={detailTitleId}>
            {peerThumbs[detailPeer.seat] ? (
              <img className="car-detail-thumb" src={peerThumbs[detailPeer.seat]!} alt="" draggable={false} />
            ) : (
              <span className="car-detail-thumb" />
            )}
            <h3 id={detailTitleId} className="car-detail-name">
              {detailPeer.label}
            </h3>
            <p className="car-detail-meta">
              パーツ {detailPeer.design.pieces.length} こ・{grams(detailPeer.design)}g
            </p>
            <p className="car-detail-note">この車にすると、ついている部品を「トレイに入れる」で自分の部品にできます。</p>
            <div className="car-detail-actions">
              <button
                type="button"
                className="g-button g-go car-big-btn"
                autoFocus
                disabled={busy}
                onClick={() => {
                  setDetail(null);
                  void runAsync(() => onLoadPeer(detailPeer));
                }}
              >
                この車にする
              </button>
              <div className="car-detail-row is-foot">
                <button type="button" className="g-button car-mid-btn" onClick={() => setDetail(null)}>
                  とじる
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Deleting always asks first; "やめる" is where the finger already is. */}
      {confirmDelete && (
        <div className="pm-backdrop car-modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setConfirmDelete(null)}>
          <div className="pm-panel car-confirm-panel" role="alertdialog" aria-modal="true" aria-labelledby={confirmTitleId}>
            {savedThumbs[confirmDelete.id] ? (
              <img className="car-confirm-thumb" src={savedThumbs[confirmDelete.id]!} alt="" draggable={false} />
            ) : (
              <span className="car-confirm-thumb" />
            )}
            <h3 id={confirmTitleId} className="car-confirm-title">
              「{confirmDelete.name}」を消しますか？
            </h3>
            <p className="car-confirm-text">
              消した車はもとに戻せません。
              {confirmDelete.id === currentCar?.id && (
                <>
                  <br />
                  いまガレージにある車は残りますが「名前なし」になります。
                </>
              )}
            </p>
            <div className="car-modal-actions">
              <button type="button" className="g-button car-modal-btn" autoFocus onClick={() => setConfirmDelete(null)}>
                やめる
              </button>
              <button
                type="button"
                className="g-button car-modal-btn car-danger-btn is-solid"
                onClick={() => {
                  const car = confirmDelete;
                  setConfirmDelete(null);
                  setDetail(null);
                  setNote(onDelete(car));
                }}
              >
                消す
              </button>
            </div>
          </div>
        </div>
      )}

      {naming?.mode === 'save' && (
        <CarNameDialog
          title="名前をつけて保存"
          thumb={currentThumb}
          initial={nameHint}
          okLabel="保存する"
          isTaken={isTakenBy(null)}
          takenPolicy="overwrite"
          onCancel={() => setNaming(null)}
          onConfirm={(name) => {
            setNaming(null);
            setNote(onSaveAs(name));
          }}
        />
      )}
      {naming?.mode === 'saveAs' && (
        <CarNameDialog
          title="別の車として保存"
          thumb={currentThumb}
          initial=""
          okLabel="保存する"
          isTaken={isTakenBy(null)}
          takenPolicy="overwrite"
          onCancel={() => setNaming(null)}
          onConfirm={(name) => {
            setNaming(null);
            setNote(onSaveAs(name));
          }}
        />
      )}
      {renaming && (
        <CarNameDialog
          title="名前を変える"
          thumb={savedThumbs[renaming.id] ?? null}
          initial={renaming.name}
          okLabel="決定"
          isTaken={isTakenBy(renaming.id)}
          takenPolicy="refuse"
          onCancel={() => setNaming(null)}
          onConfirm={(name) => {
            const res = onRename(renaming, name);
            if (res === 'taken') return;
            setNaming(null);
            setNote(res);
          }}
        />
      )}
    </div>
  );
}
