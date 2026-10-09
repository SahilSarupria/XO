import { type Result } from '@xo/types';
import { SerializationError } from '@xo/errors';
import { type Codec } from '@xo/serialization';
import type { XoirEdge } from './edge-kinds.js';
import { XoirGraph } from './graph.js';
import type { XoirManifest } from './manifest.js';
import type { XoirNode } from './node-kinds.js';
/**
 * The canonical on-disk/wire shape of a XOIR graph. Nodes and edges are
 * sorted by id before serialization (see {@link toJSON}), which is what
 * makes this format's hash-of-the-serialized-form stable regardless of
 * the order operations happened to occur in while building the graph in
 * memory — "stable ordering" and "deterministic hashing" from the module's
 * Core Principles, applied at the wire-format layer (graph.ts's
 * `contentHash()` is the equivalent for the in-memory structure, and the
 * two agree because both hash from sorted node/edge hash lists).
 */
export interface XoirGraphJson {
    readonly schemaVersion: number;
    readonly id: string;
    readonly nodes: readonly XoirNode[];
    readonly edges: readonly XoirEdge[];
    /** Optional (manifest.ts#XoirManifest) — additive field, absent on older serialized graphs. */
    readonly manifest?: XoirManifest;
}
export declare function toJson(graph: XoirGraph): XoirGraphJson;
/**
 * Reconstructs a {@link XoirGraph} from its JSON form. Version-aware: a
 * `schemaVersion` this build doesn't recognize (per
 * `versioning.ts#isSchemaVersionSupported`) is rejected explicitly rather
 * than silently misinterpreted — "forward compatibility" here means "fail
 * clearly on an unknown future version", not "guess at its shape".
 * Individual nodes/edges are trusted as already-valid (their own `hash`
 * fields are not re-verified here) — see validation.ts's `validateGraph`
 * for that (its hash-mismatch check), which is a deliberately separate
 * concern from "does this parse into the right shape".
 */
export declare function fromJson(raw: XoirGraphJson): Result<XoirGraph, SerializationError>;
/** A `@xo/serialization` `Codec<XoirGraph>` for callers that want the standard encode/decode-to-string boundary (e.g. `BlobStore.put(key, xoirGraphCodec.encode(graph))`). */
export declare const xoirGraphCodec: Codec<XoirGraph>;
//# sourceMappingURL=serialization.d.ts.map