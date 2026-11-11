import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
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

// `--mode https` serves over HTTPS with a self-signed certificate: a phone on the LAN only gets
// the camera (AR) on a secure page.
export default defineConfig(({ mode }) => ({
  plugins: [react(), arucoExports, ...(mode === 'https' ? [basicSsl()] : [])],
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
