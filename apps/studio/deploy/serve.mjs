// Minimal production host for the built Studio: serves dist/ and reverse-proxies /api/* to
// the XO API with the /api prefix stripped (same origin, so no CORS). Dependency-free.
// For real deployments prefer nginx/Caddy (see nginx.conf.example); this exists so the
// production build can be exercised and demonstrated without extra infrastructure.
//   XO_API_URL=http://127.0.0.1:4000 PORT=8080 node deploy/serve.mjs
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const api = new URL(process.env.XO_API_URL ?? 'http://127.0.0.1:4000');
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    const target = new URL((url.pathname.slice(4) || '/') + url.search, api);
    const send = api.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers = { ...req.headers, host: api.host };
    const up = send(target, { method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'upstream_unreachable', message: 'The XO API is unreachable.' } }));
    });
    req.pipe(up);
    return;
  }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let file = join(dist, rel);
  if (file !== dist && !file.startsWith(dist + sep)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
  createReadStream(file).pipe(res);
});
server.listen(port, host, () => console.log(`Studio on http://${host}:${port}  (/api -> ${api.origin})`));
