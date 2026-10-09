import type { Diagnostic, Pass, PassContext, PassResult, XoirEdge, XoirEdgeId, XoirNode, XoirNodeId } from '@xo/xoir';
import type { KnownReasoningNodeType } from '../reasoning/types.js';

export const REASONING_VALIDATION_PASS_NAME = 'reasoning-validation';

const KNOWN_REASONING_NODE_TYPES = new Set<KnownReasoningNodeType>(['rule', 'prerequisite', 'prohibition', 'policy', 'decision', 'alternative', 'justification', 'exception', 'escalation', 'risk_threshold']);

function isReasoningSourced(node: XoirNode): boolean {
  return typeof node.metadata.subtype === 'string' && KNOWN_REASONING_NODE_TYPES.has(node.metadata.subtype as KnownReasoningNodeType);
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

/**
 * Required-content checks, per canonical kind, for nodes whose `subtype`
 * marks them as Stage-7-sourced. This is the specific gap generic XOIR
 * structural validation (`@xo/xoir#validateGraph`) cannot close: it only
 * checks that a required property key is *present*
 * (`REQUIRED_PROPERTIES_BY_KNOWN_KIND` in `validation.ts`), not that its
 * value is meaningful - an explicitly empty-string `question`/
 * `condition`/`rule` passes structural validation today, and per Stage
 * 7's own semantic model (a rule is a condition-implies-action
 * structure; a decision is a question with an outcome) an empty one is
 * not a rule or a decision, it's a placeholder.
 *
 * Deliberately does NOT check `rationale` on `decision_node` (honestly
 * absent is valid - see `reasoning-to-xoir.ts`'s "unknown preferable to
 * fabricated" fallback of `''`) or any field a Stage 7 node type doesn't
 * claim to have.
 */
function checkRequiredContent(node: XoirNode, diagnostics: Diagnostic[]): void {
  const subtype = node.metadata.subtype as KnownReasoningNodeType;
  const props = node.properties as Record<string, unknown>;

  const report = (code: string, message: string) => {
    diagnostics.push({ severity: 'error', message, passName: REASONING_VALIDATION_PASS_NAME, code, nodeId: node.id });
  };

  switch (node.kind) {
    case 'decision_node': {
      if (isBlank(props.question)) report('DECISION_MISSING_REQUIRED_STRUCTURE', `Decision node "${node.id}" (${subtype}) has no meaningful question/condition`);
      if (isBlank(props.outcome)) report('DECISION_MISSING_REQUIRED_STRUCTURE', `Decision node "${node.id}" (${subtype}) has no meaningful outcome`);
      return;
    }
    case 'heuristic': {
      if (isBlank(props.condition)) report('RULE_MISSING_REQUIRED_STRUCTURE', `Rule node "${node.id}" (${subtype}) has no meaningful condition`);
      if (isBlank(props.action)) report('RULE_MISSING_REQUIRED_STRUCTURE', `Rule node "${node.id}" (${subtype}) has no meaningful action`);
      return;
    }
    case 'constraint': {
      if (isBlank(props.rule)) report('REASONING_INVALID_STRUCTURE', `Constraint node "${node.id}" (${subtype}) has no meaningful rule text`);
      return;
    }
    case 'escalation_rule': {
      if (isBlank(props.triggerCondition)) report('REASONING_INVALID_STRUCTURE', `Escalation node "${node.id}" has no meaningful trigger condition`);
      if (isBlank(props.escalationTarget)) report('REASONING_INVALID_STRUCTURE', `Escalation node "${node.id}" has no meaningful escalation target`);
      return;
    }
    case 'risk_policy': {
      if (isBlank(props.domain)) report('REASONING_INVALID_STRUCTURE', `Risk threshold node "${node.id}" has no meaningful domain/metric`);
      if (isBlank(props.toleranceLevel)) report('REASONING_INVALID_STRUCTURE', `Risk threshold node "${node.id}" has no meaningful tolerance/threshold description`);
      return;
    }
    case 'reasoning_step': {
      if (isBlank(props.premise)) report('REASONING_INVALID_STRUCTURE', `Justification node "${node.id}" has no meaningful rationale/premise`);
      if (isBlank(props.conclusion)) report('REASONING_INVALID_STRUCTURE', `Justification node "${node.id}" has no meaningful outcome/conclusion`);
      return;
    }
    default:
      return;
  }
}

/**
 * ALTERNATIVE_TO is Stage 7's own edge kind, meaning "these are
 * mutually-exclusive decision branches." Both endpoints must actually be
 * decision_nodes - an ALTERNATIVE_TO edge pointing at, say, a fact node
 * isn't expressing a real alternative-decision relationship, it's a
 * malformed edge.
 */
function checkAlternativeTo(edge: XoirEdge, fromNode: XoirNode, toNode: XoirNode, diagnostics: Diagnostic[]): void {
  if (fromNode.kind !== 'decision_node') {
    diagnostics.push({
      severity: 'error',
      message: `ALTERNATIVE_TO edge "${edge.id}" originates from a "${fromNode.kind}" node, not a decision_node`,
      passName: REASONING_VALIDATION_PASS_NAME,
      code: 'INVALID_REASONING_RELATIONSHIP',
      edgeId: edge.id,
    });
  }
  if (toNode.kind !== 'decision_node') {
    diagnostics.push({
      severity: 'error',
      message: `ALTERNATIVE_TO edge "${edge.id}" targets a "${toNode.kind}" node, not a decision_node`,
      passName: REASONING_VALIDATION_PASS_NAME,
      code: 'INVALID_REASONING_RELATIONSHIP',
      edgeId: edge.id,
    });
  }
}

const OVERRIDABLE_TARGET_KINDS = new Set(['heuristic', 'decision_node', 'constraint', 'escalation_rule', 'risk_policy']);

/**
 * SUPERSEDES predates Stage 7 (core XOIR taxonomy), so this check only
 * applies when the edge is Stage-7-sourced (at least one endpoint
 * carries a Stage 7 subtype) - a future, unrelated SUPERSEDES producer
 * is never subject to this pass's opinion about what "override" means.
 */
function checkOverrides(edge: XoirEdge, toNode: XoirNode, diagnostics: Diagnostic[]): void {
  if (OVERRIDABLE_TARGET_KINDS.has(toNode.kind)) return;
  diagnostics.push({
    severity: 'error',
    message: `Override edge "${edge.id}" targets a "${toNode.kind}" node, which has no rule/decision/constraint content to override`,
    passName: REASONING_VALIDATION_PASS_NAME,
    code: 'INVALID_REASONING_RELATIONSHIP',
    edgeId: edge.id,
  });
}

function checkSelfReference(edge: XoirEdge, diagnostics: Diagnostic[]): void {
  if (edge.fromId !== edge.toId) return;
  diagnostics.push({
    severity: 'error',
    message: `Edge "${edge.id}" (${edge.kind}) references the same node as both endpoints`,
    passName: REASONING_VALIDATION_PASS_NAME,
    code: 'INVALID_REASONING_RELATIONSHIP',
    edgeId: edge.id,
  });
}

const REASONING_RELATIONSHIP_EDGE_KINDS = new Set(['REQUIRES', 'SUPERSEDES', 'ALTERNATIVE_TO', 'SUPPORTS', 'CONTRADICTS', 'TRIGGERED_BY', 'GOVERNS', 'DEPENDS_ON']);

function byId(a: XoirNodeId | XoirEdgeId, b: XoirNodeId | XoirEdgeId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Stage 7's conservative semantic validation pass - the gap generic XOIR
 * structural validation cannot close because it is deliberately
 * domain-agnostic. Two kinds of check, both scoped to Stage-7-sourced
 * content only (identified by metadata.subtype) so Stage 4/5 content and
 * any future non-Stage-7 producer reusing the same canonical kinds/edge
 * kinds is never affected:
 *
 * 1. Required-content checks (checkRequiredContent) - a Stage-7-sourced
 *    node's semantically-required text fields (condition/action for a
 *    rule, question/outcome for a decision, ...) must be non-blank, not
 *    merely present.
 * 2. Relationship-shape checks - ALTERNATIVE_TO must connect two
 *    decision_nodes (checkAlternativeTo); a Stage-7-sourced SUPERSEDES
 *    (override) edge must target something with rule/decision/
 *    constraint content (checkOverrides); no Stage-7-relevant edge may
 *    be a self-loop (checkSelfReference).
 *
 * Deliberately does NOT check for dangling edge endpoints (missing
 * nodes) - that is already @xo/xoir#validateGraph's
 * dangling_edge_reference check, reused via validate-pass.ts, not
 * duplicated here. Deliberately does NOT reject any node/graph merely
 * for being *incomplete* (a unit that produced no structured reasoning
 * contributes no nodes at all, which is correct, not an error).
 *
 * Runs after generic XOIR validation and before normalization
 * (compile.ts), gating downstream compilation the identical way generic
 * validation does - see that file's doc comment.
 */
export function createReasoningValidationPass(): Pass {
  return {
    name: REASONING_VALIDATION_PASS_NAME,
    // Not registered as a hard `dependsOn` against the generic validation pass name -- same reasoning
    // as normalize-pass.ts: compile.ts always registers this pass after xoir-validation explicitly, and
    // a hard dependency would make this pass unusable standalone (e.g. in isolation, in a test) without
    // also registering a pass it doesn't actually need the *output* of (this pass reads the raw graph
    // directly, not xoir-validation's diagnostics).
    dependsOn: [],
    run(context: PassContext): PassResult {
      const diagnostics: Diagnostic[] = [];

      for (const node of [...context.graph.allNodes()].sort((a, b) => byId(a.id, b.id))) {
        if (isReasoningSourced(node)) checkRequiredContent(node, diagnostics);
      }

      for (const edge of [...context.graph.allEdges()].sort((a, b) => byId(a.id, b.id))) {
        if (!REASONING_RELATIONSHIP_EDGE_KINDS.has(edge.kind)) continue;

        const fromNode = context.graph.getNode(edge.fromId);
        const toNode = context.graph.getNode(edge.toId);
        if (!fromNode.ok || !toNode.ok) continue;

        const stage7Relevant = isReasoningSourced(fromNode.value) || isReasoningSourced(toNode.value);
        if (!stage7Relevant && edge.kind !== 'ALTERNATIVE_TO') continue;

        checkSelfReference(edge, diagnostics);
        if (edge.kind === 'ALTERNATIVE_TO') checkAlternativeTo(edge, fromNode.value, toNode.value, diagnostics);
        if (edge.kind === 'SUPERSEDES') checkOverrides(edge, toNode.value, diagnostics);
      }

      return { graph: context.graph, diagnostics };
    },
  };
}
