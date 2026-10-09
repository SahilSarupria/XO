import { err, ok } from '@xo/types';
import { SerializationError, ErrorCode } from '@xo/errors';
import { jsonCodec } from '@xo/serialization';
import { XoirGraph } from './graph.js';
import { XoirGraphId } from './ids.js';
import { isSchemaVersionSupported } from './versioning.js';
function isXoirGraphJson(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const v = value;
    return typeof v.schemaVersion === 'number' && typeof v.id === 'string' && Array.isArray(v.nodes) && Array.isArray(v.edges);
}
function byId(a, b) {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
export function toJson(graph) {
    return {
        schemaVersion: graph.schemaVersion,
        id: graph.id,
        nodes: [...graph.allNodes()].sort(byId),
        edges: [...graph.allEdges()].sort(byId),
        ...(graph.manifest !== undefined ? { manifest: graph.manifest } : {}),
    };
}
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
export function fromJson(raw) {
    if (!isSchemaVersionSupported(raw.schemaVersion)) {
        return err(new SerializationError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, `Unsupported XOIR schemaVersion ${raw.schemaVersion}`));
    }
    const graph = new XoirGraph(XoirGraphId(raw.id), raw.schemaVersion, raw.manifest);
    for (const node of raw.nodes) {
        const result = graph.addNode(node);
        if (!result.ok) {
            return err(new SerializationError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, `Failed to reconstruct node "${node.id}": ${result.error.message}`));
        }
    }
    for (const edge of raw.edges) {
        const result = graph.addEdge(edge);
        if (!result.ok) {
            return err(new SerializationError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, `Failed to reconstruct edge "${edge.id}": ${result.error.message}`));
        }
    }
    return ok(graph);
}
/** A `@xo/serialization` `Codec<XoirGraph>` for callers that want the standard encode/decode-to-string boundary (e.g. `BlobStore.put(key, xoirGraphCodec.encode(graph))`). */
export const xoirGraphCodec = {
    encode(graph) {
        return jsonCodec().encode(toJson(graph));
    },
    decode(rawText) {
        const parsed = jsonCodec({ validate: isXoirGraphJson }).decode(rawText);
        if (!parsed.ok)
            return err(parsed.error);
        return fromJson(parsed.value);
    },
};
//# sourceMappingURL=serialization.js.map