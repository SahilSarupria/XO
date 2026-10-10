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
