import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { canonicalJson } from '@xo/capability-layer';

export type TriggerSource = 'schedule' | 'file' | 'webhook' | 'manual';

export interface TriggerEvent {
  readonly trigger: string;
  readonly source: TriggerSource;
  /** Same key ⇒ same logical event. The engine runs each key at most once, across retries, redeliveries and restarts. */
  readonly idempotencyKey: string;
  readonly receivedAt: string;
  readonly payload: unknown;
  /** Called by the engine when the run is finished (or rejected as a duplicate). Lets a trigger tidy up its source (move a file, etc.). */
  readonly onSettled?: (status: 'completed' | 'failed' | 'duplicate') => Promise<void> | void;
}

export interface EmitResult {
  readonly accepted: boolean;
  readonly duplicate?: boolean;
  readonly runId?: string;
  readonly reason?: 'queue_full' | 'rate_limited' | 'stopped';
}

export type Emit = (e: TriggerEvent) => Promise<EmitResult>;

export interface Trigger {
  readonly id: string;
  start(emit: Emit): Promise<void>;
  stop(): Promise<void>;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Fires every `everyMs`. The idempotency key is the *time slot* (`floor(now/everyMs)`), not the firing, so a
 * restart inside the same slot — or two instances racing — cannot run the same scheduled job twice.
 */
export class ScheduleTrigger implements Trigger {
  private timer: NodeJS.Timeout | undefined;
  constructor(
    readonly id: string,
    private readonly opts: {
      readonly everyMs: number;
      readonly runOnStart?: boolean;
      readonly payload?: () => unknown;
      readonly now?: () => number;
    },
  ) {
    if (opts.everyMs < 10) throw new Error('everyMs must be at least 10');
  }
  async start(emit: Emit): Promise<void> {
    const now = this.opts.now ?? Date.now;
    const fire = (): void => {
      const slot = Math.floor(now() / this.opts.everyMs);
      void emit({
        trigger: this.id,
        source: 'schedule',
        idempotencyKey: `${this.id}@${slot}`,
        receivedAt: new Date(now()).toISOString(),
        payload: this.opts.payload?.() ?? { slot },
      });
    };
    if (this.opts.runOnStart === true) fire();
    this.timer = setInterval(fire, this.opts.everyMs);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
  }
}

/**
 * Watches a directory for `*.json` files (polling — portable and robust across network filesystems). A file is
 * keyed by the hash of its content, so re-dropping the same claim is a no-op. After the run it is moved to
 * `done/` or `failed/` (with the reason); unparseable files go straight to `failed/`.
 */
export class FileDropTrigger implements Trigger {
  private timer: NodeJS.Timeout | undefined;
  private readonly inFlight = new Set<string>();
  private scanning = false;
  private emit: Emit | undefined;
  constructor(
    readonly id: string,
    private readonly opts: { readonly dir: string; readonly pollMs?: number },
  ) {}

  async start(emit: Emit): Promise<void> {
    this.emit = emit;
    await Promise.all(['', 'done', 'failed'].map((d) => mkdir(join(this.opts.dir, d), { recursive: true })));
    const tick = (): void => void this.scan();
    this.timer = setInterval(tick, this.opts.pollMs ?? 250);
    this.timer.unref();
    tick();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  private async move(name: string, to: 'done' | 'failed', note?: string): Promise<void> {
    await rename(join(this.opts.dir, name), join(this.opts.dir, to, name)).catch(() => undefined);
    if (note !== undefined) await writeFile(join(this.opts.dir, to, `${name}.note.txt`), note, 'utf8').catch(() => undefined);
  }

  private async scan(): Promise<void> {
    if (this.scanning || this.emit === undefined) return;
    this.scanning = true;
    try {
      const names = (await readdir(this.opts.dir, { withFileTypes: true }))
        .filter((d) => d.isFile() && d.name.endsWith('.json'))
        .map((d) => d.name)
        .sort();
      for (const name of names) {
        if (this.inFlight.has(name)) continue;
        let raw: string;
        try {
          raw = await readFile(join(this.opts.dir, name), 'utf8');
        } catch {
          continue; // vanished or still being written
        }
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch (e) {
          await this.move(name, 'failed', `not valid JSON: ${(e as Error).message}`);
          continue;
        }
        this.inFlight.add(name);
        const res = await this.emit({
          trigger: this.id,
          source: 'file',
          idempotencyKey: sha(canonicalJson(payload)),
          receivedAt: new Date().toISOString(),
          payload,
          onSettled: async (status) => {
            await this.move(
              name,
              status === 'failed' ? 'failed' : 'done',
              status === 'duplicate' ? 'duplicate of an already-processed claim' : undefined,
            );
            this.inFlight.delete(name);
          },
        });
        if (!res.accepted && !res.duplicate) this.inFlight.delete(name); // queue full / rate limited: leave the file, retry next poll
      }
    } finally {
      this.scanning = false;
    }
  }
}

export interface WebhookOptions {
  readonly secret: string;
  readonly port?: number;
  readonly host?: string;
  readonly path?: string;
  /** Reject requests whose timestamp is further than this from now (replay window). Default 300 s. */
  readonly toleranceSec?: number;
  readonly maxBodyBytes?: number;
  readonly now?: () => number;
}

/**
 * HTTP intake with Stripe-style signing: `X-XO-Timestamp` (unix seconds) and
 * `X-XO-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>`.
 * Binds to loopback by default. Wrong method/path/signature/timestamp are
 * answered identically-ish without revealing which check failed, bodies are
 * size-capped while streaming, and an `Idempotency-Key` (or the body hash)
 * makes redelivery safe.
 */
export class WebhookTrigger implements Trigger {
  private server: Server | undefined;
  constructor(
    readonly id: string,
    private readonly opts: WebhookOptions,
  ) {
    if (opts.secret.length < 16) throw new Error('webhook secret must be at least 16 characters');
  }

  static sign(secret: string, timestampSec: number, body: string): string {
    return `sha256=${createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex')}`;
  }

  address(): AddressInfo {
    return this.server?.address() as AddressInfo;
  }

  start(emit: Emit): Promise<void> {
    const path = this.opts.path ?? '/hook';
    const maxBytes = this.opts.maxBodyBytes ?? 262_144;
    const tolerance = this.opts.toleranceSec ?? 300;
    const now = this.opts.now ?? (() => Date.now());
    this.server = createServer((req, res) => {
      const reply = (code: number, body: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'POST' || req.url?.split('?')[0] !== path) return reply(404, { error: 'not found' });
      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes && !aborted) {
          aborted = true;
          reply(413, { error: 'payload too large' });
          req.destroy();
          return;
        }
        if (!aborted) chunks.push(c);
      });
      req.on('end', () => {
        if (aborted) return;
        void (async () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const ts = Number(req.headers['x-xo-timestamp']);
          const sig = String(req.headers['x-xo-signature'] ?? '');
          const expected = WebhookTrigger.sign(this.opts.secret, ts, body);
          const a = Buffer.from(sig);
          const b = Buffer.from(expected);
          const sigOk = Number.isFinite(ts) && a.length === b.length && timingSafeEqual(a, b);
          const fresh = Number.isFinite(ts) && Math.abs(now() / 1000 - ts) <= tolerance;
          if (!sigOk || !fresh) return reply(401, { error: 'unauthorized' });
          let payload: unknown;
          try {
            payload = JSON.parse(body);
          } catch {
            return reply(400, { error: 'body must be JSON' });
          }
          const key = typeof req.headers['idempotency-key'] === 'string' ? `hdr:${req.headers['idempotency-key']}` : sha(body);
          const r = await emit({
            trigger: this.id,
            source: 'webhook',
            idempotencyKey: key,
            receivedAt: new Date(now()).toISOString(),
            payload,
          });
          if (r.duplicate) return reply(200, { status: 'duplicate', runId: r.runId });
          if (r.accepted) return reply(202, { status: 'accepted', runId: r.runId });
          return reply(r.reason === 'rate_limited' ? 429 : 503, { error: r.reason ?? 'unavailable' });
        })();
      });
    });
    return new Promise((resolve) => this.server!.listen(this.opts.port ?? 0, this.opts.host ?? '127.0.0.1', () => resolve()));
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server === undefined ? resolve() : this.server.close(() => resolve())));
  }
}
