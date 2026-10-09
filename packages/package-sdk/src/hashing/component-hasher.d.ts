import type { Hasher } from '@xo/crypto';
import { buildMerkleRoot } from '@xo/crypto';
import type { ComponentInput } from '../types.js';
/**
 * Computes the SHA-256 hash of a single component's bytes, in the
 * `sha256:<hex>` form `XoManifest.components[*].hash` expects. Thin
 * wrapper kept separate from `@xo/crypto`'s generic {@link Hasher} so
 * call sites read as "hash this component" rather than "hash these
 * bytes", and so a future component-specific hashing rule (e.g.
 * canonicalizing JSON before hashing) has one place to land.
 */
export declare function hashComponent(component: ComponentInput, hasher?: Hasher): string;
/** Hashes every component and returns `[kind, hash]` pairs sorted by component kind, so the result is independent of input order — the same ordering rule {@link ManifestBuilder} uses when it feeds leaves to {@link buildMerkleRoot}. */
export declare function hashComponents(components: readonly ComponentInput[], hasher?: Hasher): readonly (readonly [string, string])[];
export { buildMerkleRoot };
//# sourceMappingURL=component-hasher.d.ts.map