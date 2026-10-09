import { err, ok, type Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId, type CapabilityNodeProps, type XoirCostEstimate, type XoirDeterminism, type XoirExecutionMode } from '@xo/xoir';
import type { Capability, CapabilityGraph, CapabilitySignature } from '../capabilities/types.js';
import { xoirEdgeKindForCapabilityRelationType } from './edge-mapping.js';
import { provenanceToSourceRefs, toXoirConfidence } from './provenance.js';

export interface CapabilityGraphToXoirOptions {
  readonly graphId?: string;
  /** An existing `XoirGraph` to add these nodes/edges into — see `knowledge-to-xoir.ts`'s option of the same name. Passing the graph a prior `knowledgeGraphToXoir` call produced is what makes a `Capability`'s `requiredKnowledgeNodeIds` resolve to real edges instead of being silently dropped. */
  readonly into?: XoirGraph;
  readonly now?: () => string;
}

function nowOpt(now: (() => string) | undefined): { now: () => string } | Record<string, never> {
  return now !== undefined ? { now } : {};
}

/** Renders `CapabilitySignature.inputs`/`.outputs` (richer, with descriptions) if present, falling back to the plain `Capability.inputs`/`.outputs` string arrays — never fabricating a description that wasn't extracted. */
function formatParams(signatureParams: CapabilitySignature['inputs'], plain: readonly string[]): readonly string[] {
  if (signatureParams.length > 0) return signatureParams.map((p) => (p.description ? `${p.name}: ${p.description}` : p.name));
  return plain;
}

function buildCapabilityProperties(capability: Capability): CapabilityNodeProps {
  const signature = capability.signature;
  return {
    name: capability.canonicalName,
    description: capability.description,
    category: capability.category,
    aliases: capability.aliases,
    inputs: formatParams(signature.inputs, capability.inputs),
    outputs: formatParams(signature.outputs, capability.outputs),
    ...(capability.inputTypes !== undefined ? { inputTypes: capability.inputTypes } : {}),
    sideEffects: signature.sideEffects,
    requiredResources: signature.requiredResources,
    determinism: signature.determinism as XoirDeterminism,
    idempotent: signature.idempotent,
    executionMode: signature.executionMode as XoirExecutionMode,
    estimatedCost: signature.estimatedCost as XoirCostEstimate,
    requiredPermissions: capability.requiredPermissions,
    invocationHints: capability.invocationHints,
    dependencies: capability.dependencies,
    // Not part of CapabilityNodeProps' typed fields (relatedConcepts/examples/relatedKnowledge
    // are free-text or cross-graph references, not signature data) — preserved verbatim here
    // rather than dropped, per the reconciliation report §17's "do not simply stringify... convert
    // its semantics into typed XOIR nodes" (typed where a canonical field exists; carried through
    // as-is otherwise, which is still lossless, just not yet a first-class typed field).
    relatedConcepts: capability.relatedConcepts,
    examples: capability.examples,
    ...(Object.keys(capability.metadata).length > 0 ? { metadata: capability.metadata as unknown as CapabilityNodeProps['metadata'] } : {}),
  } as CapabilityNodeProps;
}

/**
 * Converts a Stage 5 `CapabilityGraph` into canonical XOIR (reconciliation
 * report §17). Preserves, losslessly:
 * - **identity**: `Capability.id` is reused verbatim as the XOIR node id
 *   — this is the specific mechanism that makes the "Send Email" /
 *   "Email Sending" / "Mail Sender" convergence carry through: Stage 5's
 *   own `computeCapabilityId` (`../capabilities/capability-id.ts`)
 *   already folds all three surface forms to one `CapabilityId` before
 *   this adapter ever runs, so converting a `CapabilityGraph` containing
 *   that single, already-merged `Capability` yields exactly one XOIR
 *   `capability` node, with every surface form retained in `aliases`.
 * - **the absorbed `CapabilitySignature`**: every field
 *   (`determinism`/`idempotent`/`executionMode`/`estimatedCost`/
 *   `sideEffects`/`requiredResources`) maps directly onto
 *   `CapabilityNodeProps`, per the reconciliation report §5 — including
 *   `'unknown'` values, verbatim, never resolved into a guess.
 * - **dependencies**: `Capability.dependencies` (a list of other
 *   `CapabilityId`s) becomes both a `CapabilityNodeProps.dependencies`
 *   mirror AND real `REQUIRES` edges to those capability nodes (built in
 *   a second pass, since a dependency capability might be defined later
 *   in `graph.capabilities`).
 * - **required knowledge**: `Capability.requiredKnowledgeNodeIds`
 *   becomes `REQUIRES` edges to the corresponding Stage-4-derived XOIR
 *   nodes, when `options.into` already contains them (see
 *   `CapabilityGraphToXoirOptions.into`'s doc comment) — silently skipped
 *   (not an error) when converting a `CapabilityGraph` standalone,
 *   consistent with `knowledge-to-xoir.ts`'s same policy for edges whose
 *   endpoints aren't present yet.
 * - **relationships**: every `CapabilityRelationship` becomes a XOIR
 *   edge via `edge-mapping.ts`'s total mapping.
 * - **provenance/confidence**: identical treatment to
 *   `knowledge-to-xoir.ts`, reusing `provenance.ts`'s shared helpers
 *   (Stage 5 reuses Stage 4's `KnowledgeProvenance` shape verbatim, so
 *   the conversion logic is genuinely shared, not just similarly named).
 */
export function capabilityGraphToXoir(graph: CapabilityGraph, options: CapabilityGraphToXoirOptions = {}): Result<XoirGraph, XoError> {
  const target = options.into ?? XoirGraph.create(XoirGraphId(options.graphId ?? 'capability-graph'));

  for (const capability of graph.capabilities) {
    const confidenceDetail = toXoirConfidence(capability.confidence, capability.provenance);
    const result = target.createAndAddNode({
      id: XoirNodeId(capability.id),
      kind: 'capability',
      properties: buildCapabilityProperties(capability),
      confidence: capability.confidence,
      confidenceDetail,
      sourceRefs: provenanceToSourceRefs(capability.provenance),
      ...(capability.producedBy !== undefined ? { producedBy: capability.producedBy } : {}),
      ...nowOpt(options.now),
    });
    if (!result.ok) return err(result.error);
  }

  // Second pass: dependency and required-knowledge edges, once every capability (and,
  // if `options.into` was supplied, every knowledge node) is guaranteed to already exist.
  for (const capability of graph.capabilities) {
    for (const depId of capability.dependencies) {
      if (!target.hasNode(XoirNodeId(depId))) continue; // dependency outside this graph's scope — mirror on the node's own `dependencies` property still records it
      const result = target.createAndAddEdge({
        id: XoirEdgeId(`req_${capability.id}_${depId}`),
        kind: 'REQUIRES',
        fromId: XoirNodeId(capability.id),
        toId: XoirNodeId(depId),
        ...nowOpt(options.now),
      });
      if (!result.ok) return err(result.error);
    }
    for (const knowledgeNodeId of capability.requiredKnowledgeNodeIds) {
      if (!target.hasNode(XoirNodeId(knowledgeNodeId))) continue; // not present unless converted via options.into — see doc comment above
      const result = target.createAndAddEdge({
        id: XoirEdgeId(`req_${capability.id}_${knowledgeNodeId}`),
        kind: 'REQUIRES',
        fromId: XoirNodeId(capability.id),
        toId: XoirNodeId(knowledgeNodeId),
        ...nowOpt(options.now),
      });
      if (!result.ok) return err(result.error);
    }
  }

  for (const relationship of graph.relationships) {
    if (!target.hasNode(XoirNodeId(relationship.fromCapabilityId)) || !target.hasNode(XoirNodeId(relationship.toCapabilityId))) continue;
    const result = target.createAndAddEdge({
      id: XoirEdgeId(relationship.id),
      kind: xoirEdgeKindForCapabilityRelationType(relationship.type),
      fromId: XoirNodeId(relationship.fromCapabilityId),
      toId: XoirNodeId(relationship.toCapabilityId),
      confidence: relationship.confidence,
      confidenceDetail: toXoirConfidence(relationship.confidence, relationship.provenance),
      sourceRefs: provenanceToSourceRefs(relationship.provenance),
      ...nowOpt(options.now),
    });
    if (!result.ok) return err(result.error);
  }

  return ok(target);
}
