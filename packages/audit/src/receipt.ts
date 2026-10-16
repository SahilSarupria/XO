/**
 * Durable receipts. A receipt is the ONLY evidence a caller may treat as
 * "this audit event was recorded". It is minted by a trusted adapter after the
 * adapter's own confirmation step, and registered in a module-private WeakMap.
 * `mintReceipt` is NOT exported from the package entry point (the package
 * `exports` map blocks deep imports), so application code cannot create one;
 * an object literal, JSON copy, spread, or `structuredClone` of a real receipt
 * does not verify (`isDurableReceipt` is identity-based).
 *
 * Same documented limit as M1/M2 provenance markers: this is an in-process
 * guarantee. Code already running inside the process with access to this
 * module's internals could mint anything; it is not a sandbox.
 */

/**
 * What a receipt guarantees:
 *  - `fsync-file`: the event line was written to the audit file and the
 *    file's data was flushed with fsync (the write was acknowledged by the OS
 *    as stable) before this receipt was minted. It does NOT guarantee media-
 *    level durability on hardware with lying write caches, nor survival of
 *    disk loss, nor cross-machine replication.
 *  - `volatile-memory`: the event is held in process memory only. Valid ONLY
 *    in explicit non-production mode; never produced by the file store.
 */
export type DurabilityGuarantee = 'fsync-file' | 'volatile-memory';

export interface DurableReceipt {
  readonly kind: 'xo.audit.receipt';
  readonly eventId: string;
  readonly seq: number;
  readonly storeId: string;
  readonly recordedAt: string;
  readonly guarantee: DurabilityGuarantee;
}

const minted = new WeakSet<object>();

/** Internal — trusted adapters only. Not re-exported from `index.ts`. */
export function mintReceipt(fields: Omit<DurableReceipt, 'kind'>): DurableReceipt {
  const receipt: DurableReceipt = Object.freeze({ kind: 'xo.audit.receipt' as const, ...fields });
  minted.add(receipt);
  return receipt;
}

export function isDurableReceipt(value: unknown): value is DurableReceipt {
  return typeof value === 'object' && value !== null && minted.has(value);
}
