/** Computes a content hash in the `sha256:<hex>` form used throughout XoManifest ("hash", "merkleRoot"). */
export interface Hasher {
  hash(data: Uint8Array | string): string;
}
