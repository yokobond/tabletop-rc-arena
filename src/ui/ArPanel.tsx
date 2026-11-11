import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AR_SIZES, markerSvg, type ArSize } from '../ar/marker';
import { toggleAr, updateSettings, useGame } from '../runtime/store';
import { Segmented } from './controls';

const SIZES = AR_SIZES.map((value) => ({ value, label: `${value}倍` }));

/** The marker on a white page, to print or to show on another screen laid on the table. */
function MarkerSheet({ onClose }: { onClose: () => void }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let live = true;
    void markerSvg().then((s) => live && setSvg(s));
    return () => {
      live = false;
    };
  }, []);
  // On the body: the cards it is opened from blur their backdrop, which would trap a fixed element inside them.
  return createPortal(
    <div className="marker-sheet" role="dialog" aria-label="ARマーカー">
      {/* Generated here by the marker library, not user content. */}
      <div className="marker-image" dangerouslySetInnerHTML={{ __html: svg }} />
      <p className="marker-caption">RC SUMO ARENA のARマーカー（上が奥）。テーブルの中央に平らに置きます。</p>
      <div className="button-row marker-actions">
        <button type="button" className="secondary-button" onClick={() => window.print()}>
          印刷
        </button>
        <button type="button" className="secondary-button" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** AR is a way of looking at the table on this device, so drivers and spectators both get it. */
export function ArPanel() {
  const supported = useGame((s) => s.arSupported);
  const active = useGame((s) => s.arActive);
  const error = useGame((s) => s.arError);
  const size = useGame((s) => s.arSize);
  const [sheet, setSheet] = useState(false);
  if (!supported) return null;
  return (
    <div className="ar-panel">
      <button type="button" className="secondary-button vr-button" aria-pressed={active} onClick={toggleAr}>
        {active ? 'AR表示を終了' : 'AR表示（カメラ）'}
      </button>
      {active && (
        <Segmented<ArSize> label="ARの大きさ" value={size} options={SIZES} onChange={(arSize) => updateSettings({ arSize })} />
      )}
      <p className="vr-note">
        マーカーを印刷してテーブルの中央に置き、カメラで映すと、その上にアリーナが現れます。
        {active && 'テーブルの幅がマーカーの何倍かを選びます。同じテーブルを囲む人は同じ倍率にしてください。'}
      </p>
      {error && (
        <p className="vr-note vr-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="text-button" onClick={() => setSheet(true)}>
        マーカーを表示・印刷
      </button>
      {sheet && <MarkerSheet onClose={() => setSheet(false)} />}
    </div>
  );
}

/** Asks for the marker while it is not in the picture. */
export function ArHint() {
  const lost = useGame((s) => s.arActive && !s.arTracking);
  if (!lost) return null;
  return (
    <p className="ar-hint" role="status">
      マーカーをカメラに映してください
    </p>
  );
}
