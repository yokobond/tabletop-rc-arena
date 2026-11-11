import { useState } from 'react';
import type { CameraPreset } from '../game/types';
import {
  backToTitle,
  enterVr,
  type TouchStyle,
  setCameraPreset,
  startMatch,
  toggleAr,
  togglePause,
  updateSettings,
  useGame,
} from '../runtime/store';
import { ArPanel } from './ArPanel';
import { ControlsHelp, Segmented } from './controls';
import { RuleFields } from './RuleFields';

const CAMERAS: { value: CameraPreset; label: string }[] = [
  { value: 'high', label: 'ハイアングル' },
  { value: 'angled', label: 'クォーター' },
  { value: 'low', label: 'サイド' },
];

const STYLES: { value: TouchStyle; label: string }[] = [
  { value: 'propo', label: 'プロポ' },
  { value: 'stick', label: 'スティック' },
];

export function Dock() {
  const [open, setOpen] = useState(false);
  const cameraPreset = useGame((s) => s.cameraPreset);
  const cameraHeight = useGame((s) => s.cameraHeight);
  const cameraAngle = useGame((s) => s.cameraAngle);
  const sound = useGame((s) => s.sound);
  const touchControls = useGame((s) => s.touchControls);
  const touchLayout = useGame((s) => s.touchLayout);
  const touchStyle = useGame((s) => s.touchStyle);
  const mode = useGame((s) => s.mode);
  const paused = useGame((s) => s.paused);
  const vrSupported = useGame((s) => s.vrSupported);
  const arSupported = useGame((s) => s.arSupported);
  const arActive = useGame((s) => s.arActive);
  const online = useGame((s) => s.online.status === 'on');
  // Local two-player matches show a pad per player, each with its own controller.
  const twoPads = mode === 'pvp' && !online;

  return (
    <footer className={`dock ${open ? 'is-open' : ''}`}>
      {open && (
        <div className="dock-panel" id="dock-panel">
          <div className="dock-grid">
            <RuleFields />
            {/* In AR the view is wherever the device is held. */}
            {!arActive && (
              <>
                <Segmented label="カメラ" value={cameraPreset} options={CAMERAS} onChange={setCameraPreset} />
                <label className="field">
                  <span className="field-label">高さ</span>
                  <input
                    type="range"
                    min={-1}
                    max={1}
                    step={0.02}
                    value={cameraHeight}
                    onChange={(e) => updateSettings({ cameraHeight: Number(e.target.value) })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">角度</span>
                  <input
                    type="range"
                    min={-180}
                    max={180}
                    step={2}
                    value={cameraAngle}
                    onChange={(e) => updateSettings({ cameraAngle: Number(e.target.value) })}
                  />
                </label>
              </>
            )}
            <Segmented
              label="効果音"
              value={sound ? 'on' : 'off'}
              options={[
                { value: 'on', label: 'ON' },
                { value: 'off', label: 'OFF' },
              ]}
              onChange={(v) => updateSettings({ sound: v === 'on' })}
            />
            <Segmented
              label="タッチ操作"
              value={touchControls ? 'on' : 'off'}
              options={[
                { value: 'on', label: '表示' },
                { value: 'off', label: '非表示' },
              ]}
              onChange={(v) => updateSettings({ touchControls: v === 'on' })}
            />
            {touchControls &&
              (twoPads ? (['p1', 'p2'] as const) : (['p1'] as const)).map((player) => (
                <Segmented
                  key={player}
                  label={twoPads ? `${player === 'p1' ? '1P' : '2P'}の操作方式` : '操作方式'}
                  value={touchStyle[player]}
                  options={STYLES}
                  onChange={(v) => updateSettings({ touchStyle: { ...touchStyle, [player]: v } })}
                />
              ))}
            {touchControls && twoPads && (
              <Segmented
                label="2P配置"
                value={touchLayout}
                options={[
                  { value: 'side', label: '横並び' },
                  { value: 'facing', label: '対面' },
                ]}
                onChange={(v) => updateSettings({ touchLayout: v })}
              />
            )}
          </div>
          <ArPanel />
          <ControlsHelp />
        </div>
      )}
      <div className="dock-bar">
        <button type="button" className="dock-button" aria-expanded={open} aria-controls="dock-panel" onClick={() => setOpen(!open)}>
          {open ? '閉じる' : '設定'}
        </button>
        <button type="button" className="dock-button" onClick={togglePause}>
          {paused ? '再開' : '一時停止'}
        </button>
        <button
          type="button"
          className="dock-button"
          onClick={() => {
            setOpen(false);
            startMatch();
          }}
        >
          リセット
        </button>
        <button type="button" className="dock-button" onClick={backToTitle}>
          タイトル
        </button>
        {arSupported && (
          <button type="button" className="dock-button" aria-pressed={arActive} onClick={toggleAr}>
            AR
          </button>
        )}
        {vrSupported && (
          <button type="button" className="dock-button" onClick={() => enterVr(false)}>
            VR
          </button>
        )}
      </div>
    </footer>
  );
}
