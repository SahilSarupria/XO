import type { Ledger, LedgerEntry } from '@xo/registry-core';
import type { Result } from '@xo/types';
import { err, ok } from '@xo/types';
import type { XoError } from '@xo/errors';
import type { Hasher } from '@xo/crypto';
import { Sha256Hasher } from '@xo/crypto';
import type { BlobStore } from '@xo/storage';
import type { Clock } from '../clock.js';
import { SystemClock } from '../clock.js';

/**
 * The record actually persisted per entry — a superset of {@link LedgerEntry}
 * that also carries the previous entry's hash (or `null` for the genesis
 * entry), which is what makes this a *chain* rather than a flat list of
 * independently-hashed rows. `previousEntryHash` is intentionally not part
 * of the `registry-core` `LedgerEntry` shape (that interface is frozen);
 * it's an implementation detail of this hash-chained log, not something
 * `registry-core`'s callers should have to know about.
 */
interface StoredLedgerEntry extends LedgerEntry {
  readonly previousEntryHash: string | null;
}

interface LedgerHead {
  readonly entryHash: string | null;
}

const HEAD_KEY = 'ledger/head.json';

function entryKey(entryHash: string): string {
  // entryHash is "sha256:<hex>" — strip the scheme so the key is a plain
  // filesystem-safe path segment.
  return `ledger/entries/${entryHash.replace(/^sha256:/, '')}.json`;
}

/**
 * An honest, local, append-only, hash-chained log — the implementation
 * of `Ledger`'s "single seam a real implementation plugs its backing
 * store into" (registry-core/src/ledger.interface.ts). Every entry's
 * `entryHash` is derived from its `payloadHash`, its `recordedAt`
 * timestamp, and the *previous* entry's hash, so altering any entry (or
 * reordering the chain) changes every subsequent `entryHash` —
 * {@link verify} walks the chain back to genesis specifically to catch
 * that, not just a single entry's own internal consistency.
 *
 * Known limitation (documented rather than smoothed over, matching the
 * standard `ai-core` and `package-sdk` hold themselves to for their own
 * gaps): this is a local log backed by a local `BlobStore`. It gives
 * tamper-evidence (any modification is detectable) but not
 * tamper-*resistance* against someone with direct write access to that
 * backing store. The registry's actual integrity guarantee — that a
 * package hasn't been tampered with — comes from `@xo/crypto`'s content
 * hashing, Merkle roots, and signing (see `RegistryClient.publish()`,
 * which runs `PackageValidator.validateAll()` before this ledger ever
 * gets involved); this ledger is a local audit trail on top of that, not
 * itself the source of that guarantee.
 */
export class HashChainedLedger implements Ledger {
  private readonly hasher: Hasher;
  private readonly clock: Clock;

  constructor(
    private readonly store: BlobStore,
    options: { readonly hasher?: Hasher; readonly clock?: Clock } = {},
  ) {
    this.hasher = options.hasher ?? new Sha256Hasher();
    this.clock = options.clock ?? new SystemClock();
  }

  private async readHead(): Promise<string | null> {
    const raw = await this.store.get(HEAD_KEY);
    if (!raw.ok) return null;
    try {
      const head = JSON.parse(new TextDecoder().decode(raw.value)) as LedgerHead;
      return head.entryHash;
    } catch {
      return null;
    }
  }

  private async readEntry(entryHash: string): Promise<StoredLedgerEntry | undefined> {
    const raw = await this.store.get(entryKey(entryHash));
    if (!raw.ok) return undefined;
    try {
      return JSON.parse(new TextDecoder().decode(raw.value)) as StoredLedgerEntry;
    } catch {
      return undefined;
    }
  }

  async append(payloadHash: string): Promise<Result<LedgerEntry, XoError>> {
    const previousEntryHash = await this.readHead();
    const recordedAt = this.clock.now().toISOString();
    const entryHash = this.hasher.hash(`${previousEntryHash ?? 'genesis'}:${payloadHash}:${recordedAt}`);

    const entry: StoredLedgerEntry = { entryHash, payloadHash, recordedAt, previousEntryHash };

    const putEntry = await this.store.put(entryKey(entryHash), JSON.stringify(entry));
    if (!putEntry.ok) return err(putEntry.error);

    const putHead = await this.store.put(HEAD_KEY, JSON.stringify({ entryHash } satisfies LedgerHead));
    if (!putHead.ok) return err(putHead.error);

    return ok({ entryHash, payloadHash, recordedAt });
  }

  /**
   * Recomputes `entryHash` from its own recorded fields — including its
   * `previousEntryHash` — and, if the entry has a predecessor, recurses
   * into verifying *that* entry too. This means tampering with any entry
   * anywhere in the chain (not just the one `verify` was called on)
   * causes every entry recorded after it to fail verification, which is
   * the property an append-only chain is supposed to give a caller.
   */
  async verify(entryHash: string): Promise<boolean> {
    const seen = new Set<string>();
    let current: string | undefined = entryHash;

    while (current !== undefined) {
      if (seen.has(current)) return false; // a cycle can never happen in an honest chain
      seen.add(current);

      const entry = await this.readEntry(current);
      if (!entry) return false;

      const expectedHash = this.hasher.hash(`${entry.previousEntryHash ?? 'genesis'}:${entry.payloadHash}:${entry.recordedAt}`);
      if (expectedHash !== entry.entryHash) return false;

      current = entry.previousEntryHash ?? undefined;
    }
    return true;
  }
}
