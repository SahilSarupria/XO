import type {
  CapabilityDeclaration,
  CompatibilityDeclaration,
  ComponentEntry,
  ComponentKind,
  DependencyDeclaration,
  DependencyKind,
  XoManifest,
  XoMetadata,
} from '@xo/types';

const COMPONENT_KINDS: readonly ComponentKind[] = [
  'knowledge_graph',
  'long_term_memory_graph',
  'decision_trees',
  'reasoning_traces',
  'case_library',
  'prompt_strategies',
  'lora',
  'finetune',
  'safety_rules',
  'benchmark_suite',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isContentHash(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isComponentEntry(value: unknown): value is ComponentEntry {
  return isRecord(value) && typeof value.path === 'string' && isContentHash(value.hash) && typeof value.required === 'boolean';
}

function isCompatibilityDeclaration(value: unknown): value is CompatibilityDeclaration {
  if (!isRecord(value) || !Array.isArray(value.modelFamilies)) return false;
  if (value.fallbackPolicy !== 'degrade_gracefully' && value.fallbackPolicy !== 'reject') return false;
  return value.modelFamilies.every(
    (mf) => isRecord(mf) && typeof mf.family === 'string' && Array.isArray(mf.minCapability) && Array.isArray(mf.consumes),
  );
}

/**
 * Mirrors `@xo/types`' `CapabilityExecutionMode` union exactly, member
 * for member — kept in sync manually (as `EXECUTION_MODES` already was
 * for R5's `'hybrid'` addition), not compiler-enforced. Widened to
 * include `'human_in_the_loop'` for the Human-in-the-Loop Execution
 * Class Lowering milestone: without this entry, `PackageValidator`
 * rejects every manifest containing a `human_in_the_loop` declaration at
 * install time, even though `capability-lowering.ts` now produces one —
 * this is the schema-validation half of the same taxonomy widening,
 * not a new validation rule.
 */
const EXECUTION_MODES = ['deterministic_rule', 'model', 'hybrid', 'human_in_the_loop'];
const HYBRID_STEP_STRATEGIES = ['deterministic_rule', 'model'];
const INPUT_PROPERTY_TYPES = ['string', 'number', 'boolean'];

function isCapabilityInputSchema(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type !== 'object') return false;
  if (!isRecord(value.properties)) return false;
  if (!Object.values(value.properties).every((p) => isRecord(p) && INPUT_PROPERTY_TYPES.includes(p.type as string))) return false;
  if (!Array.isArray(value.required) || !value.required.every((r) => typeof r === 'string')) return false;
  return true;
}

/**
 * `HybridStepInputSource` (`@xo/types`) — a plain `kind`-discriminated
 * reference to either the original request or a named prior step's
 * output. Structural validation only, mirroring every other validator in
 * this file: it does not check that a `{ kind: 'step' }` reference's
 * `stepId` actually names an earlier step in the same list — that's an
 * ordering/graph property, not a shape property, and is enforced at
 * runtime by `HybridExecutionExecutor` (`@xo/runtime`), the same
 * division of labor R2's `inputSchema` already has with
 * `validateCapabilityInput`.
 */
function isHybridStepInputSource(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'request') return true;
  if (value.kind === 'step') return typeof value.stepId === 'string' && value.stepId.length > 0;
  return false;
}

/**
 * `HybridExecutionStep` (`@xo/types`) — one entry of a `'hybrid'`-mode
 * capability's `hybridSteps` list. `strategy` is checked against the
 * same two atomic values `EXECUTION_MODES` recognizes minus `'hybrid'`
 * itself — a hybrid step declaring `strategy: 'hybrid'` is rejected here
 * structurally, the package-format-level enforcement of R5's
 * no-recursive-nesting rule (the type system already forecloses this for
 * normal TypeScript-checked code; this is the same guarantee for a
 * hand-built or third-party-compiler-emitted manifest that bypasses the
 * type checker entirely).
 */
function isHybridExecutionStep(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.stepId !== 'string' || value.stepId.length === 0) return false;
  if (!HYBRID_STEP_STRATEGIES.includes(value.strategy as string)) return false;
  if (!isHybridStepInputSource(value.input)) return false;
  if (value.bindingId !== undefined && typeof value.bindingId !== 'string') return false;
  if (value.contractId !== undefined && typeof value.contractId !== 'string') return false;
  if (value.inputSchema !== undefined && !isCapabilityInputSchema(value.inputSchema)) return false;
  return true;
}

/**
 * R5 structural closure. `isHybridExecutionStep` checks each step's own
 * shape in isolation; this checks the *list's* referential integrity —
 * the two properties the R5 contract requires and that
 * `HybridExecutionExecutor` (`@xo/runtime`) already relies on holding by
 * the time a declaration reaches it:
 *
 *   1. every `stepId` in the list is unique (two steps sharing a
 *      `stepId` would make `{ kind: 'step', stepId }` references and the
 *      resulting `ExecutionReceipt.hybridSteps` audit trail ambiguous —
 *      which step does the id actually name?);
 *   2. every `{ kind: 'step', stepId }` reference names a step that
 *      appears strictly *before* the referencing step in declared order
 *      — never itself (a self-reference) and never a step declared
 *      later (a forward reference). `HybridExecutionExecutor` runs
 *      steps strictly in array order and only records a step's output
 *      once it completes, so a self- or forward-reference can never
 *      resolve at runtime; failing it here, at package-validation time,
 *      surfaces that as an install-time integrity error instead of a
 *      confusing `RUNTIME_INVALID_REQUEST` at first execution.
 *
 * This is still purely structural — a graph/ordering property of a
 * fixed, already-small list — not a general expression/mapping system;
 * it does not evaluate, resolve, or interpret anything a step's `input`
 * says beyond "does this name land somewhere valid in this list."
 */
function hasWellFormedHybridStepOrdering(hybridSteps: readonly Record<string, unknown>[]): boolean {
  const seenStepIds = new Set<string>();
  for (const step of hybridSteps) {
    const stepId = step.stepId as string;
    if (seenStepIds.has(stepId)) return false; // duplicate stepId
    seenStepIds.add(stepId);
  }
  return hybridSteps.every((step, index) => {
    const input = step.input as { readonly kind: string; readonly stepId?: string };
    if (input.kind !== 'step') return true;
    const referencedIndex = hybridSteps.findIndex((candidate) => candidate.stepId === input.stepId);
    return referencedIndex !== -1 && referencedIndex < index; // must exist, and be strictly earlier — rejects both a dangling reference and a self/forward reference
  });
}

/**
 * `execution` is OPTIONAL on `CapabilityDeclaration` (R1) — this
 * validator is only reached when a declaration actually has one, so a
 * `.xo` package compiled before this field existed still validates
 * exactly as it did before. When present, though, it's validated
 * strictly: a malformed `execution` block is a package integrity
 * problem (a runtime that trusted it could execute against a wrong or
 * absent schema), so it's rejected here rather than being passed through
 * for a runtime to discover the hard way.
 */
function isCapabilityExecutionDeclaration(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!EXECUTION_MODES.includes(value.mode as string)) return false;
  if (value.bindingId !== undefined && typeof value.bindingId !== 'string') return false;
  if (value.contractId !== undefined && typeof value.contractId !== 'string') return false;
  if (value.inputSchema !== undefined && !isCapabilityInputSchema(value.inputSchema)) return false;
  if (value.requiredPermissionIds !== undefined && (!Array.isArray(value.requiredPermissionIds) || !value.requiredPermissionIds.every((p) => typeof p === 'string'))) return false;
  // R5: hybridSteps is meaningful only for mode: 'hybrid', but is checked
  // structurally whenever present (a non-hybrid declaration that somehow
  // carries a hybridSteps array is just as malformed as one with a wrong
  // bindingId type — reject rather than silently ignore).
  if (value.hybridSteps !== undefined && (!Array.isArray(value.hybridSteps) || !value.hybridSteps.every(isHybridExecutionStep))) return false;
  if (value.mode === 'hybrid' && (!Array.isArray(value.hybridSteps) || value.hybridSteps.length === 0)) return false;
  if (value.mode === 'hybrid' && Array.isArray(value.hybridSteps) && !hasWellFormedHybridStepOrdering(value.hybridSteps as Record<string, unknown>[])) return false;
  return true;
}

function isCapabilityDeclaration(value: unknown): value is CapabilityDeclaration {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || value.id.length === 0) return false;
  if (typeof value.name !== 'string' || value.name.length === 0) return false;
  if (typeof value.description !== 'string' || value.description.length === 0) return false;
  if (!Array.isArray(value.providerCompatibility) || !value.providerCompatibility.every((f) => typeof f === 'string')) return false;
  if (!Array.isArray(value.requiredComponents) || !value.requiredComponents.every((k) => COMPONENT_KINDS.includes(k as ComponentKind))) return false;
  if (!isRecord(value.estimatedCost) || typeof value.estimatedCost.currency !== 'string' || typeof value.estimatedCost.amount !== 'number') return false;
  if (typeof value.estimatedLatencyMs !== 'number') return false;
  if (!isRecord(value.confidence) || typeof value.confidence.score !== 'number') return false;
  if (!['self_reported', 'benchmark', 'expert_review'].includes(value.confidence.basis as string)) return false;
  if (value.execution !== undefined && !isCapabilityExecutionDeclaration(value.execution)) return false;
  return true;
}

const DEPENDENCY_KINDS: readonly DependencyKind[] = ['required', 'optional', 'peer'];

function isDependencyDeclaration(value: unknown): value is DependencyDeclaration {
  if (!isRecord(value)) return false;
  if (typeof value.name !== 'string' || value.name.length === 0) return false;
  if (typeof value.versionRange !== 'string' || value.versionRange.length === 0) return false;
  if (!DEPENDENCY_KINDS.includes(value.kind as DependencyKind)) return false;
  return true;
}

/**
 * A structural (not semantic) check that `value` has the shape of an
 * {@link XoManifest} — every field of the right type, present where
 * required. It does NOT check hash correctness, Merkle consistency, or
 * signature validity; those are `PackageValidator`'s job precisely because
 * they can fail independently of shape (a well-formed manifest can still
 * lie about its hashes). Used by the reader to reject obviously-malformed
 * JSON before it's ever handed to the rest of the SDK as a typed value.
 */
export function isXoManifest(value: unknown): value is XoManifest {
  if (!isRecord(value)) return false;
  if (typeof value.formatVersion !== 'string') return false;
  if (typeof value.name !== 'string' || value.name.length === 0) return false;
  if (typeof value.version !== 'string') return false;
  if (typeof value.creatorDid !== 'string' || value.creatorDid.length === 0) return false;
  if (!isCompatibilityDeclaration(value.compatibility)) return false;
  if (!isRecord(value.components)) return false;
  for (const [kind, entry] of Object.entries(value.components)) {
    if (!COMPONENT_KINDS.includes(kind as ComponentKind)) return false;
    if (!isComponentEntry(entry)) return false;
  }
  if (value.capabilities !== undefined) {
    if (!Array.isArray(value.capabilities) || !value.capabilities.every(isCapabilityDeclaration)) return false;
  }
  if (value.dependencies !== undefined) {
    if (!Array.isArray(value.dependencies) || !value.dependencies.every(isDependencyDeclaration)) return false;
  }
  if (value.merkleRoot !== undefined && !isContentHash(value.merkleRoot)) return false;
  if (value.signatures !== undefined) {
    if (!Array.isArray(value.signatures)) return false;
    const rolesOk = value.signatures.every(
      (s) => isRecord(s) && typeof s.signerDid === 'string' && ['creator', 'reviewer', 'co_signer'].includes(s.role as string) && typeof s.signature === 'string',
    );
    if (!rolesOk) return false;
  }
  return true;
}

export function isXoMetadata(value: unknown): value is XoMetadata {
  return (
    isRecord(value) &&
    typeof value.domain === 'string' &&
    typeof value.description === 'string' &&
    Array.isArray(value.scope) &&
    Array.isArray(value.limitations) &&
    (value.tags === undefined || Array.isArray(value.tags))
  );
}

export { COMPONENT_KINDS };
