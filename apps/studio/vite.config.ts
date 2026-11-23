/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Studio talks to @xo/api over HTTP only. @xo/api sends no CORS headers, so in
 * development the browser calls same-origin `/api/*` and Vite forwards it to the
 * API (prefix stripped). Production needs the same shape: serve the built app and
 * reverse-proxy `/api` to the API. No platform code is changed to make this work.
 */
const apiTarget = process.env['XO_API_URL'] ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react()],
  // The web build starts from index.html only. Without this, Vite also scans the desktop entry and warns
  // about Tauri packages the web app never loads.
  optimizeDeps: { entries: ['index.html'] },
  // S1-3 (budgets): React is its own long-lived chunk, so a Studio change does not invalidate it and the entry stays small.
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => (/node_modules\/(react|react-dom|scheduler)\//.test(id) ? 'react' : undefined),
      },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: apiTarget, changeOrigin: false, rewrite: (p) => p.replace(/^\/api/, '') } },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
