import type { Hasher } from './hasher.interface.js';
/** SHA-256 hasher built on Node's built-in `node:crypto` — no external dependency. */
export declare class Sha256Hasher implements Hasher {
    hash(data: Uint8Array | string): string;
}
/**
 * Builds a Merkle root over an ordered list of leaf hashes, matching the
 * "computes the SHA-256 hash of every component file, builds the Merkle
 * root" step described in PACKAGE_README.md §4's `xo pack` process.
 * Odd trailing nodes are carried up unchanged (the common Bitcoin-style
 * convention), not duplicated, to keep this a pure function of the input
 * order with no hidden padding rule to get wrong.
 */
export declare function buildMerkleRoot(leafHashes: readonly string[], hasher?: Hasher): string;
//# sourceMappingURL=sha256-hasher.d.ts.map