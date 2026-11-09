import { useState } from 'react';
import type { CameraPreset } from '../game/types';
import { backToTitle, enterVr, setCameraPreset, startMatch, togglePause, updateSettings, useGame } from '../runtime/store';
import { ControlsHelp, Segmented } from './controls';
import { RuleFields } from './RuleFields';

const CAMERAS: { value: CameraPreset; label: string }[] = [
  { value: 'high', label: 'ハイアングル' },
  { value: 'angled', label: 'クォーター' },
  { value: 'low', label: 'サイド' },
];

export function Dock() {
  const [open, setOpen] = useState(false);
  const cameraPreset = useGame((s) => s.cameraPreset);
  const cameraHeight = useGame((s) => s.cameraHeight);
  const cameraAngle = useGame((s) => s.cameraAngle);
  const sound = useGame((s) => s.sound);
  const touchControls = useGame((s) => s.touchControls);
  const touchLayout = useGame((s) => s.touchLayout);
  const mode = useGame((s) => s.mode);
  const paused = useGame((s) => s.paused);
  const vrSupported = useGame((s) => s.vrSupported);
  const online = useGame((s) => s.online.status === 'on');

  return (
    <footer className={`dock ${open ? 'is-open' : ''}`}>
      {open && (
        <div className="dock-panel" id="dock-panel">
          <div className="dock-grid">
            <RuleFields />
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
            {touchControls && mode === 'pvp' && !online && (
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
        {vrSupported && (
          <button type="button" className="dock-button" onClick={() => enterVr(false)}>
            VR
          </button>
        )}
      </div>
    </footer>
  );
}
