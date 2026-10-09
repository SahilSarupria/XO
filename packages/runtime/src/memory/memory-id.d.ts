import { MemoryEntryId } from '../ids.js';
import type { MemoryScope } from './memory-types.js';
/**
 * Deterministic identity for keyed memory: the same `(scope, key)`
 * always derives the same `MemoryEntryId`, so writing it again is an
 * upsert rather than a duplicate — §14/§4 of the Stage 5 brief. Plain
 * `node:crypto` `sha256` (the same primitive `persistence/file/atomic-file-io.ts`
 * already uses for checksums), not `@xo/crypto`'s `Sha256Hasher`: pulling
 * in `@xo/crypto` for one hash call would be a new package dependency
 * for something this package can already do with what Node provides —
 * consistent with this stage's "don't add dependencies you don't need"
 * posture (see the note on `@xo/xoir` in the Runtime README's Stage 5
 * section).
 */
export declare function deriveMemoryEntryId(scope: MemoryScope, key: string): MemoryEntryId;
/**
 * For memory with no semantic `key` — an inherently unique event
 * instance (one capability call's result, one turn's inferred fact) —
 * forcing deterministic identity onto it would silently collapse
 * distinct events into one record. `randomUUID()` (Node's built-in,
 * cryptographically-random UUIDv4) is the identity mechanism for exactly
 * this case; see §14's explicit carve-out.
 */
export declare function generateMemoryEntryId(): MemoryEntryId;
//# sourceMappingURL=memory-id.d.ts.map