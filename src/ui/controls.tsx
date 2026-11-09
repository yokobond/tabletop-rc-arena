import type { ReactNode } from 'react';
import { useGame } from '../runtime/store';

export interface SegmentOption<T extends string | number> {
  value: T;
  label: string;
}

export function Segmented<T extends string | number>(props: {
  label: string;
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="field">
      <span className="field-label" id={`seg-${props.label}`}>
        {props.label}
      </span>
      <div className="segmented" role="group" aria-labelledby={`seg-${props.label}`}>
        {props.options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            className="segment"
            aria-pressed={o.value === props.value}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function KeyCap({ children }: { children: ReactNode }) {
  return <kbd className="keycap">{children}</kbd>;
}

export function ControlsHelp() {
  const vrSupported = useGame((s) => s.vrSupported);
  return (
    <div className="help">
      <div className="help-player help-p1">
        <strong>1P</strong>
        <span>
          <KeyCap>W</KeyCap>
          <KeyCap>A</KeyCap>
          <KeyCap>S</KeyCap>
          <KeyCap>D</KeyCap> 走行
        </span>
        <span>
          <KeyCap>Space</KeyCap> ブースト
        </span>
      </div>
      <div className="help-player help-p2">
        <strong>2P</strong>
        <span>
          <KeyCap>↑</KeyCap>
          <KeyCap>←</KeyCap>
          <KeyCap>↓</KeyCap>
          <KeyCap>→</KeyCap> 走行
        </span>
        <span>
          <KeyCap>Enter</KeyCap>
          <KeyCap>Shift</KeyCap> ブースト
        </span>
      </div>
      {vrSupported && (
        <p className="help-note">
          VR: スティックで走行、トリガーでブースト、スティック押し込みで視点リセット、B / Y で一時停止。
        </p>
      )}
      <p className="help-note">
        相手をテーブルの端から突き落とすと1点。<KeyCap>Esc</KeyCap> で一時停止。
      </p>
    </div>
  );
}
