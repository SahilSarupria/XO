/**
 * Execution-readiness analysis: keeps what the COMPILER understood and how the rule can EXECUTE as two separate facts.
 *
 *   compilerState:  resolved | partially_resolved | unresolved   — how completely the meaning was captured
 *   executionState: deterministic | human_required | not_executable — how (and whether) it can run
 *
 * Collapsing these is what produced "everything is deny/escalate": an unrecognised clause (a compiler state) was reported
 * with the same outcome as a clause that genuinely requires escalation (a policy outcome). Here a rule whose meaning is
 * known but that needs a person is `resolved` + `human_required`; one whose condition could not be structured is
 * `unresolved` + `not_executable`, with the reason stated. A blocker is always explicit; nothing is guessed.
 *
 * Pure and deterministic: it only reads typed node properties. It never introduces a connector, an integration or an
 * authorisation — "external integration required" is decided by declared capability contracts, not inferred from prose.
 */
import type { XoirGraph } from '@xo/xoir';
import { nodesOfKind } from '@xo/xoir';

export type CompilerState = 'resolved' | 'partially_resolved' | 'unresolved';
export type ExecutionState = 'deterministic' | 'human_required' | 'not_executable';

export interface ReadinessEntry {
  readonly nodeId: string;
  readonly kind: 'heuristic' | 'decision_node' | 'constraint';
  readonly label: string;
  /** The rule's condition text as written (absent for unconditional statements). */
  readonly condition: string | undefined;
  readonly compilerState: CompilerState;
  readonly executionState: ExecutionState;
  /** Fact names the rule's structured condition needs in order to be evaluated. Empty when there is no structured condition. */
  readonly requiredInputs: readonly string[];
  /** Why the rule is not (fully) executable. Empty only for `resolved` + `deterministic`/`human_required` rules. */
  readonly blockers: readonly string[];
  readonly modality: string | undefined;
  readonly outcomeType: string | undefined;
}

/** A connector the CALLER declares, with the operation names it can perform. Connectors are never inferred from prose. */
export interface ConnectorDeclaration {
  readonly id: string;
  readonly operations: readonly string[];
}

export type CapabilityExecutionState = 'bound_to_connector' | 'external_integration_required' | 'not_executable';

export interface CapabilityReadinessEntry {
  readonly nodeId: string;
  readonly name: string;
  /** `declared-operation`: a source (OpenAPI / structured) explicitly declares this operation. `discovered`: found in prose. */
  readonly origin: 'declared-operation' | 'discovered';
  readonly requiredInputs: readonly string[];
  readonly executionState: CapabilityExecutionState;
  readonly connectorId?: string;
  readonly blockers: readonly string[];
}

export interface CapabilityReadiness {
  readonly entries: readonly CapabilityReadinessEntry[];
  readonly summary: Readonly<Record<CapabilityExecutionState, number>>;
  /** Operations a connector claims to perform that no source declares. Reported, never silently accepted. */
  readonly unmatchedConnectorOperations: readonly { readonly connectorId: string; readonly operation: string }[];
}

export interface ExecutionReadiness {
  readonly entries: readonly ReadinessEntry[];
  readonly capabilities: CapabilityReadiness;
  readonly summary: {
    readonly byCompilerState: Readonly<Record<CompilerState, number>>;
    readonly byExecutionState: Readonly<Record<ExecutionState, number>>;
  };
}

interface LooseCondition {
  readonly type?: string;
  readonly field?: string;
  readonly operands?: readonly LooseCondition[];
}

function collectFields(condition: LooseCondition | undefined, into: Set<string>): void {
  if (condition === undefined) return;
  if (typeof condition.field === 'string' && condition.field.length > 0) into.add(condition.field);
  for (const operand of condition.operands ?? []) collectFields(operand, into);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

function analyzeCapabilities(graph: XoirGraph, connectors: readonly ConnectorDeclaration[]): CapabilityReadiness {
  const norm = (x: string): string => x.trim().toLowerCase();
  const entries: CapabilityReadinessEntry[] = [];
  const declaredNames = new Set<string>();
  for (const node of nodesOfKind(graph, 'capability')) {
    const p = node.properties as Record<string, unknown>;
    const name = str(p['name']) ?? node.id;
    const declared = ((p['metadata'] as Record<string, unknown> | undefined)?.['sourceExtractor'] ?? undefined) === 'structured-operation';
    const requiredInputs = Array.isArray(p['inputs'])
      ? (p['inputs'] as unknown[]).filter((i): i is string => typeof i === 'string').map((i) => i.split(':')[0]!.trim())
      : [];
    if (!declared) {
      entries.push({
        nodeId: node.id,
        name,
        origin: 'discovered',
        requiredInputs,
        executionState: 'not_executable',
        blockers: ['discovered from prose: no declared operation contract, so it cannot be bound to a connector'],
      });
      continue;
    }
    declaredNames.add(norm(name));
    const connector = connectors.find((c) => c.operations.some((o) => norm(o) === norm(name)));
    entries.push(
      connector !== undefined
        ? {
            nodeId: node.id,
            name,
            origin: 'declared-operation',
            requiredInputs,
            executionState: 'bound_to_connector',
            connectorId: connector.id,
            blockers: [],
          }
        : {
            nodeId: node.id,
            name,
            origin: 'declared-operation',
            requiredInputs,
            executionState: 'external_integration_required',
            blockers: [`operation "${name}" is declared by a source but no connector is bound to it`],
          },
    );
  }
  const unmatched = connectors.flatMap((c) =>
    c.operations.filter((o) => !declaredNames.has(norm(o))).map((operation) => ({ connectorId: c.id, operation })),
  );
  const summary: Record<CapabilityExecutionState, number> = { bound_to_connector: 0, external_integration_required: 0, not_executable: 0 };
  for (const e of entries) summary[e.executionState] += 1;
  return { entries, summary, unmatchedConnectorOperations: unmatched };
}

export function analyzeExecutionReadiness(graph: XoirGraph, connectors: readonly ConnectorDeclaration[] = []): ExecutionReadiness {
  const entries: ReadinessEntry[] = [];
  for (const kind of ['heuristic', 'decision_node', 'constraint'] as const) {
    for (const node of nodesOfKind(graph, kind)) {
      const p = node.properties as Record<string, unknown>;
      const modality = str(p['modality']);
      const outcomeType = str(p['outcomeType']);
      if (modality === undefined) continue; // companion nodes (e.g. exception overrides) carry no outcome of their own
      const rawCondition = str(p['condition']) ?? str(p['question']);
      // XOIR conversion falls back to the node's own label for a missing condition, so a "condition" identical to the outcome
      // text is that fallback, not a real condition.
      const condition = rawCondition !== undefined && rawCondition === (str(p['outcome']) ?? str(p['action'])) ? undefined : rawCondition;
      const structured = (p['structuredCondition'] ?? undefined) as LooseCondition | undefined;
      const exceptions = Array.isArray(p['exceptionConditions']) ? (p['exceptionConditions'] as unknown[]).length : 0;
      const label = str(p['action']) ?? str(p['outcome']) ?? str(p['rule']) ?? condition ?? node.id;
      const blockers: string[] = [];
      const inputs = new Set<string>();
      collectFields(structured, inputs);

      let compilerState: CompilerState = 'resolved';
      if (kind === 'constraint') {
        blockers.push('constraint: a declared obligation or limit has no decision-table outcome to execute');
      } else if (condition === undefined) {
        blockers.push('no condition: an unconditional statement has nothing to bind a decision to');
      } else if (structured === undefined) {
        compilerState = 'unresolved';
        blockers.push('condition could not be structured; its text is preserved but cannot be evaluated');
      }
      if (exceptions > 0) {
        compilerState = compilerState === 'unresolved' ? 'unresolved' : 'partially_resolved';
        blockers.push(`${exceptions} exception condition(s) preserved as text and not evaluable`);
      }
      if (modality === 'permission' || modality === 'advisory') {
        blockers.push(`${modality} modality: not a mandatory outcome, so it is not minted as an executable rule`);
      }
      if (modality === 'mixed')
        blockers.push('mixed modality: combines a requirement and a prohibition; it must be split before execution');

      let executionState: ExecutionState = 'not_executable';
      if (blockers.length === 0)
        executionState = outcomeType === 'requires_approval' || outcomeType === 'escalate' ? 'human_required' : 'deterministic';

      entries.push({
        nodeId: node.id,
        kind,
        label,
        condition,
        compilerState,
        executionState,
        requiredInputs: [...inputs].sort(),
        blockers,
        modality,
        outcomeType,
      });
    }
  }
  const byCompilerState: Record<CompilerState, number> = { resolved: 0, partially_resolved: 0, unresolved: 0 };
  const byExecutionState: Record<ExecutionState, number> = { deterministic: 0, human_required: 0, not_executable: 0 };
  for (const e of entries) {
    byCompilerState[e.compilerState] += 1;
    byExecutionState[e.executionState] += 1;
  }
  return { entries, capabilities: analyzeCapabilities(graph, connectors), summary: { byCompilerState, byExecutionState } };
}
