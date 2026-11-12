// UNVERIFIED: desktop frontend build. Same React app, desktop entry, relative asset base.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'desktop',
  base: './',
  plugins: [react()],
  server: { port: 5174, strictPort: true },
  build: { outDir: '../dist-desktop', emptyOutDir: true, target: 'es2022' },
});
