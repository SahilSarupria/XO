import type { Ledger, LedgerEntry } from '@xo/registry-core';
import type { Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import type { Hasher } from '@xo/crypto';
import type { BlobStore } from '@xo/storage';
import type { Clock } from '../clock.js';
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
export declare class HashChainedLedger implements Ledger {
    private readonly store;
    private readonly hasher;
    private readonly clock;
    constructor(store: BlobStore, options?: {
        readonly hasher?: Hasher;
        readonly clock?: Clock;
    });
    private readHead;
    private readEntry;
    append(payloadHash: string): Promise<Result<LedgerEntry, XoError>>;
    /**
     * Recomputes `entryHash` from its own recorded fields — including its
     * `previousEntryHash` — and, if the entry has a predecessor, recurses
     * into verifying *that* entry too. This means tampering with any entry
     * anywhere in the chain (not just the one `verify` was called on)
     * causes every entry recorded after it to fail verification, which is
     * the property an append-only chain is supposed to give a caller.
     */
    verify(entryHash: string): Promise<boolean>;
}
//# sourceMappingURL=hash-chained-ledger.d.ts.map