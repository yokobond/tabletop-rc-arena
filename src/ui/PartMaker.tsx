import { useEffect, useId, useMemo, useState } from 'react';
import { MADE_LIMITS, readMadePart, type MadePart, type PieceShape, type Vec3 } from '../game/bodyParts';
import {
  bakeMesh,
  bestFit,
  fitShapes,
  measureMesh,
  readStl,
  StlError,
  thinMesh,
  unbakeMesh,
  type FitKind,
  type MeshMeasure,
  type ShapeFit,
  type SourceMesh,
} from '../game/stlMesh';
import type { PlayerId } from '../game/types';
import { addMesh, meshFor } from '../runtime/meshStore';
import { exportParts } from '../runtime/partFiles';
import { PartView } from './PartView';

type ShapeKind = FitKind;

/** A part being made from an STL file: its look, and what fitting a shape to it needs. */
interface StlDraft {
  file: string;
  /** Thinned, Y up, in the file's units (or meters, when it is a part being changed). */
  mesh: SourceMesh;
  /** Of the whole mesh, before thinning. */
  measure: MeshMeasure;
  /** Its longest side, in the same units. */
  longest: number;
}

/**
 * A shape to bump with that the player set themselves (for a thin, bent thing, say, where the
 * fitted one is no good). In the mesh's own units, so it grows and shrinks with the part.
 */
interface OwnShape {
  kind: FitKind;
  /** A tube's axis in the mesh: 0 x, 1 y (standing), 2 z. */
  axis: 0 | 1 | 2;
  /** Box: its sides. */
  size: Vec3;
  /** Tube or ball. */
  r: number;
  /** Tube: its length. */
  h: number;
  center: Vec3;
  /** A box: how far it is tilted around the look's x, y and z (degrees). */
  turn: Vec3;
  /** Set by the player here (rather than what the part being changed had). */
  mine: boolean;
}

/** Bigger files are not even opened. */
const MAX_FILE_BYTES = 160 * 1024 * 1024;
/** A guess at its weight: printed in PLA (1.24 g/cm³), a quarter filled in. */
const PRINTED_DENSITY = 1240 * 0.25;

const SHAPES: { kind: ShapeKind; label: string }[] = [
  { kind: 'box', label: '箱' },
  { kind: 'cylinder', label: '筒' },
  { kind: 'ball', label: '玉' },
];

const COLORS: [string, string][] = [
  ['#EF4444', 'あか'],
  ['#F97316', 'オレンジ'],
  ['#FACC15', 'きいろ'],
  ['#22C55E', 'みどり'],
  ['#06B6D4', 'みずいろ'],
  ['#3B82F6', 'あお'],
  ['#A855F7', 'むらさき'],
  ['#EC4899', 'ピンク'],
  ['#F8FAFC', 'しろ'],
  ['#78716C', 'ちゃいろ'],
  ['#1F2937', 'くろ'],
];

/** What the sliders hold: centimeters and grams, as a child would measure them. */
interface Draft {
  name: string;
  shape: ShapeKind;
  w: number;
  h: number;
  d: number;
  /** Tube or ball: across. */
  across: number;
  /** Tube: how long. */
  long: number;
  grams: number;
  color: string;
  /** From an STL file: then `size` is how long its longest side is, and the shape is fitted to it. */
  stl: StlDraft | null;
  size: number;
  /** The shape the player chose over the fitted one. */
  pick: FitKind | null;
  /** A shape the player sized and placed themselves, over the fitted one. */
  own: OwnShape | null;
}

const SIDE_CM = [MADE_LIMITS.side[0] * 100, MADE_LIMITS.side[1] * 100] as const;
const ACROSS_CM = [MADE_LIMITS.radius[0] * 200, MADE_LIMITS.radius[1] * 200] as const;
const GRAMS = [MADE_LIMITS.mass[0] * 1000, MADE_LIMITS.mass[1] * 1000] as const;

const NEW_DRAFT: Draft = { name: '', shape: 'box', w: 8, h: 4, d: 6, across: 5, long: 10, grams: 40, color: '#3B82F6', stl: null, size: 10, pick: null, own: null };

const cm = (v: number) => Math.round(v * 1000) / 10;
const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

function draftOf(part: MadePart): Draft {
  const draft = { ...NEW_DRAFT, name: part.name, color: part.color, grams: Math.round(part.mass * 1000) };
  const look = part.mesh ? meshFor(part.mesh) : null;
  if (look) {
    // Its look is made again from what the part carries, so it can still grow, shrink or change shape.
    const mesh = unbakeMesh(look, part.lying === true, part.turn);
    const measure = measureMesh(mesh);
    const longest = Math.max(...measure.size);
    const size = cm(longest);
    // The shape it bumps with stays as it was: the look is centered on it, and a lying tube lies along z.
    const scale = size / 100 / longest;
    const s = part.shape;
    const own: OwnShape = {
      kind: s.kind,
      axis: part.lying ? 2 : 1,
      size: s.kind === 'box' ? (s.size.map((v) => v / scale) as Vec3) : [0, 0, 0],
      r: s.kind === 'box' ? 0 : s.r / scale,
      h: s.kind === 'cylinder' ? s.h / scale : 0,
      center: [0, 0, 0],
      turn: part.turn ?? [0, 0, 0],
      mine: false,
    };
    return { ...draft, shape: s.kind, stl: { file: '', mesh, measure, longest }, size, pick: s.kind, own };
  }
  const s = part.shape;
  if (s.kind === 'box') return { ...draft, shape: 'box', w: cm(s.size[0]), h: cm(s.size[1]), d: cm(s.size[2]) };
  if (s.kind === 'cylinder') return { ...draft, shape: 'cylinder', across: cm(s.r * 2), long: cm(s.h) };
  return { ...draft, shape: 'ball', across: cm(s.r * 2) };
}

const SHAPE_NAME: Record<ShapeKind, string> = { box: '箱', cylinder: '筒', ball: '玉' };

interface Made {
  part: MadePart | null;
  /** From an STL file: the shapes that fit it, the best one, and the one it gets. */
  fits?: Record<FitKind, ShapeFit | null>;
  best?: FitKind | null;
  kind?: FitKind | null;
}

function partOf(d: Draft): Made {
  const name = d.name.trim() || `じぶんの${SHAPE_NAME[d.shape]}`;
  if (d.stl) {
    const scale = d.size / 100 / d.stl.longest;
    const fits = fitShapes(d.stl.measure, scale);
    const best = bestFit(fits);
    const kind = d.own ? d.own.kind : d.pick && fits[d.pick] ? d.pick : best;
    if (!kind) return { part: null, fits, best, kind };
    const fit = d.own ? ownFit(d.own, scale) : fits[kind]!;
    const tilt = d.own?.kind === 'box' ? d.own.turn : undefined;
    const { bytes, lying } = bakeMesh(d.stl.mesh, scale, fit, tilt);
    const part = readMadePart({ name: d.name.trim() || d.stl.file || 'STLの部品', shape: fit.shape, mass: d.grams / 1000, color: d.color, mesh: addMesh(bytes), lying, turn: tilt });
    return { part, fits, best, kind };
  }
  return { part: plainPart(d, name) };
}

/** How far a box may be tilted each way: a quarter turn more is the same box with its sides swapped. */
const TILT = [-90, 90] as const;

/** To 0.1 mm, within what a made-up part may be. */
const within = (v: number, range: readonly [number, number]) => clamp(Math.round(v * 10000) / 10000, range);

/** The player's own shape at `scale`, as a fit. */
function ownFit(own: OwnShape, scale: number): ShapeFit {
  const { side, radius } = MADE_LIMITS;
  const shape: PieceShape =
    own.kind === 'box'
      ? { kind: 'box', size: own.size.map((v) => within(v * scale, side)) as Vec3 }
      : own.kind === 'cylinder'
        ? { kind: 'cylinder', r: within(own.r * scale, radius), h: within(own.h * scale, side) }
        : { kind: 'ball', r: within(own.r * scale, radius) };
  return { shape, center: own.center, axis: own.kind === 'cylinder' ? own.axis : 1, volume: 0 };
}

/** A fitted shape as the player's own, to change from there. */
function ownOf(fit: ShapeFit, scale: number): OwnShape {
  const s = fit.shape;
  return {
    kind: s.kind,
    axis: fit.axis,
    size: s.kind === 'box' ? (s.size.map((v) => v / scale) as Vec3) : [0, 0, 0],
    r: s.kind === 'box' ? 0 : s.r / scale,
    h: s.kind === 'cylinder' ? s.h / scale : 0,
    center: [...fit.center] as Vec3,
    turn: [0, 0, 0],
    mine: true,
  };
}

function plainPart(d: Draft, name: string): MadePart | null {
  const m = (cm: number) => cm / 100;
  const shape =
    d.shape === 'box'
      ? { kind: 'box' as const, size: [m(d.w), m(d.h), m(d.d)] as [number, number, number] }
      : d.shape === 'cylinder'
        ? { kind: 'cylinder' as const, r: m(d.across) / 2, h: m(d.long) }
        : { kind: 'ball' as const, r: m(d.across) / 2 };
  return readMadePart({ name, shape, mass: d.grams / 1000, color: d.color });
}

/** How big the shape it bumps with is, in words. */
function shapeWords(shape: PieceShape) {
  if (shape.kind === 'box') return `箱 ${shape.size.map(cm).join(' × ')} cm`;
  if (shape.kind === 'cylinder') return `筒 ふとさ ${cm(shape.r * 2)} cm・ながさ ${cm(shape.h)} cm`;
  return `玉 ふとさ ${cm(shape.r * 2)} cm`;
}

const STL_PROBLEM: Record<string, string> = {
  'too-big': 'STLファイルが大きすぎます。三角形300万こまでのファイルにしてください。',
  empty: 'STLファイルに形が入っていませんでした。',
  unreadable: 'STLファイルを読めませんでした。',
};

/** An STL file made ready for the maker: thinned, measured, and a size and weight to start from. */
async function readStlFile(file: File): Promise<Pick<Draft, 'stl' | 'size' | 'grams' | 'pick' | 'own'>> {
  if (file.size > MAX_FILE_BYTES) throw new StlError('too-big');
  const full = readStl(await file.arrayBuffer());
  const measure = measureMesh(full);
  const mesh = thinMesh(full);
  const longest = Math.max(...measure.size);
  // STL files are in millimeters, nearly always; a tiny one is taken to be in meters.
  const inMm = longest / 10;
  const size = clamp(Math.round((inMm >= 1 || longest * 100 > 30 ? inMm : longest * 100) * 2) / 2, SIDE_CM);
  const scale = size / 100 / longest;
  const [x, y, z] = measure.size.map((v) => v * scale);
  const volume = measure.volume > 0 ? measure.volume * scale ** 3 : x * y * z * 0.3;
  const grams = clamp(Math.round((volume * PRINTED_DENSITY * 1000) / 5) * 5, GRAMS);
  const name = file.name.replace(/\.stl$/i, '').trim().slice(0, MADE_LIMITS.name);
  return { stl: { file: name, mesh, measure, longest }, size, grams, pick: null, own: null };
}

interface Props {
  player: PlayerId;
  /** The part being changed, or none for a new one. */
  editing: MadePart | null;
  onSave: (part: MadePart) => void;
  onDelete: (() => void) | null;
  onClose: () => void;
}

/**
 * Making up a part: a box, a tube or a ball, how big, how heavy and what color. It goes in the
 * tray next to the everyday things and sticks on like them.
 */
export function PartMaker({ player, editing, onSave, onDelete, onClose }: Props) {
  const [draft, setDraft] = useState<Draft>(() => (editing ? draftOf(editing) : NEW_DRAFT));
  const made = useMemo(() => partOf(draft), [draft]);
  const part = made.part;
  const stl = draft.stl;
  const title = useId();
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState('');
  const [tuning, setTuning] = useState(false);

  // The shape it bumps with as the player may change it: their own, or the one it has now.
  const scale = stl ? draft.size / 100 / stl.longest : 1;
  const current = draft.own ?? (made.kind && made.fits?.[made.kind] ? ownOf(made.fits[made.kind]!, scale) : null);
  const tune = (patch: Partial<OwnShape>) => current && set('own', { ...current, ...patch, mine: true });
  /** Mesh units to centimeters and back, at the part's size. */
  const toCm = (v: number) => Math.round(v * scale * 1000) / 10;
  const fromCm = (v: number) => v / 100 / scale;
  const ownSlider = (label: string, value: number, range: readonly [number, number], onCm: (v: number) => void, unit = 'cm', step = 0.1) => (
    <label className="pm-slider" key={label}>
      <span className="pm-slider-name">{label}</span>
      <input type="range" min={range[0]} max={range[1]} step={step} value={value} onChange={(e) => onCm(Number(e.target.value))} />
      <span className="pm-slider-value">
        {value}
        {unit}
      </span>
    </label>
  );
  /** How far its middle may move from the look's middle: to the look's edge. */
  const reach = (k: number) => Math.max(1, Math.ceil(((stl?.measure.size[k] ?? 0) * scale * 100) / 2 * 10) / 10);
  const offset = (k: number) => (current && stl ? toCm(current.center[k] - stl.measure.mid[k]) : 0);
  const moveTo = (k: number, v: number) => {
    if (!current || !stl) return;
    const center = [...current.center] as Vec3;
    center[k] = stl.measure.mid[k] + fromCm(v);
    tune({ center });
  };

  const loadStl = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    setProblem('');
    // Let "よみこみ中" show before a big file holds the page up.
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      const read = await readStlFile(file);
      setDraft((d) => ({ ...d, ...read, name: d.name.trim() ? d.name : read.stl!.file }));
    } catch (err) {
      console.error(err);
      setProblem(STL_PROBLEM[err instanceof StlError ? err.problem : 'unreadable']);
    } finally {
      setReading(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const slider = (key: 'w' | 'h' | 'd' | 'across' | 'long' | 'grams' | 'size', label: string, range: readonly [number, number], step: number, unit: string) => (
    <label className="pm-slider">
      <span className="pm-slider-name">{label}</span>
      <input type="range" min={range[0]} max={range[1]} step={step} value={draft[key]} onChange={(e) => set(key, Number(e.target.value))} />
      <span className="pm-slider-value">
        {draft[key]}
        {unit}
      </span>
    </label>
  );

  return (
    <div className="pm-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pm-panel" role="dialog" aria-modal="true" aria-labelledby={title}>
        <h3 id={title} className="pm-title">
          {editing ? '部品をなおす' : '部品をつくる'}
        </h3>
        <div className="pm-body">
          <div className="pm-preview">
            <PartView part={part} player={player} outline={!!stl} />
            <span className="pm-preview-name">{part?.name ?? ''}</span>
            {stl && <span className="pm-preview-note">赤い線が ぶつかる形</span>}
            <span className="pm-preview-hint pm-hint-mouse">
              ドラッグで まわす・右ドラッグか Shift+ドラッグで うごかす・ホイールで ズーム・ダブルクリックで そこを まんなかに
            </span>
            <span className="pm-preview-hint pm-hint-touch">1本ゆびで まわす・2本ゆびで うごかす／ズーム・ダブルタップで まんなかに</span>
          </div>
          <div className="pm-fields">
            <label className="pm-name">
              <span className="g-label">なまえ</span>
              <input
                type="text"
                value={draft.name}
                maxLength={MADE_LIMITS.name}
                placeholder={`じぶんの${SHAPE_NAME[draft.shape]}`}
                onChange={(e) => set('name', e.target.value)}
              />
            </label>
            <div className="pm-stl">
              {stl ? (
                <>
                  <span className="pm-stl-file">
                    <FileIcon />
                    {stl.file || 'STLの形'}
                  </span>
                  <button type="button" className="g-button" onClick={() => setDraft((d) => ({ ...d, stl: null }))}>
                    STLをやめる
                  </button>
                </>
              ) : (
                <label className={`g-button pm-stl-load${reading ? ' pm-busy' : ''}`}>
                  <FileIcon />
                  {reading ? 'よみこみ中…' : 'STLファイルからつくる'}
                  <input
                    type="file"
                    accept=".stl,model/stl,application/sla"
                    disabled={reading}
                    onChange={(e) => {
                      void loadStl(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </label>
              )}
              {problem && (
                <span className="pm-problem" role="alert">
                  {problem}
                </span>
              )}
            </div>
            {stl && (
              <span className="g-label">
                {draft.own?.mine ? 'ぶつかる形（じぶんで なおした形）' : draft.own || draft.pick ? 'ぶつかる形' : 'ぶつかる形（じどうで えらびました）'}
              </span>
            )}
            <div className="pm-shapes" role="radiogroup" aria-label={stl ? 'ぶつかる形' : 'かたち'}>
              {SHAPES.map((s) => {
                const fits = !stl || !!made.fits?.[s.kind];
                const checked = stl ? made.kind === s.kind : draft.shape === s.kind;
                return (
                  <button
                    key={s.kind}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    disabled={!fits}
                    title={fits ? undefined : 'この大きさでは入りません'}
                    onClick={() => (stl ? setDraft((d) => ({ ...d, pick: s.kind, own: null })) : set('shape', s.kind))}
                  >
                    <ShapeIcon kind={s.kind} />
                    {s.label}
                    {stl && made.best === s.kind && <span className="pm-best">おすすめ</span>}
                  </button>
                );
              })}
            </div>
            {stl && part && (
              <div className="pm-fit-row">
                <span className="pm-fit">{shapeWords(part.shape)}</span>
                <button type="button" className="pm-link" aria-expanded={tuning} onClick={() => setTuning(!tuning)}>
                  {tuning ? 'とじる' : 'ぶつかる形をなおす'}
                </button>
              </div>
            )}
            {stl && tuning && current && (
              <div className="pm-own">
                {current.kind === 'cylinder' && (
                  <div className="pm-axes" role="radiogroup" aria-label="筒のむき">
                    {(
                      [
                        [1, 'たて'],
                        [2, 'まえうしろ'],
                        [0, 'よこ'],
                      ] as const
                    ).map(([axis, label]) => (
                      <button key={axis} type="button" role="radio" aria-checked={current.axis === axis} onClick={() => tune({ axis })}>
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                <span className="pm-own-head">大きさ</span>
                {current.kind === 'box' &&
                  (['よこ', 'たかさ', 'おくゆき'] as const).map((label, k) =>
                    ownSlider(label, toCm(current.size[k]), SIDE_CM, (v) => {
                      const size = [...current.size] as Vec3;
                      size[k] = fromCm(v);
                      tune({ size });
                    }),
                  )}
                {current.kind !== 'box' && ownSlider('ふとさ', toCm(current.r * 2), ACROSS_CM, (v) => tune({ r: fromCm(v) / 2 }))}
                {current.kind === 'cylinder' && ownSlider('ながさ', toCm(current.h), SIDE_CM, (v) => tune({ h: fromCm(v) }))}
                {current.kind === 'box' && (
                  <>
                    <span className="pm-own-head">かたむき（箱を まわす）</span>
                    {(['まえに たおす', 'よこに まわす', 'よこに たおす'] as const).map((label, k) =>
                      ownSlider(
                        label,
                        current.turn[k],
                        TILT,
                        (v) => {
                          const turn = [...current.turn] as Vec3;
                          turn[k] = v;
                          tune({ turn });
                        },
                        '°',
                        1,
                      ),
                    )}
                  </>
                )}
                <span className="pm-own-head">いち（まんなかから ずらす）</span>
                {(['左右', '上下', '前後'] as const).map((label, k) => ownSlider(label, offset(k), [-reach(k), reach(k)], (v) => moveTo(k, v)))}
                {draft.own && (
                  <button type="button" className="pm-link" onClick={() => setDraft((d) => ({ ...d, own: null, pick: null }))}>
                    じどうに もどす
                  </button>
                )}
              </div>
            )}
            <div className="pm-sliders">
              {stl && slider('size', 'おおきさ', SIDE_CM, 0.5, 'cm')}
              {!stl && draft.shape === 'box' && (
                <>
                  {slider('w', 'よこ', SIDE_CM, 0.5, 'cm')}
                  {slider('h', 'たかさ', SIDE_CM, 0.5, 'cm')}
                  {slider('d', 'おくゆき', SIDE_CM, 0.5, 'cm')}
                </>
              )}
              {!stl && draft.shape === 'cylinder' && (
                <>
                  {slider('across', 'ふとさ', ACROSS_CM, 0.5, 'cm')}
                  {slider('long', 'ながさ', SIDE_CM, 0.5, 'cm')}
                </>
              )}
              {!stl && draft.shape === 'ball' && slider('across', 'ふとさ', ACROSS_CM, 0.5, 'cm')}
              {slider('grams', 'おもさ', GRAMS, 5, 'g')}
            </div>
            <div className="pm-colors" role="radiogroup" aria-label="いろ">
              {COLORS.map(([c, name]) => (
                <button key={c} type="button" role="radio" aria-checked={draft.color === c} aria-label={name} title={name} style={{ background: c }} onClick={() => set('color', c)} />
              ))}
              <label className="pm-color-any" title="ほかのいろ">
                <input type="color" value={draft.color.toLowerCase()} onChange={(e) => set('color', e.target.value.toUpperCase())} aria-label="ほかのいろ" />
              </label>
            </div>
          </div>
        </div>
        <div className="pm-actions">
          <div className="pm-actions-side">
            {onDelete && (
              <button type="button" className="g-button g-danger" onClick={onDelete}>
                すてる
              </button>
            )}
            <button type="button" className="g-button" disabled={!part} title="ほかの端末や友だちに渡せるファイルにします" onClick={() => part && exportParts([part], part.name)}>
              ファイルに書き出す
            </button>
          </div>
          <button type="button" className="g-button" onClick={onClose}>
            やめる
          </button>
          <button type="button" className="g-button g-go" disabled={!part} onClick={() => part && onSave(part)}>
            {editing ? 'なおす' : 'つくる！'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FileIcon() {
  return (
    <svg className="pm-shape-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 3 H14 L19 8 V21 H6 Z M14 3 V8 H19 M9 15 L12 11 L15 15 L12 18 Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function ShapeIcon({ kind }: { kind: ShapeKind }) {
  return (
    <svg className="pm-shape-icon" viewBox="0 0 24 24" aria-hidden="true">
      {kind === 'box' && <path d="M4 8 L12 4 L20 8 V16 L12 20 L4 16 Z M4 8 L12 12 L20 8 M12 12 V20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />}
      {kind === 'cylinder' && (
        <g fill="none" stroke="currentColor" strokeWidth="1.8">
          <ellipse cx="12" cy="6" rx="6" ry="2.5" />
          <path d="M6 6 V18 A6 2.5 0 0 0 18 18 V6" />
        </g>
      )}
      {kind === 'ball' && (
        <g fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="8" />
          <path d="M4.5 10.5 A8 3 0 0 0 19.5 10.5" />
        </g>
      )}
    </svg>
  );
}
