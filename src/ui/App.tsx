import { useEffect } from 'react';
import { getState, pauseIfRunning, useGame } from '../runtime/store';
import { Dock } from './Dock';
import { GameScene } from './GameScene';
import { CenterMessages, Scoreboard } from './Hud';
import { PauseOverlay, TitleOverlay, WinnerOverlay } from './Overlays';
import { TouchPads } from './TouchPads';

export function App() {
  const phase = useGame((s) => s.phase);
  const paused = useGame((s) => s.paused);
  const touchControls = useGame((s) => s.touchControls);

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
    <div className="app">
      <GameScene />
      {inMatch && (
        <>
          <Scoreboard />
          <CenterMessages />
          {touchControls && phase !== 'finished' && !paused && <TouchPads />}
          {phase !== 'finished' && <Dock />}
        </>
      )}
      {phase === 'idle' && <TitleOverlay />}
      {paused && <PauseOverlay />}
      {phase === 'finished' && <WinnerOverlay />}
    </div>
  );
}
