import type { PlayerId } from '../game/types';
import { TOP_SPEED_KMH_SCALE, playerName, useGame } from '../runtime/store';

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
