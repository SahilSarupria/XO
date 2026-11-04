import { createHmac } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { verifyEntries, type LedgerEntry } from './ledger.js';

/** A point in the ledger published somewhere an attacker with write access to the state directory cannot also edit. */
export interface Anchor {
  readonly seq: number;
  readonly hash: string;
  readonly at: string;
}

export interface AnchorSink {
  readonly id: string;
  publish(anchor: Anchor): Promise<void>;
}

/** Appends anchors to a file that should live OUTSIDE the engine's state directory (another disk, a WORM/append-only mount, a mounted object store). */
export class FileAnchorSink implements AnchorSink {
  readonly id: string;
  constructor(private readonly path: string) {
    this.id = `file:${path}`;
  }
  async publish(a: Anchor): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(a)}\n`, 'utf8');
  }
}

/** POSTs `{seq,hash,at}` to an HTTPS (or loopback) endpoint with an HMAC so the receiver can authenticate it: header `X-XO-Anchor-Signature: sha256=<hmac(secret, body)>`. */
export class WebhookAnchorSink implements AnchorSink {
  readonly id: string;
  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const u = new URL(url);
    const loop = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop))
      throw new Error('anchor endpoint must be https (http only for loopback)');
    if (secret.length < 16) throw new Error('anchor secret must be at least 16 characters');
    this.id = `webhook:${u.host}`;
  }
  async publish(a: Anchor): Promise<void> {
    const body = JSON.stringify(a);
    const r = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-xo-anchor-signature': `sha256=${createHmac('sha256', this.secret).update(body).digest('hex')}`,
      },
      body,
    });
    if (!r.ok) throw new Error(`anchor endpoint answered ${r.status}`);
  }
}

export interface AnchorCheck {
  readonly ok: boolean;
  readonly anchors: number;
  readonly problems: readonly string[];
}

/**
 * Verifies a ledger against previously published anchors: the chain must be internally valid AND every anchored (seq, hash)
 * must still be at that position. A rebuilt-from-scratch or truncated ledger fails here even though its own chain is consistent.
 */
export function verifyAgainstAnchors(entries: readonly LedgerEntry[], anchors: readonly Anchor[]): AnchorCheck {
  const problems: string[] = [];
  const chain = verifyEntries(entries);
  if (!chain.ok) problems.push(`chain invalid at entry ${chain.brokenAt}: ${chain.reason}`);
  for (const a of anchors) {
    const e = entries[a.seq - 1];
    if (e === undefined) problems.push(`anchor at seq ${a.seq} is beyond the ledger's end (${entries.length}) — ledger truncated`);
    else if (e.hash !== a.hash) problems.push(`anchor at seq ${a.seq} does not match the ledger — history was rewritten`);
  }
  return { ok: problems.length === 0, anchors: anchors.length, problems };
}

export async function readAnchorFile(path: string): Promise<Anchor[]> {
  const raw = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? '' : Promise.reject(e)));
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Anchor);
}
