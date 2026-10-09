import { createHash } from 'node:crypto';
import type { Hasher } from './hasher.interface.js';

/** SHA-256 hasher built on Node's built-in `node:crypto` — no external dependency. */
export class Sha256Hasher implements Hasher {
  hash(data: Uint8Array | string): string {
    const digest = createHash('sha256').update(data).digest('hex');
    return `sha256:${digest}`;
  }
}

/**
 * Builds a Merkle root over an ordered list of leaf hashes, matching the
 * "computes the SHA-256 hash of every component file, builds the Merkle
 * root" step described in PACKAGE_README.md §4's `xo pack` process.
 * Odd trailing nodes are carried up unchanged (the common Bitcoin-style
 * convention), not duplicated, to keep this a pure function of the input
 * order with no hidden padding rule to get wrong.
 */
export function buildMerkleRoot(leafHashes: readonly string[], hasher: Hasher = new Sha256Hasher()): string {
  if (leafHashes.length === 0) {
    throw new RangeError('buildMerkleRoot requires at least one leaf hash');
  }
  let level = leafHashes.map((h) => h.replace(/^sha256:/, ''));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(hasher.hash(left + right).replace(/^sha256:/, ''));
    }
    level = next;
  }
  return `sha256:${level[0]}`;
}
