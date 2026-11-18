import { useEffect } from 'react';
import { getState, pauseIfRunning, useGame } from '../runtime/store';
import { ArenaEditor } from './ArenaEditor';
import { ArHint } from './ArPanel';
import { Dock } from './Dock';
import { GameScene } from './GameScene';
import { Garage } from './Garage';
import { CenterMessages, Scoreboard } from './Hud';
import { PauseOverlay, TitleOverlay, WinnerOverlay } from './Overlays';
import { TouchPads } from './TouchPads';

export function App() {
  const phase = useGame((s) => s.phase);
  const paused = useGame((s) => s.paused);
  const settingsOpen = useGame((s) => s.settingsOpen);
  const touchControls = useGame((s) => s.touchControls);
  const arActive = useGame((s) => s.arActive);
  const editing = useGame((s) => s.editing);
  const garage = useGame((s) => s.garage);

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
    <div className={`app ${arActive ? 'is-ar' : ''} ${editing ? 'is-editing' : ''}`}>
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
      {/* Editing happens on the table itself, so the title makes way for a panel below it. */}
      {phase === 'idle' && (garage ? <Garage /> : editing ? <ArenaEditor /> : <TitleOverlay />)}
      {paused && !settingsOpen && <PauseOverlay />}
      {phase === 'finished' && <WinnerOverlay />}
    </div>
  );
}
