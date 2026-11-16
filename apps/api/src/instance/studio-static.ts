import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, sep } from 'node:path';

/**
 * UW-17 — the built Studio served by the instance itself, so one process on one port is the whole product (`/` Studio, `/api/*` the
 * API it calls). Only files inside the build folder are served, never through a link out of it. Unknown paths without an extension
 * are Studio's own routes and get `index.html`; a missing asset is a 404, never `index.html`.
 */
export interface StudioServing {
  readonly dir: string;
  /** Show the access-key sign-in (`XO_DEV_SIGN_IN`). */
  readonly devSignIn: boolean;
}

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** Studio reaches nothing but this origin; inline style attributes are used by React components, inline scripts never. */
export const STUDIO_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': STUDIO_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
};

export class StudioStatic {
  private indexHtml: string | undefined;
  private realDir: string | undefined;

  constructor(private readonly serving: StudioServing) {}

  /** Checked at start-up: a missing build is a configuration error, not a blank page later. */
  async check(): Promise<void> {
    try {
      this.realDir = await realpath(this.serving.dir);
      await stat(join(this.realDir, 'index.html'));
    } catch {
      throw new Error(`XO_STUDIO_DIR=${this.serving.dir} has no index.html; build Studio first (npm run build -w @xo/studio)`);
    }
  }

  private configScript(): string {
    // The served Studio always talks to /api on this same origin.
    return `window.__XO_CONFIG__ = ${JSON.stringify({ apiBaseUrl: '/api', devSignIn: this.serving.devSignIn })};\n`;
  }

  private async index(): Promise<string> {
    if (this.indexHtml === undefined) {
      const raw = await readFile(join(this.realDir ?? this.serving.dir, 'index.html'), 'utf8');
      const tag = '<script src="/xo-config.js"></script>';
      this.indexHtml = raw.includes('</head>') ? raw.replace('</head>', `    ${tag}\n  </head>`) : `${tag}\n${raw}`;
    }
    return this.indexHtml;
  }

  /** Returns the status written. */
  async serve(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<number> {
    const head = req.method === 'HEAD';
    const send = (status: number, type: string, body: string | Buffer, cache: string): number => {
      res.writeHead(status, {
        ...SECURITY_HEADERS,
        'content-type': type,
        'cache-control': cache,
        'content-length': String(Buffer.byteLength(body)),
      });
      res.end(head ? undefined : body);
      return status;
    };
    if (req.method !== 'GET' && !head) {
      res.writeHead(405, { ...SECURITY_HEADERS, allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return 405;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return send(400, 'text/plain; charset=utf-8', 'bad path', 'no-store');
    }
    if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some((s) => s === '..' || s === '.'))
      return send(400, 'text/plain; charset=utf-8', 'bad path', 'no-store');
    if (decoded === '/xo-config.js') return send(200, TYPES['.js']!, this.configScript(), 'no-store');
    const ext = extname(decoded).toLowerCase();
    if (decoded === '/' || decoded === '/index.html' || ext === '') return send(200, TYPES['.html']!, await this.index(), 'no-cache');

    const root = this.realDir ?? this.serving.dir;
    let file: string;
    try {
      file = await realpath(join(root, ...decoded.split('/').filter(Boolean)));
    } catch {
      return send(404, 'text/plain; charset=utf-8', 'not found', 'no-store');
    }
    if (!file.startsWith(root + sep)) return send(404, 'text/plain; charset=utf-8', 'not found', 'no-store');
    const s = await stat(file);
    if (!s.isFile()) return send(404, 'text/plain; charset=utf-8', 'not found', 'no-store');
    // Vite fingerprints everything under /assets/: safe to cache for good. Anything else may change between versions.
    const cache = decoded.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'cache-control': cache,
      'content-length': String(s.size),
    });
    if (head) {
      res.end();
      return 200;
    }
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(file);
      stream.on('error', reject);
      res.on('close', resolve);
      stream.pipe(res);
    });
    return 200;
  }
}
