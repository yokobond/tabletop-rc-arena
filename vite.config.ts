import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The ESM build of A-Frame expects an import map for `three`; the UMD build bundles it.
      aframe: fileURLToPath(new URL('./node_modules/aframe/dist/aframe-master.min.js', import.meta.url)),
    },
  },
  build: { chunkSizeWarningLimit: 2000 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
