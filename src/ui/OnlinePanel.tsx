import { useState } from 'react';
import { goOffline, goOnline, passArenaMaster, setArenaOpen, setShareDesign, useGame } from '../runtime/store';
import { Segmented } from './controls';
import { QrCode } from './QrCode';

const SEAT_LABEL = { p1: '1P（赤）', p2: '2P（シアン）' } as const;
const ARENA_ACCESS = [
  { value: 'master', label: 'マスターだけ' },
  { value: 'all', label: '全員' },
];
const SHARE_DESIGN_OPTIONS = [
  { value: 'off', label: '提供しない' },
  { value: 'on', label: '相手に提供' },
];

/** Title-screen block for joining, sharing and leaving an online session. */
export function OnlinePanel() {
  const online = useGame((s) => s.online);
  const shareDesign = useGame((s) => s.shareDesign);
  const [copied, setCopied] = useState(false);
  const arena = online.arena;

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
      <div className="arena-access">
        <Segmented
          label="自分の車体"
          value={shareDesign ? 'on' : 'off'}
          options={SHARE_DESIGN_OPTIONS}
          onChange={(v) => setShareDesign(v === 'on')}
        />
        <p className="online-note">
          アリーナマスター: <strong>{arena.isMaster ? 'あなた' : arena.master}</strong>
          {arena.open ? '（いまは全員がアリーナを編集できます）' : ''}
        </p>
        {arena.isMaster && (
          <>
            <Segmented
              label="アリーナ編集"
              value={arena.open ? 'all' : 'master'}
              options={ARENA_ACCESS}
              onChange={(v) => setArenaOpen(v === 'all')}
            />
            {arena.others.length > 0 && (
              <div className="field">
                <span className="field-label" id="arena-pass">
                  マスターを渡す
                </span>
                <div className="arena-buttons" role="group" aria-labelledby="arena-pass">
                  {arena.others.map((other) => (
                    <button key={other.viewId} type="button" className="segment" onClick={() => passArenaMaster(other.viewId)}>
                      {other.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <button type="button" className="text-button" onClick={goOffline}>
        オンラインをやめる
      </button>
    </div>
  );
}
