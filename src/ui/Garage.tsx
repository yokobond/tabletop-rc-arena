import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ADHESIVES,
  ADHESIVE_LABEL,
  BASE,
  MAX_PIECES,
  MAX_PIECE_MASS,
  PIECES,
  PROBLEM_TEXT,
  defaultRot,
  designMass,
  emptyDesign,
  hangingOn,
  movedGroup,
  newPieceId,
  onSurface,
  putPiece,
  removePiece,
  restingOn,
  seatAgainst,
  specOf,
  turnOrientation,
  turnedInPlace,
  type Adhesive,
  type BodyPiece,
  type CarDesign,
  type MadePart,
  type PartType,
  type Quat,
  type Vec3,
} from '../game/bodyParts';
import type { PlayerId } from '../game/types';
import { GarageView, pieceThumbnail, type SurfaceHit } from '../aframe/garageView';
import { MAX_MADE_PARTS, loadMadeParts, saveMadeParts, type SavedPart } from '../runtime/designStorage';
import { openGarage, setCarDesign, useGame } from '../runtime/store';
import { keepMesh } from '../runtime/meshStore';
import { exportParts, importParts } from '../runtime/partFiles';
import { PartMaker } from './PartMaker';

/** Something from the tray in hand; `from` is its tray card (a kind, or a made part's id). */
interface Hand extends PartType {
  rot: Quat;
  from: string;
}

type Note = { ok: boolean; text: string } | null;

const HINT_START = 'したのトレイから物をえらんで、車の上をタップしてくっつけよう！';

const TOOL_NOTE: Record<Adhesive, string> = {
  tape: '次の物は両面テープで貼ります。平らな面どうしにだけ貼れて、はがれやすい。',
  hotglue: '次の物はホットグルーでくっつけます。3cm までのすき間も埋めるけれど、はがれやすい。',
};

const TOOL_SUB: Record<Adhesive, string> = {
  tape: '平らな面どうし・はがれやすい',
  hotglue: 'すき間を埋める・はがれやすい',
};

/** The way "stuck it on with": tape is 貼る, the others くっつける. */
const stuckWith = (a: Adhesive) => `${ADHESIVE_LABEL[a]}で${a === 'tape' ? '貼り' : 'くっつけ'}`;
const NUDGE = 0.01;

/**
 * A piece from the tray (or one already on the car, `seat` being where it lay) held against a
 * surface. On a slope or a round surface it tilts to lie along it, touching it.
 */
function pieceAt(design: CarDesign, hit: SurfaceHit, id: string, hand: PartType & { rot: Quat; seat?: Vec3 }, adhesive: Adhesive): BodyPiece {
  const surface = onSurface(design, hit.target, hit.point, hit.normal);
  const rot = restingOn(hand.rot, surface.normal, hand.seat);
  const at = seatAgainst(surface.point, surface.normal, hand, rot, !surface.round);
  const piece: BodyPiece = { id, kind: hand.kind, rot, adhesive, x: at.x, y: at.y, z: at.z, seat: at.seat };
  if (hand.made) piece.made = hand.made;
  return piece;
}

const label = (t: PartType) => specOf(t).label;
let madeCount = 0;
const newPartId = () => `m${Date.now().toString(36)}${(madeCount++).toString(36)}`;

/**
 * The garage: build a car body from everyday things on a turntable. Pick something from the
 * tray, then tap the car where it should go; it sticks with the adhesive chosen (tape holds flat
 * faces only; hot glue fills small gaps too; both let go easily). Pieces on the car are tapped to
 * pick them, dragged to move them, and turned, nudged or taken off with the buttons.
 */
export function Garage() {
  const slot = useGame((s) => s.garage) as PlayerId;
  const saved = useGame((s) => s.designs[slot]);
  const online = useGame((s) => s.online.status === 'on');
  const mode = useGame((s) => s.mode);

  const [design, setDesign] = useState<CarDesign>(() => saved ?? emptyDesign());
  const [past, setPast] = useState<CarDesign[]>([]);
  const [dirty, setDirty] = useState(false);
  const [hand, setHand] = useState<Hand | null>(null);
  const [tool, setTool] = useState<Adhesive>('tape');
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<Note>({ ok: true, text: HINT_START });
  const [made, setMade] = useState<SavedPart[]>(() => loadMadeParts());
  /** The part maker: open on a new part (`null`) or on a saved one (its id); closed is `false`. */
  const [making, setMaking] = useState<string | null | false>(false);

  const host = useRef<HTMLDivElement>(null);
  const view = useRef<GarageView | null>(null);
  // The 3D view calls back long after a render: it reads the latest state through this.
  const live = useRef({ design, hand, tool, selected });
  live.current = { design, hand, tool, selected };

  const thumbs = useMemo(() => Object.fromEntries(PIECES.map((p) => [p.kind, pieceThumbnail({ kind: p.kind }, slot)])), [slot]);
  const madeThumbs = useMemo(() => Object.fromEntries(made.map((m) => [m.id, pieceThumbnail({ kind: 'made', made: m.part }, slot)])), [made, slot]);

  const commit = (next: CarDesign) => {
    setPast((p) => [...p.slice(-29), live.current.design]);
    setDesign(next);
    setDirty(true);
  };

  const say = (ok: boolean, text: string) => setNote({ ok, text });

  /** Tries a piece where it is now; says why not when it cannot be there. */
  const tryPut = (piece: BodyPiece, done: string) => {
    const result = putPiece(live.current.design, piece);
    if (!result.design) {
      say(false, PROBLEM_TEXT[result.problem!]);
      return false;
    }
    const lost = live.current.design.pieces.length + (live.current.design.pieces.some((p) => p.id === piece.id) ? 0 : 1) - result.design.pieces.length;
    commit(result.design);
    say(true, lost > 0 ? `${done}（つながりが切れた ${lost} 個が外れました）` : done);
    return true;
  };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const v = new GarageView(el, slot, {
      canDrag: (id) => live.current.hand === null && live.current.design.pieces.some((p) => p.id === id),
      group: (id) => [id, ...hangingOn(live.current.design, id)],
      hover: (hit) => {
        const { hand: h, design: d, tool: t } = live.current;
        if (!h || !hit) return v.setGhost(null);
        const piece = pieceAt(d, hit, newPieceId(d), h, t);
        v.setGhost([piece], putPiece(d, piece).design !== null);
      },
      tap: (hit) => {
        const { hand: h, design: d, tool: t } = live.current;
        if (h) {
          if (!hit) return say(false, '車のどこにくっつけるか、車をタップしてください。');
          const piece = pieceAt(d, hit, newPieceId(d), h, t);
          if (tryPut(piece, `${label(h)}を${stuckWith(t)}ました。`)) {
            // The new piece is picked, ready to be turned or nudged; the tray is free again.
            setSelected(piece.id);
            setHand(null);
            v.setGhost(null);
          }
          return;
        }
        const id = hit && hit.target !== BASE ? hit.target : null;
        setSelected(id);
        if (id) {
          const p = d.pieces.find((q) => q.id === id)!;
          say(true, `${label(p)}をえらびました（${ADHESIVE_LABEL[p.adhesive]}）。ドラッグで動かせます。`);
        }
      },
      drag: (id, hit) => {
        const d = live.current.design;
        const p = d.pieces.find((q) => q.id === id);
        if (!p || !hit) return v.setGhost(null);
        const moved = pieceAt(d, hit, id, p, p.adhesive);
        // What hangs on it alone comes along.
        v.setGhost(movedGroup(d, moved), putPiece(d, moved).design !== null);
      },
      drop: (id, hit) => {
        v.setGhost(null);
        const p = live.current.design.pieces.find((q) => q.id === id);
        if (!p || !hit) return;
        setSelected(id);
        tryPut(pieceAt(live.current.design, hit, id, p, p.adhesive), `${label(p)}を動かしました。`);
      },
    });
    view.current = v;
    return () => {
      v.dispose();
      view.current = null;
    };
    // The view lives as long as the garage is open on one car.
  }, [slot]);

  useEffect(() => view.current?.setDesign(design), [design]);
  useEffect(() => view.current?.select(selected), [selected]);
  useEffect(() => {
    if (!hand) view.current?.setGhost(null);
  }, [hand]);

  // Switching cars starts from that car's saved body.
  const switchSlot = (next: PlayerId) => {
    if (next === slot) return;
    // The car being left keeps what was built on it.
    if (dirty) setCarDesign(slot, design);
    openGarage(next);
  };
  useEffect(() => {
    setDesign(saved ?? emptyDesign());
    setPast([]);
    setDirty(false);
    setSelected(null);
    setHand(null);
    setNote({ ok: true, text: HINT_START });
    // Only when the car changes, not when this car's saved body does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot]);

  const piece = design.pieces.find((p) => p.id === selected) ?? null;

  const pick = (type: PartType, from: string) => {
    if (hand?.from === from) {
      setHand(null);
      say(true, HINT_START);
      return;
    }
    setSelected(null);
    setHand({ ...type, rot: defaultRot(type), from });
    say(true, `${label(type)}を持っています。車の上をタップしてくっつけよう。`);
  };

  /** False (and says so) when the device would not keep the tray's parts, or the look of `part`. */
  const keepMade = (next: SavedPart[], ...parts: MadePart[]) => {
    setMade(next);
    const kept = saveMadeParts(next) && parts.every((p) => !p.mesh || keepMesh(p.mesh));
    if (!kept) say(false, 'この端末には部品を保存できませんでした。ページを閉じるまでは使えます。');
    return kept;
  };

  /** A part from the maker: a new one goes in the tray and into the hand. */
  const saveMade = (part: MadePart) => {
    if (making === false) return;
    if (making === null) {
      const id = newPartId();
      const kept = keepMade([...made, { id, part }], part);
      setMaking(false);
      setSelected(null);
      setHand({ kind: 'made', made: part, rot: defaultRot({ kind: 'made', made: part }), from: id });
      if (kept) say(true, `${part.name}をつくりました。車の上をタップしてくっつけよう。`);
      return;
    }
    const id = making;
    const kept = keepMade(
      made.map((m) => (m.id === id ? { id, part } : m)),
      part,
    );
    setMaking(false);
    if (hand?.from === id) setHand({ kind: 'made', made: part, rot: defaultRot({ kind: 'made', made: part }), from: id });
    if (kept) say(true, `${part.name}をなおしました。もう車についている物は、そのままです。`);
  };

  const partFiles = useRef<HTMLInputElement>(null);

  /** Parts from files go in the tray after the ones there (a part already there is not added twice). */
  const loadParts = async (files: File[]) => {
    const found: MadePart[] = [];
    let unreadable = 0;
    for (const file of files) {
      const parts = await importParts(file).catch(() => null);
      if (parts) found.push(...parts);
      else unreadable++;
    }
    if (found.length === 0) {
      say(false, unreadable ? '部品のファイルではありませんでした。' : 'ファイルに部品が入っていませんでした。');
      return;
    }
    const known = new Set(made.map((m) => JSON.stringify(m.part)));
    const fresh = found.filter((p) => {
      const key = JSON.stringify(p);
      if (known.has(key)) return false;
      known.add(key);
      return true;
    });
    const taken = fresh.slice(0, Math.max(0, MAX_MADE_PARTS - made.length));
    if (taken.length === 0) {
      say(false, fresh.length ? `トレイがいっぱいです。部品は ${MAX_MADE_PARTS} こまでです。` : 'どれも、もうトレイにある部品でした。');
      return;
    }
    const kept = keepMade([...made, ...taken.map((part) => ({ id: newPartId(), part }))], ...taken);
    if (!kept) return;
    const left = fresh.length - taken.length;
    say(
      true,
      `${taken.map((p) => p.name).join('、')}を読み込みました。` +
        (left ? `トレイがいっぱいで、${left}こは入りませんでした。` : '') +
        (unreadable ? `読めないファイルが${unreadable}こありました。` : ''),
    );
  };

  const dropMade = () => {
    if (typeof making !== 'string') return;
    const gone = made.find((m) => m.id === making);
    const kept = keepMade(made.filter((m) => m.id !== making));
    if (hand?.from === making) setHand(null);
    setMaking(false);
    if (kept) say(true, `${gone?.part.name ?? '部品'}をトレイからすてました。もう車についている物は、そのままです。`);
  };

  const turn = (axis: 'x' | 'y' | 'z') => {
    if (hand) {
      setHand({ ...hand, rot: turnOrientation(hand.rot, axis) });
      return;
    }
    if (!piece) return;
    const turned = turnedInPlace(piece, turnOrientation(piece.rot, axis));
    const name = label(piece);
    // Tilted, tape seldom meets a flat face any more: hot glue, about as strong, takes over
    // rather than the turn failing.
    const d = live.current.design;
    if (turned.adhesive === 'tape' && putPiece(d, turned).problem === 'tape' && putPiece(d, { ...turned, adhesive: 'hotglue' }).design) {
      tryPut({ ...turned, adhesive: 'hotglue' }, `${name}を回しました。平らな面が合わないので、ホットグルーでくっつけ直しました。`);
      return;
    }
    tryPut(turned, `${name}を回しました。`);
  };

  const nudge = (axis: 0 | 1 | 2, dir: 1 | -1) => {
    if (!piece) return;
    const at = [piece.x, piece.y, piece.z];
    at[axis] = Math.round((at[axis] + dir * NUDGE) * 10000) / 10000;
    tryPut({ ...piece, x: at[0], y: at[1], z: at[2] }, `${label(piece)}を動かしました。`);
  };

  /** The adhesive for the next thing from the tray. */
  const chooseTool = (next: Adhesive) => {
    setTool(next);
    say(true, TOOL_NOTE[next]);
  };

  /** The adhesive the picked piece would be stuck on with again: the other one. */
  const restickTo = (p: BodyPiece | null): Adhesive | null => (p ? (p.adhesive === 'tape' ? 'hotglue' : 'tape') : null);

  /** Sticks the picked piece again with another adhesive. */
  const restick = () => {
    const next = restickTo(piece);
    if (!piece || !next) return;
    tryPut({ ...piece, adhesive: next }, `${stuckWith(next)}直しました。`);
  };

  const remove = () => {
    if (!piece) return;
    const next = removePiece(design, piece.id);
    const lost = design.pieces.length - 1 - next.pieces.length;
    commit(next);
    setSelected(null);
    say(true, lost > 0 ? `外しました。それにくっついていた ${lost} 個も外れました。` : `${label(piece)}を外しました。`);
  };

  const undo = () => {
    const previous = past[past.length - 1];
    if (!previous) return;
    setPast(past.slice(0, -1));
    setDesign(previous);
    setDirty(true);
    setSelected(null);
  };

  const clearAll = () => {
    if (design.pieces.length === 0) return;
    commit(emptyDesign());
    setSelected(null);
    say(true, 'ぜんぶ外しました。');
  };

  const finish = () => {
    setCarDesign(slot, design);
    openGarage(null);
  };

  const classic = () => {
    setCarDesign(slot, null);
    openGarage(null);
  };

  const mass = designMass(design);
  const count = (a: Adhesive) => design.joints.filter((j) => j.kind === a).length;
  const restickNext = restickTo(piece);
  const slots: { id: PlayerId; label: string }[] = online
    ? [{ id: 'p1', label: 'あなたの車' }]
    : [
        { id: 'p1', label: '1P の車' },
        { id: 'p2', label: mode === 'cpu' ? 'CPU の車' : '2P の車' },
      ];
  const target = hand ?? piece;

  return (
    <section className={`garage garage-${slot}`} aria-labelledby="garage-title">
      <div className="garage-stage" ref={host} />

      <header className="garage-head">
        <h2 id="garage-title" className="garage-title">
          <span className="garage-badge">GARAGE</span>
          車をつくる
        </h2>
        <div className="garage-slots" role="tablist" aria-label="つくる車">
          {slots.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={s.id === slot} className={`garage-slot slot-${s.id}`} onClick={() => switchSlot(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="garage-head-actions">
          <button type="button" className="g-button" disabled={past.length === 0} onClick={undo}>
            元に戻す
          </button>
          <button type="button" className="g-button" onClick={() => openGarage(null)}>
            やめる
          </button>
          <button type="button" className="g-button g-go" onClick={finish}>
            決定！
          </button>
        </div>
      </header>

      <p className={`garage-note ${note?.ok === false ? 'is-bad' : ''}`} role="status" aria-live="polite">
        {note?.text}
      </p>

      <aside className="garage-side garage-left" aria-label="くっつけ方">
        <span className="g-label">次の物のくっつけ方</span>
        <div className="g-tool" role="radiogroup" aria-label="くっつけ方">
          {ADHESIVES.map((a) => (
            <button key={a} type="button" role="radio" aria-checked={tool === a} className={`g-tool-${a}`} onClick={() => chooseTool(a)}>
              {a === 'tape' ? <TapeIcon /> : <HotGlueIcon />}
              <span className="g-tool-name">{ADHESIVE_LABEL[a]}</span>
              <span className="g-tool-sub">{TOOL_SUB[a]}</span>
            </button>
          ))}
        </div>
        <dl className="g-stats">
          <div>
            <dt>パーツ</dt>
            <dd>
              {design.pieces.length} / {MAX_PIECES}
            </dd>
          </div>
          {ADHESIVES.map((a) => (
            <div key={a}>
              <dt>{ADHESIVE_LABEL[a]}</dt>
              <dd>{count(a)} か所</dd>
            </div>
          ))}
        </dl>
        <div className="g-weight" aria-label={`重さ ${Math.round((mass / MAX_PIECE_MASS) * 100)}%`}>
          <span className="g-label">重さ</span>
          <span className="g-meter">
            <span className="g-meter-fill" style={{ width: `${Math.min(100, (mass / MAX_PIECE_MASS) * 100)}%` }} />
          </span>
          <span className="g-weight-note">重いほど押されにくいけれど、加速がにぶくなる</span>
        </div>
      </aside>

      <aside className="garage-side garage-right" aria-label={hand ? '持っている物' : 'えらんだ物'}>
        <span className="g-label">{hand ? `持っている物：${label(hand)}` : piece ? `えらんだ物：${label(piece)}` : 'えらんだ物：なし'}</span>
        <div className="g-pad">
          <button type="button" className="g-button" disabled={!target} onClick={() => turn('y')}>
            くるっと回す
          </button>
          <button type="button" className="g-button" disabled={!target} onClick={() => turn('x')}>
            前に倒す
          </button>
          <button type="button" className="g-button" disabled={!target} onClick={() => turn('z')}>
            横に倒す
          </button>
          <span className="g-turn-note">1回で45°</span>
        </div>
        <div className="g-nudge" aria-label="少しずつ動かす">
          <button type="button" className="g-button g-arrow" disabled={!piece} onClick={() => nudge(1, 1)} aria-label="上へ">
            上
          </button>
          <button type="button" className="g-button g-arrow" disabled={!piece} onClick={() => nudge(2, 1)} aria-label="前へ">
            前
          </button>
          <button type="button" className="g-button g-arrow" disabled={!piece} onClick={() => nudge(1, -1)} aria-label="下へ">
            下
          </button>
          <button type="button" className="g-button g-arrow" disabled={!piece} onClick={() => nudge(0, 1)} aria-label="左へ">
            左
          </button>
          <button type="button" className="g-button g-arrow" disabled={!piece} onClick={() => nudge(2, -1)} aria-label="後ろへ">
            後
          </button>
          <button type="button" className="g-button g-arrow" disabled={!piece} onClick={() => nudge(0, -1)} aria-label="右へ">
            右
          </button>
        </div>
        <div className="g-pad">
          <button type="button" className={`g-button g-${restickNext ?? 'tape'}-button`} disabled={!piece} onClick={restick}>
            {restickNext ? `${ADHESIVE_LABEL[restickNext]}で貼り直す` : '貼り直す'}
          </button>
          <button type="button" className="g-button g-danger" disabled={!piece} onClick={remove}>
            外す
          </button>
          <button type="button" className="g-button" disabled={design.pieces.length === 0} onClick={clearAll}>
            ぜんぶ外す
          </button>
          <button type="button" className="g-button" onClick={classic}>
            いつもの車に戻す
          </button>
        </div>
      </aside>

      <nav className="garage-tray" aria-label="くっつける物">
        {PIECES.map((p) => (
          <button key={p.kind} type="button" className="g-card" aria-pressed={hand?.from === p.kind} onClick={() => pick({ kind: p.kind }, p.kind)}>
            {thumbs[p.kind] ? <img src={thumbs[p.kind]} alt="" draggable={false} /> : <span className="g-card-blank" />}
            <span className="g-card-name">{p.label}</span>
          </button>
        ))}
        {made.map((m) => (
          <div key={m.id} className="g-card-made">
            <button type="button" className="g-card" aria-pressed={hand?.from === m.id} onClick={() => pick({ kind: 'made', made: m.part }, m.id)}>
              {madeThumbs[m.id] ? <img src={madeThumbs[m.id]} alt="" draggable={false} /> : <span className="g-card-blank" />}
              <span className="g-card-name">{m.part.name}</span>
            </button>
            <button type="button" className="g-card-edit" aria-label={`${m.part.name}をなおす`} title="なおす" onClick={() => setMaking(m.id)}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 13 L3.6 10.4 L10.6 3.4 L12.6 5.4 L5.6 12.4 Z M9.6 4.4 L11.6 6.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        ))}
        {made.length < MAX_MADE_PARTS && (
          <button type="button" className="g-card g-card-new" onClick={() => setMaking(null)}>
            <span className="g-card-plus" aria-hidden="true">
              ＋
            </span>
            <span className="g-card-name">部品をつくる</span>
          </button>
        )}
        <button
          type="button"
          className="g-card g-card-new"
          aria-label="部品のファイルを読み込む"
          title="書き出した部品のファイルを読み込みます"
          onClick={() => partFiles.current?.click()}
        >
          <span className="g-card-plus" aria-hidden="true">
            <FileArrow down={false} />
          </span>
          <span className="g-card-name">読み込む</span>
        </button>
        {made.length > 0 && (
          <button
            type="button"
            className="g-card g-card-new"
            aria-label="つくった部品をぜんぶファイルに書き出す"
            title="つくった部品をぜんぶ、1つのファイルにします"
            onClick={() => exportParts(
              made.map((m) => m.part),
              'じぶんの部品',
            )}
          >
            <span className="g-card-plus" aria-hidden="true">
              <FileArrow down />
            </span>
            <span className="g-card-name">書き出す</span>
          </button>
        )}
        <input
          ref={partFiles}
          type="file"
          accept=".json,application/json"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            // Cleared, so that choosing the same file again is a change too.
            e.target.value = '';
            if (files.length) void loadParts(files);
          }}
        />
      </nav>

      {making !== false && (
        <PartMaker
          player={slot}
          editing={making === null ? null : (made.find((m) => m.id === making)?.part ?? null)}
          onSave={saveMade}
          onDelete={making === null ? null : dropMade}
          onClose={() => setMaking(false)}
        />
      )}
    </section>
  );
}

/** A sheet with an arrow: out of it (`down`, writing a file) or into it (reading one). */
function FileArrow({ down }: { down: boolean }) {
  return (
    <svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true">
      <path d="M8 4 H19 L25 10 V28 H8 Z M19 4 V10 H25" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      {down ? (
        <path d="M16.5 13 V23 M12.5 19 L16.5 23 L20.5 19" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M16.5 23 V13 M12.5 17 L16.5 13 L20.5 17" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function TapeIcon() {
  return (
    <svg className="g-icon" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="14" cy="16" r="11" fill="#E0F2FE" stroke="#0EA5E9" strokeWidth="2.5" />
      <circle cx="14" cy="16" r="5" fill="#FFFFFF" stroke="#0EA5E9" strokeWidth="2" />
      <path d="M14 27 H30 V23 H20" fill="#BAE6FD" stroke="#0EA5E9" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function HotGlueIcon() {
  return (
    <svg className="g-icon" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M4 9 H21 V17 H12 L10 27 H5 L7 17 H4 Z" fill="#F9A8D4" stroke="#DB2777" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M21 11 L27 12.5 V14 L21 15.5 Z" fill="#E2E8F0" stroke="#DB2777" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M1 12 H4" stroke="#FDF4FF" strokeWidth="3" strokeLinecap="round" />
      <circle cx="29" cy="17.5" r="2" fill="#FDF4FF" stroke="#F472B6" strokeWidth="1.2" />
    </svg>
  );
}
