import type { PlayerId } from '../game/types';
import { backToTitle, enterVr, playerName, startMatch, togglePause, useGame } from '../runtime/store';
import { ArPanel } from './ArPanel';
import { ControlsHelp } from './controls';
import { OnlinePanel } from './OnlinePanel';
import { RuleFields } from './RuleFields';

export function TitleOverlay() {
  const vrSupported = useGame((s) => s.vrSupported);
  const vrError = useGame((s) => s.vrError);
  const mode = useGame((s) => s.mode);
  const online = useGame((s) => s.online.status === 'on');
  return (
    <div className="overlay">
      <section className="modal title-card" aria-labelledby="game-title">
        <p className="eyebrow">TABLETOP RC BATTLE</p>
        <h1 id="game-title">
          RC <span className="title-accent">SUMO</span> ARENA
        </h1>
        <p className="lead">机の上のリモコンカー相撲。体当たりで相手をテーブルから突き落とせ。</p>
        <div className="title-fields">
          <RuleFields />
        </div>
        <OnlinePanel />
        <button type="button" className="primary-button" onClick={startMatch} autoFocus>
          {online ? 'みんなでバトル開始' : 'バトル開始'}
        </button>
        {vrSupported && (
          <button type="button" className="secondary-button vr-button" onClick={() => enterVr(true)}>
            VRで開始
          </button>
        )}
        {vrSupported && mode === 'pvp' && !online && (
          <p className="vr-note">VRの人が1Pです。2Pはキーボードで操作するので、一体型ヘッドセットならCPU戦がおすすめです。</p>
        )}
        {vrError && (
          <p className="vr-note vr-error" role="alert">
            {vrError}
          </p>
        )}
        <ArPanel />
        <ControlsHelp />
      </section>
    </div>
  );
}

export function PauseOverlay() {
  return (
    <div className="overlay">
      <section className="modal small-card" aria-labelledby="pause-title">
        <h2 id="pause-title">一時停止</h2>
        <button type="button" className="primary-button" onClick={togglePause} autoFocus>
          再開
        </button>
        <div className="button-row">
          <button type="button" className="secondary-button" onClick={startMatch}>
            最初から
          </button>
          <button type="button" className="secondary-button" onClick={backToTitle}>
            タイトルへ
          </button>
        </div>
        <ControlsHelp />
      </section>
    </div>
  );
}

export function WinnerOverlay() {
  const winner = useGame((s) => s.winner) as PlayerId;
  const scores = useGame((s) => s.scores);
  const mode = useGame((s) => s.mode);
  const difficulty = useGame((s) => s.cpuDifficulty);
  const online = useGame((s) => s.online.status === 'on');
  const name = useGame((s) => playerName(s, winner));
  return (
    <div className="overlay">
      <section className={`modal small-card winner-card winner-${winner}`} aria-labelledby="winner-title">
        <p className="eyebrow">{online ? 'ONLINE MATCH' : mode === 'cpu' ? `VS CPU ${difficulty.toUpperCase()}` : 'MATCH RESULT'}</p>
        <h2 id="winner-title">{name} WIN!</h2>
        <p className="final-score">
          <span className="score-p1">{scores.p1}</span>
          <span className="final-dash">-</span>
          <span className="score-p2">{scores.p2}</span>
        </p>
        <button type="button" className="primary-button" onClick={startMatch} autoFocus>
          リマッチ
        </button>
        <button type="button" className="secondary-button" onClick={backToTitle}>
          設定を変える
        </button>
      </section>
    </div>
  );
}
