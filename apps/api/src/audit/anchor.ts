import { appendFile, mkdir, open, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/**
 * UW-1 — audit anchoring. The workspace audit log is hash-chained, so an edit or deletion inside it is detected by `verify()`. What
 * the chain alone cannot detect is someone with write access to the storage rewriting the WHOLE chain consistently (recomputing every
 * hash) or truncating its tail. An anchor is the chain head (`seq`, `hash`) written somewhere else at the time; a later chain that
 * disagrees with any anchor has been rewritten, and one shorter than an anchor has been truncated.
 *
 * Anchors are cumulative: because every entry links to the previous one, an anchor of head N covers entries 1..N. A failed anchor
 * write therefore loses nothing permanently; the next append's anchor covers it.
 *
 * The built-in sink appends JSON lines to `XO_AUDIT_ANCHOR_DIR`, which an operator should put on storage the API host cannot rewrite
 * (a separate volume, a backup target, object storage with retention lock). The interface is the extension point for other sinks.
 */

export interface AuditAnchor {
  /** What chain this anchors, for example `workspace:ws_123`. */
  readonly scope: string;
  readonly seq: number;
  readonly hash: string;
  /** The anchored entry's own recorded time. Lets a verifier prove that a purge removed only entries older than its cutoff. */
  readonly entryAt?: string;
  readonly anchoredAt: string;
}

export interface AuditAnchorSink {
  publish(anchor: AuditAnchor): Promise<void>;
  list(scope: string): Promise<readonly AuditAnchor[]>;
}

const SCOPE = /^[a-z]+:[A-Za-z0-9_-]{1,128}$/;

function fileFor(dir: string, scope: string): string {
  if (!SCOPE.test(scope)) throw new Error(`invalid audit anchor scope "${scope}"`);
  return join(dir, `${scope.replace(':', '__')}.anchors.jsonl`);
}

/** Append-only JSON-lines anchors, one file per scope, each line flushed to disk before `publish` resolves. */
export class FileAuditAnchorSink implements AuditAnchorSink {
  constructor(private readonly dir: string) {}

  async publish(anchor: AuditAnchor): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = fileFor(this.dir, anchor.scope);
    await appendFile(path, `${JSON.stringify(anchor)}\n`, { mode: 0o600 });
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async list(scope: string): Promise<readonly AuditAnchor[]> {
    let text: string;
    try {
      text = await readFile(fileFor(this.dir, scope), 'utf8');
    } catch (cause) {
      if ((cause as { code?: unknown }).code === 'ENOENT') return [];
      throw cause;
    }
    const anchors: AuditAnchor[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const a = JSON.parse(line) as Partial<AuditAnchor>;
      if (a.scope !== scope || !Number.isInteger(a.seq) || typeof a.hash !== 'string' || typeof a.anchoredAt !== 'string') {
        throw new Error(`unreadable audit anchor in scope "${scope}"`);
      }
      anchors.push(a as AuditAnchor);
    }
    return anchors;
  }
}

export interface AnchorCheck {
  /** Anchors compared. */
  readonly checked: number;
  /** The highest anchored sequence number (0 when there are none). */
  readonly highestAnchoredSeq: number;
  /** First disagreement, if any. */
  readonly mismatch?: {
    readonly seq: number;
    /**
     * `truncated`: the chain is shorter than an anchor. `rewritten`: a different hash at an anchored seq. `purged_too_recent`: a purge
     * removed an entry that was not older than the purge's cutoff. `unattested_purge`: a purge that no anchor covers (anchors exist,
     * yet none was written at or after the purge record).
     */
    readonly reason: 'truncated' | 'rewritten' | 'purged_too_recent' | 'unattested_purge';
  };
}

/** What a verified purge record says was removed (see FsAuditLog.purge). */
export interface PurgedRange {
  readonly throughSeq: number;
  readonly cutoff: string;
  readonly purgeEventSeq: number;
}

/**
 * Compare a chain against its anchors. `hashAt(seq)` returns the stored entry hash at `seq` (undefined if absent); `headSeq` is the
 * chain's current head. A chain shorter than an anchor is `truncated`; a different hash at an anchored seq is `rewritten`. Anchors at
 * or below a verified purge are not compared with storage (those entries are gone by design), but each must predate the purge's cutoff.
 */
export async function checkAnchors(
  anchors: readonly AuditAnchor[],
  headSeq: number,
  hashAt: (seq: number) => Promise<string | undefined>,
  purged?: PurgedRange,
): Promise<AnchorCheck> {
  let highest = 0;
  for (const a of anchors) highest = Math.max(highest, a.seq);
  const result = (mismatch?: AnchorCheck['mismatch']): AnchorCheck => ({
    checked: anchors.length,
    highestAnchoredSeq: highest,
    ...(mismatch !== undefined ? { mismatch } : {}),
  });
  const sorted = [...anchors].sort((x, y) => x.seq - y.seq);
  for (const a of sorted) {
    if (purged !== undefined && a.seq <= purged.throughSeq) {
      if (a.entryAt !== undefined && a.entryAt >= purged.cutoff) return result({ seq: a.seq, reason: 'purged_too_recent' });
      continue;
    }
    if (a.seq > headSeq) return result({ seq: a.seq, reason: 'truncated' });
    const hash = await hashAt(a.seq);
    if (hash !== a.hash) return result({ seq: a.seq, reason: 'rewritten' });
  }
  if (purged !== undefined && anchors.length > 0 && highest < purged.purgeEventSeq) {
    return result({ seq: purged.purgeEventSeq, reason: 'unattested_purge' });
  }
  return result();
}

/**
 * The anchor sink an operator configured: `XO_AUDIT_ANCHOR_DIR` (an absolute path) or none. Throws on a relative path, so a
 * misconfiguration stops startup instead of anchoring somewhere unintended.
 */
export function auditAnchorSinkFromEnv(env: Readonly<Record<string, string | undefined>>): AuditAnchorSink | undefined {
  const raw = env['XO_AUDIT_ANCHOR_DIR'];
  if (raw === undefined || raw.trim() === '') return undefined;
  if (!isAbsolute(raw)) throw new Error(`XO_AUDIT_ANCHOR_DIR must be an absolute path (got "${raw}")`);
  return new FileAuditAnchorSink(raw);
}
