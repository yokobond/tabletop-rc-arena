import { useEffect, useId, useState } from 'react';
import { MADE_LIMITS } from '../game/bodyParts';
import { assemblyMass, type Assembly } from '../game/assembly';
import type { PlayerId } from '../game/types';
import { assemblyThumbnail } from '../aframe/garageView';

interface Props {
  player: PlayerId;
  assembly: Assembly;
  /** Putting a new one in the tray, or changing one already there. */
  editing: boolean;
  onSave: (name: string) => void;
  onExport: (name: string) => void;
  onDelete: (() => void) | null;
  onClose: () => void;
}

/**
 * Naming a part made of parts (組み部品): putting the pieces picked on the car in the tray as one
 * part, or renaming, writing out or throwing away one already there.
 */
export function AssemblyDialog({ player, assembly, editing, onSave, onExport, onDelete, onClose }: Props) {
  const title = useId();
  const [name, setName] = useState(assembly.name);
  const picture = assemblyThumbnail(assembly, player);
  const grams = Math.round(assemblyMass(assembly) * 1000);
  const ok = name.trim().length > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="pm-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="pm-panel asm-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onSave(name.trim());
        }}
      >
        <h3 id={title} className="pm-title">
          {editing ? '組み部品をなおす' : '組み部品にしてトレイに入れる'}
        </h3>
        <div className="asm-body">
          {picture ? <img className="asm-picture" src={picture} alt="" draggable={false} /> : <span className="asm-picture" />}
          <div className="asm-fields">
            <label className="pm-name">
              <span className="g-label">なまえ</span>
              <input value={name} maxLength={MADE_LIMITS.name} placeholder="たとえば ロケット" autoFocus onChange={(e) => setName(e.target.value)} />
            </label>
            <p className="asm-info">
              {assembly.pieces.length}この物を組み合わせた部品・{grams}g
            </p>
            <p className="asm-hint">トレイからえらぶと、いまの組み合わせのまま車にくっつけられます。</p>
          </div>
        </div>
        <div className="pm-actions">
          <div className="pm-actions-side">
            {onDelete && (
              <button type="button" className="g-button g-danger" onClick={onDelete}>
                すてる
              </button>
            )}
            <button type="button" className="g-button" disabled={!ok} title="ほかの端末や友だちに渡せるファイルにします" onClick={() => onExport(name.trim())}>
              ファイルに書き出す
            </button>
          </div>
          <button type="button" className="g-button" onClick={onClose}>
            やめる
          </button>
          <button type="submit" className="g-button g-go" disabled={!ok}>
            {editing ? 'なおす' : 'トレイに入れる'}
          </button>
        </div>
      </form>
    </div>
  );
}
