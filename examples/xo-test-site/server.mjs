#!/usr/bin/env node
/**
 * XO Platform — Test Website server.
 *
 * This file is NOT part of the XO Platform repo and does not modify it
 * in any way. It does exactly two things:
 *
 *   1. Serves this test website's static files (./public) to the browser.
 *   2. Reverse-proxies any request under /api/* to a running `apps/api`
 *      instance (default http://127.0.0.1:4000), byte-for-byte, so the
 *      browser only ever talks to one origin and there is no CORS
 *      configuration to add to the real API.
 *
 * Usage:
 *   node server.mjs
 *
 * Env vars:
 *   SITE_PORT   — port this site listens on (default 5173)
 *   XO_API_URL  — base URL of the real apps/api server (default http://127.0.0.1:4000)
 */

import http from 'node:http';
import https from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const SITE_PORT = Number(process.env.SITE_PORT || 5173);
const API_TARGET = process.env.XO_API_URL || 'http://127.0.0.1:4000';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function proxy(req, res) {
  const targetUrl = new URL(req.url.replace(/^\/api/, '') || '/', API_TARGET);
  const lib = targetUrl.protocol === 'https:' ? https : http;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.origin;
  delete headers.referer;

  const upstream = lib.request(
    targetUrl,
    { method: req.method, headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, {
        ...upstreamRes.headers,
        'access-control-allow-origin': '*',
      });
      upstreamRes.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(
      JSON.stringify({
        proxyError: true,
        message: String(err && err.message ? err.message : err),
        target: targetUrl.toString(),
        hint: 'Is the real apps/api server running and reachable at XO_API_URL?',
      }),
    );
  });

  req.pipe(upstream);
}

async function serveStatic(req, res) {
  let reqPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    });
    res.end();
    return;
  }
  if (req.url.startsWith('/api/')) {
    proxy(req, res);
    return;
  }
  void serveStatic(req, res);
});

server.listen(SITE_PORT, () => {
  console.log(`XO Platform test website:  http://localhost:${SITE_PORT}`);
  console.log(`Proxying /api/*  ->  ${API_TARGET}`);
  console.log(`(Change target with XO_API_URL=... node server.mjs)`);
});
