import { useRef } from 'react';
import { ARENA_ITEMS, MAX_OBSTACLES, MAX_PROPS, TABLE_ART_PRESETS } from '../game/arena';
import type { StageId, TableArtPreset } from '../game/types';
import {
  addArenaItem,
  chooseStage,
  removeSelected,
  rotateSelected,
  setEditing,
  setTableArtPreset,
  setTableImage,
  undoArenaEdit,
  useGame,
} from '../runtime/store';
import { Segmented } from './controls';

const ART_OPTIONS: { value: TableArtPreset | 'image'; label: string }[] = [
  ...TABLE_ART_PRESETS.map((p) => ({ value: p.id, label: p.label })),
  { value: 'image', label: '画像' },
];
const TEMPLATES: { value: StageId; label: string }[] = [
  { value: 'standard', label: 'スタンダード机' },
  { value: 'ramps', label: 'ジャンプリング' },
  { value: 'sumo', label: 'シンプル土俵' },
];
const ITEM_NAMES = { mug: 'マグ', books: '本', ramp: 'スロープ', pencil: '鉛筆', eraser: '消しゴム' } as const;

/**
 * The panel under the table while the arena is edited. Things are moved on the table itself
 * (see the `arena-editor` component); this adds what cannot be dragged: new objects, turning,
 * deleting, the picture on the table, and starting over from a preset.
 */
export function ArenaEditor() {
  const stage = useGame((s) => s.stage);
  const selection = useGame((s) => s.editSelection);
  const canUndo = useGame((s) => s.canUndo);
  const artBusy = useGame((s) => s.artBusy);
  const artError = useGame((s) => s.artError);
  const fileInput = useRef<HTMLInputElement>(null);

  const full = { obstacles: stage.obstacles.length >= MAX_OBSTACLES, props: stage.props.length >= MAX_PROPS };
  const selected =
    selection?.list === 'obstacles'
      ? stage.obstacles.find((o) => o.id === selection.id)
      : selection?.list === 'props'
        ? stage.props.find((p) => p.id === selection.id)
        : undefined;
  // A platform is a square stack of books.
  const selectedName = selected
    ? selected.kind === 'books' && selected.halfX === selected.halfZ
      ? '高台'
      : ITEM_NAMES[selected.kind]
    : selection?.list === 'spawns'
      ? `${selection.id === 'p1' ? '1P' : '2P'}のスタート位置`
      : 'なし';

  return (
    <section className="arena-editor" aria-labelledby="arena-editor-title">
      <header className="arena-editor-head">
        <h2 id="arena-editor-title">アリーナ編集</h2>
        <button type="button" className="dock-button" disabled={!canUndo} onClick={undoArenaEdit}>
          元に戻す
        </button>
        <button type="button" className="primary-button arena-editor-done" onClick={() => setEditing(false)}>
          完了
        </button>
      </header>
      <p className="dock-note">机の上の物をドラッグして動かします。車の下の輪はスタート位置で、同じように動かせます。</p>
      <div className="arena-editor-grid">
        <div className="field">
          <span className="field-label" id="arena-add">
            置く
          </span>
          <div className="arena-buttons" role="group" aria-labelledby="arena-add">
            {ARENA_ITEMS.map((item) => (
              <button key={item.type} type="button" className="segment" disabled={full[item.list]} onClick={() => addArenaItem(item.type)}>
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field-label" id="arena-selected">
            選択中
          </span>
          <div className="arena-buttons" role="group" aria-labelledby="arena-selected">
            <span className="arena-selected-name">{selectedName}</span>
            <button type="button" className="segment" disabled={!selected} onClick={() => rotateSelected(1)}>
              左に回す
            </button>
            <button type="button" className="segment" disabled={!selected} onClick={() => rotateSelected(-1)}>
              右に回す
            </button>
            <button type="button" className="segment" disabled={!selected} onClick={removeSelected}>
              削除
            </button>
          </div>
        </div>
        <Segmented
          label="テーブルの絵"
          value={stage.art.kind === 'image' ? 'image' : stage.art.id}
          options={ART_OPTIONS}
          disabled={artBusy}
          onChange={(v) => (v === 'image' ? fileInput.current?.click() : setTableArtPreset(v))}
        />
        <Segmented label="ひな形" value={stage.id} options={TEMPLATES} onChange={chooseStage} />
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared, so that choosing the same file again is a change too.
          e.target.value = '';
          if (file) void setTableImage(file);
        }}
      />
      <p className="dock-note" role="status">
        {artBusy
          ? '画像を準備しています…'
          : `障害物 ${stage.obstacles.length} / ${MAX_OBSTACLES}、小物 ${stage.props.length} / ${MAX_PROPS}。「画像」を押すと、この端末の画像をテーブルに貼れます。`}
      </p>
      {artError && (
        <p className="dock-note online-error" role="alert">
          {artError}
        </p>
      )}
    </section>
  );
}
