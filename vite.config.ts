import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import type { EnvironmentModuleNode, Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * js-aruco2 exports through a top-level `this`, which is `module.exports` in Node but undefined
 * once a bundler has wrapped the file.
 */
const arucoExports = {
  name: 'js-aruco2-exports',
  transform(code: string, id: string) {
    if (!/js-aruco2[\\/]src[\\/]/.test(id)) return null;
    return { code: code.replace(/\bthis\.(AR|CV|POS|SVD)\b/g, 'exports.$1'), map: null };
  },
};

/**
 * Croquet cannot take a module swapped in under a running session: re-running the model module
 * registers `SumoModel` a second time, and re-running the session module loses the session.
 * So a change that reaches `src/net/` through its imports (the model, the engine, physics, ...)
 * reloads the page instead of hot-swapping it. UI-only changes keep React Fast Refresh;
 * `src/net/session.ts` also reloads on any update while the page is online.
 */
const croquetFullReload: Plugin = {
  name: 'croquet-full-reload',
  apply: 'serve',
  hotUpdate({ modules }) {
    if (this.environment.name !== 'client') return;
    const seen = new Set<EnvironmentModuleNode>();
    const reachesCroquet = (mod: EnvironmentModuleNode): boolean => {
      if (seen.has(mod)) return false;
      seen.add(mod);
      if (mod.file && /[\\/]src[\\/]net[\\/]/.test(mod.file)) return true;
      return [...mod.importers].some(reachesCroquet);
    };
    if (!modules.some(reachesCroquet)) return;
    this.environment.hot.send({ type: 'full-reload' });
    return [];
  },
};

// `--mode https` serves over HTTPS with a self-signed certificate: a phone on the LAN only gets
// the camera (AR) on a secure page.
export default defineConfig(({ mode }) => ({
  plugins: [react(), arucoExports, croquetFullReload, ...(mode === 'https' ? [basicSsl()] : [])],
  optimizeDeps: { rolldownOptions: { plugins: [arucoExports] } },
  resolve: {
    alias: {
      // The ESM build of A-Frame expects an import map for `three`; the UMD build bundles it.
      aframe: fileURLToPath(new URL('./node_modules/aframe/dist/aframe-master.min.js', import.meta.url)),
    },
  },
  build: { chunkSizeWarningLimit: 2000 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
}));
