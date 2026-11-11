import { useEffect } from 'react';
import { getState, pauseIfRunning, useGame } from '../runtime/store';
import { ArHint } from './ArPanel';
import { Dock } from './Dock';
import { GameScene } from './GameScene';
import { CenterMessages, Scoreboard } from './Hud';
import { PauseOverlay, TitleOverlay, WinnerOverlay } from './Overlays';
import { TouchPads } from './TouchPads';

export function App() {
  const phase = useGame((s) => s.phase);
  const paused = useGame((s) => s.paused);
  const settingsOpen = useGame((s) => s.settingsOpen);
  const touchControls = useGame((s) => s.touchControls);
  const arActive = useGame((s) => s.arActive);

  useEffect(() => {
    const onVisibility = () => {
      // Some headsets report the page as hidden during a session; vr-session watches the XR session instead.
      if (document.hidden && !getState().vrActive && getState().online.status !== 'on') pauseIfRunning();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const inMatch = phase !== 'idle';
  return (
    <div className={`app ${arActive ? 'is-ar' : ''}`}>
      {/* The rear camera's picture, behind the scene; ar-session feeds it. */}
      <video className="ar-video" playsInline muted hidden={!arActive} />
      <GameScene />
      <ArHint />
      {inMatch && (
        <>
          <Scoreboard />
          <CenterMessages />
          {touchControls && phase !== 'finished' && !paused && <TouchPads />}
          {phase !== 'finished' && <Dock />}
        </>
      )}
      {phase === 'idle' && <TitleOverlay />}
      {paused && !settingsOpen && <PauseOverlay />}
      {phase === 'finished' && <WinnerOverlay />}
    </div>
  );
}
