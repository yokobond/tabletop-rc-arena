import type { PlayerId } from '../game/types';
import { TOP_SPEED_KMH_SCALE, playerName, useGame, type GameState } from '../runtime/store';
import { KeyCap } from './controls';

const CAR_LABEL: Record<PlayerId, string> = { p1: '赤い車', p2: '水色の車' };

function usePlayerName(player: PlayerId) {
  return useGame((s) => playerName(s, player));
}

function CarPanel({ player }: { player: PlayerId }) {
  const t = useGame((s) => s.carTelemetry[player]);
  const name = usePlayerName(player);
  // Nobody comes back once the match is decided.
  const decided = useGame((s) => s.phase === 'finishing' || s.phase === 'finished');
  const status =
    decided
      ? null
      : t.status !== 'driving'
      ? { label: `復帰 ${Math.max(1, Math.ceil(t.respawnIn))}`, kind: 'out' }
      : t.invulnerable
        ? { label: '無敵', kind: 'ghost' }
        : t.boosting
          ? { label: 'BOOST', kind: 'boost' }
          : null;
  return (
    <div className={`car-panel car-${player}`}>
      <div className="car-panel-top">
        <span className="car-name">{name}</span>
        {status ? (
          <span className={`car-status status-${status.kind}`}>{status.label}</span>
        ) : (
          <span className="car-speed">
            {Math.round(t.speed * TOP_SPEED_KMH_SCALE)}
            <small>km/h</small>
          </span>
        )}
      </div>
      <div
        className="gauge"
        role="meter"
        aria-label={`${name} ブースト残量`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(t.boost)}
      >
        <div className={`gauge-fill ${t.boosting ? 'is-boosting' : ''}`} style={{ transform: `scaleX(${t.boost / 100})` }} />
      </div>
    </div>
  );
}

export function Scoreboard() {
  const p1 = useGame((s) => s.scores.p1);
  const p2 = useGame((s) => s.scores.p2);
  const target = useGame((s) => s.targetScore);
  return (
    <header className="scoreboard">
      <CarPanel player="p1" />
      <div className="score-center">
        <span className="score score-p1">{p1}</span>
        <span className="score-target">{target > 0 ? `TO ${target}` : 'FREE'}</span>
        <span className="score score-p2">{p2}</span>
      </div>
      <CarPanel player="p2" />
    </header>
  );
}

type ControlKind =
  | 'remote'
  | 'cpu'
  | 'vr'
  | 'pad-left'
  | 'pad-right'
  | 'pad-side-left'
  | 'pad-side-right'
  | 'propo-bottom'
  | 'propo-top'
  | 'propo-left'
  | 'propo-right'
  | 'keys-both'
  | 'keys-p1'
  | 'keys-p2';

/** What drives this car on this screen. A string, so the store selector stays stable. */
function controlKind(s: GameState, player: PlayerId): ControlKind {
  const online = s.online.status === 'on';
  const local = online ? s.online.seat === player : player === 'p1' || s.mode === 'pvp';
  if (!local) return online && s.online.humans[player] ? 'remote' : 'cpu';
  if (player === 'p1' && s.vrActive) return 'vr';
  if (s.touchControls) {
    const twoPads = !online && s.mode === 'pvp';
    if (s.touchStyle === 'propo') {
      if (!twoPads) return 'propo-bottom';
      if (s.touchLayout === 'facing') return player === 'p1' ? 'propo-bottom' : 'propo-top';
      return player === 'p1' ? 'propo-left' : 'propo-right';
    }
    if (!twoPads) return 'pad-left';
    if (s.touchLayout === 'facing') return player === 'p1' ? 'pad-side-left' : 'pad-side-right';
    return player === 'p1' ? 'pad-left' : 'pad-right';
  }
  // CPU matches and online play accept either side of the keyboard.
  if (online || s.mode === 'cpu') return 'keys-both';
  return player === 'p1' ? 'keys-p1' : 'keys-p2';
}

function ControlsLabel({ kind }: { kind: ControlKind }) {
  switch (kind) {
    case 'remote':
      return <>相手プレイヤー</>;
    case 'cpu':
      return <>CPU が運転</>;
    case 'vr':
      return <>VR コントローラー</>;
    case 'pad-left':
      return <>左下のパッド</>;
    case 'pad-right':
      return <>右下のパッド</>;
    case 'propo-bottom':
      return <>下側のプロポ</>;
    case 'propo-top':
      return <>上側のプロポ</>;
    case 'propo-left':
      return <>左半分のプロポ</>;
    case 'propo-right':
      return <>右半分のプロポ</>;
    case 'pad-side-left':
      return <>左側のパッド</>;
    case 'pad-side-right':
      return <>右側のパッド</>;
    case 'keys-p2':
      return (
        <>
          <KeyCap>↑</KeyCap>
          <KeyCap>←</KeyCap>
          <KeyCap>↓</KeyCap>
          <KeyCap>→</KeyCap> + <KeyCap>Enter</KeyCap>
        </>
      );
    default:
      return (
        <>
          <KeyCap>W</KeyCap>
          <KeyCap>A</KeyCap>
          <KeyCap>S</KeyCap>
          <KeyCap>D</KeyCap>
          {kind === 'keys-both' && '/ 矢印 '}+ <KeyCap>Space</KeyCap>
        </>
      );
  }
}

function Assignment({ player }: { player: PlayerId }) {
  const name = useGame((s) => playerName(s, player));
  const kind = useGame((s) => controlKind(s, player));
  return (
    <div className={`assign assign-${player}`}>
      <span className="assign-tag">{name}</span>
      <span className="assign-car">{CAR_LABEL[player]}</span>
      <span className="assign-controls">
        <ControlsLabel kind={kind} />
      </span>
    </div>
  );
}

/** Shown during the countdown: who drives which car, and with what. */
function AssignmentCard() {
  return (
    <div className="assignment" aria-label="操作の割り当て">
      <Assignment player="p1" />
      <Assignment player="p2" />
    </div>
  );
}

export function CenterMessages() {
  const phase = useGame((s) => s.phase);
  const paused = useGame((s) => s.paused);
  const countdown = useGame((s) => s.countdown);
  const showGo = useGame((s) => s.showGo);
  const banner = useGame((s) => s.banner);
  const p1 = usePlayerName('p1');
  const p2 = usePlayerName('p2');
  const nameOf = (id: PlayerId) => (id === 'p1' ? p1 : p2);

  return (
    <div className="center-messages" aria-live="polite">
      {phase === 'countdown' && !paused && (
        <div className="count" key={Math.ceil(countdown)}>
          {Math.max(1, Math.ceil(countdown))}
        </div>
      )}
      {phase === 'countdown' && !paused && <AssignmentCard />}
      {showGo && !paused && <div className="count count-go">GO!</div>}
      {banner && !paused && (
        <div className={`banner banner-${banner.scoredBy ?? banner.player}`} key={banner.id}>
          <span className="banner-main">{nameOf(banner.player)} 落下！</span>
          {banner.scoredBy && <span className="banner-sub">{nameOf(banner.scoredBy)} +1 POINT</span>}
        </div>
      )}
    </div>
  );
}
