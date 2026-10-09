import type { Result } from '@xo/types';
import type { XoError } from '@xo/errors';
export interface LedgerEntry {
    readonly entryHash: string;
    readonly payloadHash: string;
    readonly recordedAt: string;
}
/**
 * The append-only, verifiable, tamper-evident ledger SPECIFICATION.md
 * §0/§3 requires for benchmark results and royalty settlement. This is
 * the single seam a real implementation plugs its backing store into —
 * nothing upstream should assume anything about what that backing store
 * is.
 */
export interface Ledger {
    append(payloadHash: string): Promise<Result<LedgerEntry, XoError>>;
    verify(entryHash: string): Promise<boolean>;
}
//# sourceMappingURL=ledger.interface.d.ts.map