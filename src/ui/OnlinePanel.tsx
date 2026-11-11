import { useState } from 'react';
import { goOffline, goOnline, useGame } from '../runtime/store';
import { QrCode } from './QrCode';

const SEAT_LABEL = { p1: '1P（赤）', p2: '2P（シアン）' } as const;

/** Title-screen block for joining, sharing and leaving an online session. */
export function OnlinePanel() {
  const online = useGame((s) => s.online);
  const [copied, setCopied] = useState(false);

  if (online.status !== 'on') {
    return (
      <div className="online-panel">
        <button
          type="button"
          className="secondary-button online-button"
          onClick={goOnline}
          disabled={online.status === 'connecting'}
        >
          {online.status === 'connecting' ? '接続中…' : 'オンライン対戦'}
        </button>
        {online.error && (
          <p className="online-note online-error" role="alert">
            {online.error}
          </p>
        )}
      </div>
    );
  }

  const copy = () => {
    void navigator.clipboard?.writeText(online.url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="online-panel is-on">
      <div className="online-status">
        <span className="online-dot" aria-hidden="true" />
        <span>
          オンライン · {online.viewers}人 · あなたは
          <strong>{online.seat ? SEAT_LABEL[online.seat] : '観戦'}</strong>
        </span>
      </div>
      <div className="online-invite">
        <QrCode text={online.url} label="招待リンクのQRコード" />
        <p className="online-note">
          相手のスマホでQRを読み取るか、リンクを送ると同じ机に入ります。最初の2人が運転し、3人目からは観戦、空いた席はCPUが走ります。
        </p>
      </div>
      <div className="online-share">
        <input className="online-url" readOnly value={online.url} aria-label="招待リンク" onFocus={(e) => e.target.select()} />
        <button type="button" className="secondary-button online-copy" onClick={copy}>
          {copied ? 'コピー済み' : 'コピー'}
        </button>
      </div>
      <button type="button" className="text-button" onClick={goOffline}>
        オンラインをやめる
      </button>
    </div>
  );
}
