import '@fontsource/chakra-petch/500.css';
import '@fontsource/chakra-petch/700.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/700.css';
import './ui/styles.css';
// Registers the custom elements and components before React renders <a-scene>.
import './aframe/components';
import { createRoot } from 'react-dom/client';
import { initPhysics } from './game/physics';
import { urlHasSession } from './net/session';
import { goOnline, initStore } from './runtime/store';
import { App } from './ui/App';

// Rapier (WebAssembly) has to be ready before any world exists, local or replicated.
void initPhysics().then(() => {
  initStore();
  createRoot(document.getElementById('root')!).render(<App />);
  // A shared link (?q=...#pw=...) joins that session right away.
  if (urlHasSession()) goOnline();
});
