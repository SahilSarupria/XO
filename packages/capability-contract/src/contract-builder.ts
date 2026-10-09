import { err, ok, type Result } from '@xo/types';
import { CapabilityContractError } from '@xo/errors';
import { ErrorCode } from '@xo/errors';
import type { XoirGraph, XoirNode, XoirNodeId, XoirSourceRef } from '@xo/xoir';
import type { CapabilityNodeProps, DecisionNodeNodeProps, HeuristicNodeProps, ConstraintNodeProps } from '@xo/xoir';
import type { ActionKnowledgeRef, ContractDeterminism, ContractSourceRef, SemanticCapabilityContract, SemanticCapabilityParameter, SemanticCapabilityRule } from './types.js';
import type { StructuredAction, StructuredCondition, StructuredExceptionCondition } from './structured-expression-grammar.js';

const RULE_KINDS = new Set(['decision_node', 'heuristic', 'constraint']);

/** `metadata.subtype` values on a linked `concept` node that the compiler's own Stage 4 operational-content detection (`action-process-detector.ts`) produces — see `ActionKnowledgeRef`'s doc comment in `types.ts`. Not derived from any domain vocabulary; both values are structural/shape classifications, not profession-specific terms. */
const ACTION_KNOWLEDGE_SUBTYPES = new Set(['action', 'process']);

/** Strips `@xo/xoir`'s `XoirSourceRef` down to `ContractSourceRef` — dropping `experienceUnitId`/`charOffsetRange`/`sourceConfidence`, which are XOIR-internal bookkeeping this contract's consumers (potentially Runtime, with no `@xo/xoir` dependency) have no use for, per `types.ts`'s "no @xo/xoir at the type level" rule. Every field kept is copied verbatim, never reinterpreted. */
function toContractSourceRef(ref: XoirSourceRef): ContractSourceRef {
  return {
    documentPath: ref.documentPath,
    ...(ref.locator !== undefined ? { locator: ref.locator } : {}),
    ...(ref.pages !== undefined ? { pages: ref.pages } : {}),
    ...(ref.sectionPath !== undefined ? { sectionPath: ref.sectionPath } : {}),
  };
}

/** `"name: description"` -> `{name, description}`, the inverse of `@xo/compiler`'s `formatParams` (`xoir/capability-to-xoir.ts`) — never fabricates a description the compiler didn't already flatten in. A bare name with no `": "` separator becomes `{name, description: ''}`, not a guess. Explicitly declared parameters carry `derivedFrom: 'declared'`. */
function parseParam(entry: string): SemanticCapabilityParameter {
  const sepIndex = entry.indexOf(': ');
  if (sepIndex === -1) return { name: entry, description: '', derivedFrom: 'declared' };
  return { name: entry.slice(0, sepIndex), description: entry.slice(sepIndex + 2), derivedFrom: 'declared' };
}

/**
 * P0.9A area B (Semantic I/O independence). Overlays a genuine structured
 * type from `CapabilityNodeProps.inputTypes` onto an already-`parseParam`'d
 * input, by name — this is the authoritative source `structured-operation-
 * extractor.ts` populated directly from a real OpenAPI/JSON-Schema
 * declaration, so it takes precedence over the (non-existent, for
 * `explicitInputs`) legacy string-parsing inference. `derivedFrom` stays
 * `'declared'`: the repository's existing vocabulary already means
 * exactly "the source recording explicitly said so", precisely true
 * here, so no new enum value is introduced. When `inputTypes` has no
 * entry for this parameter's name, the param is returned unchanged: never
 * fabricate a type from a name or description.
 */
function applyStructuredInputType(param: SemanticCapabilityParameter, inputTypes: Readonly<Record<string, string>> | undefined): SemanticCapabilityParameter {
  const declaredType = inputTypes?.[param.name];
  if (declaredType === undefined) return param;
  return { ...param, semanticType: normalizeDeclaredType(declaredType) };
}

/**
 * `SemanticCapabilityParameter.semanticType` is a closed 4-value union
 * (`types.ts`), but a raw JSON-Schema `type` (`openapi-frontend.ts`
 * reads it unmodified) ranges over the full JSON Schema vocabulary
 * (`integer`, `array`, `object`, `null`, ...). `'integer'` maps to
 * `'number'` — JSON Schema itself defines integer as a numeric subtype,
 * so this is a faithful narrowing, not a guess. Everything else this
 * union has no honest slot for becomes `'unknown'`, exactly the same
 * "don't resolve what you can't" convention `openapi-frontend.ts`
 * already uses for non-string/unrecognized schema shapes — never a
 * fabricated `'string'`/`'number'`/`'boolean'`.
 */
function normalizeDeclaredType(rawType: string): 'string' | 'number' | 'boolean' | 'unknown' {
  if (rawType === 'string' || rawType === 'number' || rawType === 'boolean') return rawType;
  if (rawType === 'integer') return 'number';
  return 'unknown';
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'to']);

function normalizeParamKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w))
    .join(' ');
}

interface ExtractedField {
  readonly field: string;
  readonly semanticType: 'string' | 'number' | 'boolean' | 'unknown';
}

function extractRuleFields(condition: StructuredCondition | undefined): readonly ExtractedField[] {
  if (!condition) return [];
  const results: ExtractedField[] = [];

  function visit(cond: StructuredCondition) {
    if (cond.type === 'comparison' || cond.type === 'range') {
      if (typeof cond.field === 'string') {
        results.push({ field: cond.field, semanticType: 'number' });
      }
    } else if (cond.type === 'categorical') {
      if (typeof cond.field === 'string') {
        const val = cond.value as unknown;
        let semType: 'string' | 'boolean' | 'unknown' = 'string';
        if (typeof val === 'boolean' || val === 'true' || val === 'false') {
          semType = 'boolean';
        } else if (typeof val === 'string') {
          semType = 'string';
        } else {
          semType = 'unknown';
        }
        results.push({ field: cond.field, semanticType: semType });
      }
    } else if (cond.type === 'temporal') {
      if (typeof cond.field === 'string') {
        results.push({ field: cond.field, semanticType: 'unknown' });
      }
    } else if (cond.type === 'and' || cond.type === 'or') {
      if (Array.isArray(cond.operands)) {
        for (const op of cond.operands) {
          visit(op);
        }
      }
    }
  }

  visit(condition);
  return results;
}

function byId(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Phase 2: `HeuristicNodeProps.structuredCondition` etc. are typed on the
 * XOIR side as loose `Record<string, XoirValue>` bags (see
 * `node-kinds.ts`'s own doc comment on why), but by construction they are
 * always built by `@xo/compiler`'s `structured-semantics.ts` from exactly
 * this package's own `parseStructuredCondition`/`parseStructuredAction`
 * output, JSON-round-tripped. This function is therefore a plain,
 * lossless re-typing of already-validated data — never a place that
 * invents or reinterprets structure — mirroring how `contract-embed.ts`
 * already treats `semanticCapabilityContract` property bags as trusted,
 * pre-shaped JSON.
 */
function toStructuredCondition(value: unknown): StructuredCondition | undefined {
  return value === undefined || value === null ? undefined : (value as unknown as StructuredCondition);
}

function toStructuredAction(value: unknown): StructuredAction | undefined {
  return value === undefined || value === null ? undefined : (value as unknown as StructuredAction);
}

function toStructuredExceptions(value: unknown): readonly StructuredExceptionCondition[] | undefined {
  return value === undefined || value === null ? undefined : (value as unknown as readonly StructuredExceptionCondition[]);
}

function buildRuleFromNode(node: XoirNode): SemanticCapabilityRule | undefined {
  if (node.kind === 'decision_node') {
    const props = node.properties as unknown as DecisionNodeNodeProps;
    const structuredCondition = toStructuredCondition(props.structuredCondition);
    const structuredAction = toStructuredAction(props.structuredAction);
    return {
      sourceNodeId: node.id,
      kind: 'decision_node',
      condition: props.question,
      outcome: props.outcome,
      exceptionConditions: [],
      confidence: node.metadata.confidence,
      ...(structuredCondition !== undefined ? { structuredCondition } : {}),
      ...(structuredAction !== undefined ? { structuredAction } : {}),
    };
  }
  if (node.kind === 'heuristic') {
    const props = node.properties as unknown as HeuristicNodeProps;
    const structuredCondition = toStructuredCondition(props.structuredCondition);
    const structuredAction = toStructuredAction(props.structuredAction);
    const structuredExceptions = toStructuredExceptions(props.structuredExceptions);
    return {
      sourceNodeId: node.id,
      kind: 'heuristic',
      condition: props.condition,
      outcome: props.action,
      exceptionConditions: props.exceptionConditions ?? [],
      confidence: node.metadata.confidence,
      ...(structuredCondition !== undefined ? { structuredCondition } : {}),
      ...(structuredAction !== undefined ? { structuredAction } : {}),
      ...(structuredExceptions !== undefined ? { structuredExceptions } : {}),
    };
  }
  if (node.kind === 'constraint') {
    const props = node.properties as unknown as ConstraintNodeProps;
    const structuredCondition = toStructuredCondition(props.structuredCondition);
    return {
      sourceNodeId: node.id,
      kind: 'constraint',
      condition: props.rule,
      exceptionConditions: [],
      confidence: node.metadata.confidence,
      ...(structuredCondition !== undefined ? { structuredCondition } : {}),
    };
  }
  return undefined;
}

export interface BuildContractOptions {
  /**
   * Which edge kind links a capability node to its supporting rule/decision
   * nodes. Defaults to `'REQUIRES'` — considered in *both* directions (see
   * `direction: 'both'` below), because two independent, equally legitimate
   * `@xo/compiler` mechanisms each produce a real `REQUIRES` edge between a
   * capability and a rule-kind node, in opposite directions:
   *
   *   - `reasoning-to-xoir.ts`/`knowledge-to-xoir.ts`'s best-effort
   *     content-mention linking (`rule-capability-linking.ts`) creates
   *     `decision_node/heuristic/constraint --REQUIRES--> capability` (the
   *     rule node is the edge's `fromId`) — reached via *incoming* edges.
   *   - `capability-to-xoir.ts`'s own `Capability.requiredKnowledgeNodeIds`
   *     pass creates `capability --REQUIRES--> knowledgeNode` (the
   *     capability is the edge's `fromId`) — reached via *outgoing* edges.
   *     `requiredKnowledgeNodeIds` is populated by Stage 5's own
   *     content-mention scan over *every* Stage 4 knowledge node
   *     (`rule-based-extractor.ts#findMentionedKnowledgeNodes` does not
   *     filter by semantic type), so it can and does legitimately name a
   *     `constraint`/`obligation`/`exception` node — i.e. a rule node —
   *     not only `concept`/`fact` ones. Restricting this lookup to
   *     `incoming` only, as an earlier version of this builder did, silently
   *     dropped exactly that case even though the edge already existed in
   *     the graph, deterministically and provenance-backed.
   *
   * Both directions are filtered identically by `RULE_KINDS` below, so
   * `direction: 'both'` never pulls in an unrelated neighbor (e.g. a
   * `dependencies`-derived `capability --REQUIRES--> capability` edge) —
   * only a node of kind `decision_node`/`heuristic`/`constraint` survives
   * either way. Verified directly against every producing adapter's source
   * before writing this, not assumed.
   */
  readonly linkEdgeKind?: string;
}

/**
 * Projects one XOIR `capability` node, plus every `decision_node`/
 * `heuristic`/`constraint` node connected to it by a `REQUIRES` edge in
 * either direction (see `BuildContractOptions.linkEdgeKind`'s doc comment
 * for why both directions are real, independent evidence), into a
 * `SemanticCapabilityContract`. Pure and deterministic: same graph,
 * same capability node id, same contract, every time — no timestamps, no
 * randomness, and never a value invented beyond what the XOIR node itself
 * carries (see `types.ts`'s doc comment).
 *
 * Fails (`CONTRACT_SOURCE_NODE_NOT_FOUND`) if `capabilityNodeId` doesn't
 * resolve to a node in `graph`, and (`CONTRACT_SOURCE_NODE_INVALID`) if it
 * resolves to a node that isn't kind `'capability'` — this builder never
 * silently treats an unrelated node as a capability.
 */
export function buildSemanticCapabilityContract(graph: XoirGraph, capabilityNodeId: XoirNodeId, options: BuildContractOptions = {}): Result<SemanticCapabilityContract, CapabilityContractError> {
  const nodeResult = graph.getNode(capabilityNodeId);
  if (!nodeResult.ok) {
    return err(new CapabilityContractError(ErrorCode.CONTRACT_SOURCE_NODE_NOT_FOUND, `No XOIR node found for capability node id "${capabilityNodeId}"`));
  }
  const node = nodeResult.value;
  if (node.kind !== 'capability') {
    return err(new CapabilityContractError(ErrorCode.CONTRACT_SOURCE_NODE_INVALID, `Node "${capabilityNodeId}" is kind "${node.kind}", not "capability" — cannot build a SemanticCapabilityContract from it`));
  }
  const props = node.properties as unknown as CapabilityNodeProps;

  const linkEdgeKind = options.linkEdgeKind ?? 'REQUIRES';
  // 'both': see BuildContractOptions.linkEdgeKind's doc comment on why a rule node can
  // legitimately be reached via either an incoming (content-mention linking) or outgoing
  // (Capability.requiredKnowledgeNodeIds) REQUIRES edge. The same node can in principle be
  // reached via an edge in each direction at once (independent evidence from two independent
  // passes) — deduped by node id below so it becomes exactly one SemanticCapabilityRule, never
  // a double-counted one.
  // Single `neighbors` call, shared by both the rule-linkage projection
  // (`rules`) and the action/process-knowledge-linkage projection
  // (`actionKnowledgeRefs`) below — both read the exact same edge set,
  // just filtered by a different `kind`/`subtype` predicate, so there is
  // never a risk of the two projections disagreeing about which edges
  // actually exist.
  const allLinkedNodes = graph.neighbors(node.id, { edgeKind: linkEdgeKind as never, direction: 'both' });

  const linkedRuleNodes = allLinkedNodes.filter((n) => RULE_KINDS.has(n.kind));
  const seenRuleNodeIds = new Set<string>();
  const dedupedLinkedRuleNodes = linkedRuleNodes.filter((n) => {
    if (seenRuleNodeIds.has(n.id as unknown as string)) return false;
    seenRuleNodeIds.add(n.id as unknown as string);
    return true;
  });
  const rules = dedupedLinkedRuleNodes
    .map(buildRuleFromNode)
    .filter((r): r is SemanticCapabilityRule => r !== undefined)
    .slice()
    .sort((a, b) => (a.sourceNodeId < b.sourceNodeId ? -1 : a.sourceNodeId > b.sourceNodeId ? 1 : 0));

  // See `ActionKnowledgeRef`'s doc comment (types.ts): a `concept` node
  // the compiler itself tagged `metadata.subtype` `'action'`/`'process'`
  // via Stage 4's shape-based operational-content detection — never a
  // vocabulary/category match on the capability's own text.
  const linkedActionKnowledgeNodes = allLinkedNodes.filter((n) => n.kind === 'concept' && n.metadata.subtype !== undefined && ACTION_KNOWLEDGE_SUBTYPES.has(n.metadata.subtype));
  const seenActionKnowledgeNodeIds = new Set<string>();
  const dedupedActionKnowledgeNodes = linkedActionKnowledgeNodes.filter((n) => {
    if (seenActionKnowledgeNodeIds.has(n.id as unknown as string)) return false;
    seenActionKnowledgeNodeIds.add(n.id as unknown as string);
    return true;
  });
  const actionKnowledgeRefs: readonly ActionKnowledgeRef[] = dedupedActionKnowledgeNodes
    .map((n) => ({ sourceNodeId: n.id as string, subtype: n.metadata.subtype! }))
    .slice()
    .sort((a, b) => (a.sourceNodeId < b.sourceNodeId ? -1 : a.sourceNodeId > b.sourceNodeId ? 1 : 0));

  const explicitInputs = (props.inputs ?? []).map((entry) => applyStructuredInputType(parseParam(entry), props.inputTypes));
  const seenInputKeys = new Set<string>();
  for (const input of explicitInputs) {
    const normKey = normalizeParamKey(input.name);
    if (normKey) seenInputKeys.add(normKey);
    seenInputKeys.add(input.name.trim().toLowerCase());
  }

  const promotedInputs: SemanticCapabilityParameter[] = [];
  for (const rule of rules) {
    if (!rule.structuredCondition) continue;
    const extracted = extractRuleFields(rule.structuredCondition);
    for (const item of extracted) {
      const cleanName = item.field.trim();
      if (!cleanName) continue;

      const normKey = normalizeParamKey(cleanName);
      const exactKey = cleanName.toLowerCase();

      if ((normKey && seenInputKeys.has(normKey)) || seenInputKeys.has(exactKey)) {
        continue;
      }

      if (normKey) seenInputKeys.add(normKey);
      seenInputKeys.add(exactKey);

      promotedInputs.push({
        name: cleanName,
        description: '',
        derivedFrom: 'rule_derived',
        semanticType: item.semanticType,
      });
    }
  }

  const inputs = [...explicitInputs, ...promotedInputs];

  const determinism: ContractDeterminism = props.determinism ?? 'unknown';

  const contract: SemanticCapabilityContract = {
    id: node.id,
    name: props.name,
    description: props.description,
    ...(props.category !== undefined ? { category: props.category } : {}),
    inputs,
    outputs: (props.outputs ?? []).map(parseParam),
    requiredPermissions: props.requiredPermissions ?? [],
    determinism,
    rules,
    actionKnowledgeRefs,
    confidence: node.metadata.confidence,
    sourceRefs: node.metadata.sourceRefs.map(toContractSourceRef),
    sourceXoirNodeIds: [node.id as string, ...rules.map((r) => r.sourceNodeId), ...actionKnowledgeRefs.map((r) => r.sourceNodeId)].sort(),
  };

  return ok(contract);
}

/** Convenience: every `capability` node in `graph`, each built into its own contract independently. A single node's build failure does not abort the whole batch — see `results`'s per-id outcome. */
export function buildAllSemanticCapabilityContracts(graph: XoirGraph, options: BuildContractOptions = {}): readonly Result<SemanticCapabilityContract, CapabilityContractError>[] {
  const capabilityNodes = graph.allNodes().filter((n) => n.kind === 'capability').slice().sort(byId);
  return capabilityNodes.map((n) => buildSemanticCapabilityContract(graph, n.id, options));
}
