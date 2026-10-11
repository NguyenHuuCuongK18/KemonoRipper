import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  root: 'src', base: './', publicDir: false,
  build: {
    outDir: '../dist', emptyOutDir: true, target: 'chrome120',
    rollupOptions: { input: { overlay: resolve('src/overlay/index.html'), popup: resolve('src/popup/index.html'), dashboard: resolve('src/dashboard/index.html'), folder: resolve('src/folder/index.html'), offscreen: resolve('src/offscreen/index.html') } },
  },
});
