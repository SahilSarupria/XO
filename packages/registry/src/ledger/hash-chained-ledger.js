import { err, ok } from '@xo/types';
import { Sha256Hasher } from '@xo/crypto';
import { SystemClock } from '../clock.js';
const HEAD_KEY = 'ledger/head.json';
function entryKey(entryHash) {
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
export class HashChainedLedger {
    store;
    hasher;
    clock;
    constructor(store, options = {}) {
        this.store = store;
        this.hasher = options.hasher ?? new Sha256Hasher();
        this.clock = options.clock ?? new SystemClock();
    }
    async readHead() {
        const raw = await this.store.get(HEAD_KEY);
        if (!raw.ok)
            return null;
        try {
            const head = JSON.parse(new TextDecoder().decode(raw.value));
            return head.entryHash;
        }
        catch {
            return null;
        }
    }
    async readEntry(entryHash) {
        const raw = await this.store.get(entryKey(entryHash));
        if (!raw.ok)
            return undefined;
        try {
            return JSON.parse(new TextDecoder().decode(raw.value));
        }
        catch {
            return undefined;
        }
    }
    async append(payloadHash) {
        const previousEntryHash = await this.readHead();
        const recordedAt = this.clock.now().toISOString();
        const entryHash = this.hasher.hash(`${previousEntryHash ?? 'genesis'}:${payloadHash}:${recordedAt}`);
        const entry = { entryHash, payloadHash, recordedAt, previousEntryHash };
        const putEntry = await this.store.put(entryKey(entryHash), JSON.stringify(entry));
        if (!putEntry.ok)
            return err(putEntry.error);
        const putHead = await this.store.put(HEAD_KEY, JSON.stringify({ entryHash }));
        if (!putHead.ok)
            return err(putHead.error);
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
    async verify(entryHash) {
        const seen = new Set();
        let current = entryHash;
        while (current !== undefined) {
            if (seen.has(current))
                return false; // a cycle can never happen in an honest chain
            seen.add(current);
            const entry = await this.readEntry(current);
            if (!entry)
                return false;
            const expectedHash = this.hasher.hash(`${entry.previousEntryHash ?? 'genesis'}:${entry.payloadHash}:${entry.recordedAt}`);
            if (expectedHash !== entry.entryHash)
                return false;
            current = entry.previousEntryHash ?? undefined;
        }
        return true;
    }
}
//# sourceMappingURL=hash-chained-ledger.js.map