import { useEffect, useId, useRef, useState } from 'react';
import { CAR_NAME_LIMIT, cleanCarName } from '../game/carFile';

interface Props {
  /** "名前をつけて保存", "名前を変える", "別の車として保存". */
  title: string;
  thumb: string | null;
  initial: string;
  /** What the OK button says. */
  okLabel: string;
  /** Whether another saved car already has this (cleaned) name. */
  isTaken: (name: string) => boolean;
  /** `refuse`: a taken name cannot be used (renaming). `overwrite`: ask, then replace that car. */
  takenPolicy: 'refuse' | 'overwrite';
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

/**
 * The name entry screen: one big field for one name, shown above the car dialog, so naming is
 * always something chosen on purpose and never mixed up with the car already being edited.
 */
export function CarNameDialog({ title, thumb, initial, okLabel, isTaken, takenPolicy, onConfirm, onCancel }: Props) {
  const titleId = useId();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initial);
  const [askOverwrite, setAskOverwrite] = useState(false);
  const clean = cleanCarName(name);
  const taken = !!clean && isTaken(clean);
  const length = [...name].length;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      if (askOverwrite) setAskOverwrite(false);
      else onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [askOverwrite, onCancel]);

  const submit = () => {
    if (!clean) return;
    if (taken) {
      if (takenPolicy === 'refuse') return;
      if (!askOverwrite) {
        setAskOverwrite(true);
        return;
      }
    }
    onConfirm(clean);
  };

  return (
    <div className="pm-backdrop car-modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="pm-panel car-name-panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h3 id={titleId} className="pm-title">
          {title}
        </h3>
        {thumb ? <img className="car-name-thumb" src={thumb} alt="" draggable={false} /> : <span className="car-name-thumb" />}

        {askOverwrite ? (
          <div className="car-name-ask" role="alertdialog" aria-live="assertive">
            <p className="car-name-question">
              「{clean}」はもう保存されています。
              <br />
              その車を、いまの車で上書きしますか？
            </p>
            <div className="car-modal-actions">
              <button type="button" className="g-button car-modal-btn" autoFocus onClick={() => setAskOverwrite(false)}>
                いいえ
              </button>
              <button type="button" className="g-button g-go car-modal-btn" onClick={() => onConfirm(clean)}>
                上書きする
              </button>
            </div>
          </div>
        ) : (
          <form
            className="car-name-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label className="car-name-field" htmlFor={inputId}>
              <span className="g-label">車の名前</span>
              <input
                ref={input}
                id={inputId}
                type="text"
                value={name}
                maxLength={CAR_NAME_LIMIT}
                placeholder="たとえば ブルドーザー"
                autoComplete="off"
                enterKeyHint="done"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className="car-name-info">
              <span className={`car-name-hint${taken ? ' is-warn' : ''}`} role="status" aria-live="polite">
                {taken
                  ? takenPolicy === 'refuse'
                    ? 'その名前はほかの車で使われています。'
                    : `その名前の車があります。「${okLabel}」を押すと、上書きするか聞きます。`
                  : ' '}
              </span>
              <span className="car-name-count">
                {length} / {CAR_NAME_LIMIT}
              </span>
            </div>
            <div className="car-modal-actions">
              <button type="button" className="g-button car-modal-btn" onClick={onCancel}>
                やめる
              </button>
              <button type="submit" className="g-button g-go car-modal-btn" disabled={!clean || (taken && takenPolicy === 'refuse')}>
                {okLabel}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
