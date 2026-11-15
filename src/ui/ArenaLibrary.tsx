import { useRef } from 'react';
import { ARENA_NAME_LIMIT, cleanArenaName } from '../game/arenaFile';
import { MAX_SAVED_ARENAS } from '../runtime/arenaStorage';
import { deleteSavedArena, exportArena, importArena, loadSavedArena, saveArenaAs, useGame } from '../runtime/store';

const savedAtText = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Saving and loading in the arena editor: the arena on the table is saved under a name on this
 * device, or written to a file that another device can read. Loading replaces the arena on the
 * table (the editor's 元に戻す brings the previous one back).
 */
export function ArenaLibrary(props: { name: string; onName: (name: string) => void }) {
  const saved = useGame((s) => s.savedArenas);
  const note = useGame((s) => s.libraryNote);
  const busy = useGame((s) => s.artBusy);
  const fileInput = useRef<HTMLInputElement>(null);
  const name = cleanArenaName(props.name);

  const save = () => {
    if (saved.some((a) => a.name === name) && !window.confirm(`「${name}」はすでにあります。上書きしますか？`)) return;
    void saveArenaAs(name);
  };
  const load = (id: string, arenaName: string) => {
    props.onName(arenaName);
    void loadSavedArena(id);
  };
  const remove = (id: string, arenaName: string) => {
    if (window.confirm(`「${arenaName}」を削除しますか？元には戻せません。`)) deleteSavedArena(id);
  };

  return (
    <div className="arena-library">
      <form
        className="arena-name-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (name) save();
        }}
      >
        <label className="field-label" htmlFor="arena-name">
          名前
        </label>
        <input
          id="arena-name"
          className="arena-name"
          type="text"
          value={props.name}
          maxLength={ARENA_NAME_LIMIT}
          placeholder="アリーナの名前"
          autoComplete="off"
          enterKeyHint="done"
          onChange={(e) => props.onName(e.target.value)}
        />
        <button type="submit" className="segment" disabled={!name}>
          端末に保存
        </button>
      </form>

      <div className="field arena-saved-field">
        <span className="field-label" id="arena-saved">
          保存済み
        </span>
        {saved.length === 0 ? (
          <p className="dock-note">まだありません。名前を付けて「端末に保存」を押すと、ここに並びます。</p>
        ) : (
          <ul className="arena-saved" aria-labelledby="arena-saved">
            {saved.map((a) => (
              <li key={a.id}>
                <span className="arena-saved-name">{a.name}</span>
                <span className="arena-saved-date">{a.savedAt ? savedAtText.format(a.savedAt) : ''}</span>
                <button type="button" className="segment" disabled={busy} onClick={() => load(a.id, a.name)}>
                  読み込む
                </button>
                <button type="button" className="segment" onClick={() => remove(a.id, a.name)}>
                  削除
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="field">
        <span className="field-label" id="arena-file">
          ファイル
        </span>
        <div className="arena-buttons" role="group" aria-labelledby="arena-file">
          <button type="button" className="segment" onClick={() => void exportArena(name)}>
            ファイルに書き出す
          </button>
          <button type="button" className="segment" disabled={busy} onClick={() => fileInput.current?.click()}>
            ファイルから読み込む
          </button>
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared, so that choosing the same file again is a change too.
          e.target.value = '';
          if (!file) return;
          void importArena(file).then((loaded) => {
            if (loaded) props.onName(loaded);
          });
        }}
      />

      <p className={note && !note.ok ? 'dock-note online-error' : 'dock-note'} role="status">
        {busy
          ? '読み込んでいます…'
          : (note?.text ??
            `この端末に ${MAX_SAVED_ARENAS} 件まで保存できます（今 ${saved.length} 件）。ファイルに書き出すと、ほかの端末でも読み込めます。`)}
      </p>
    </div>
  );
}
