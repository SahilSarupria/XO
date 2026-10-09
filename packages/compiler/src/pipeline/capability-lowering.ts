import type { CapabilityDeclaration, CapabilityExecutionDeclaration, CapabilityInputPropertyType, CapabilityInputSchema, ModelFamily } from '@xo/types';
import type { XoirGraph } from '@xo/xoir';
import { XoirNodeId, createManifest } from '@xo/xoir';
import { ContentHash } from '@xo/types';
import { parsePermissionId } from '@xo/permissions';
import {
  buildAllSemanticCapabilityContracts,
  computeContractContentHash,
  embedResolvedContractInCapabilityNode,
  resolveCapabilityBinding,
  STANDARD_BINDING_RESOLVERS,
  type BindingOutcome,
  type BindingResolver,
  type CapabilityBinding,
  type SemanticCapabilityContract,
} from '@xo/capability-contract';

/**
 * The compiler-side half of the capability lowering boundary:
 *
 *   XOIR `capability` node
 *     -> SemanticCapabilityContract        (@xo/capability-contract, reused verbatim)
 *     -> BindingOutcome                    (@xo/capability-contract, reused verbatim)
 *     -> ManifestCapabilityDeclaration      (@xo/types' `CapabilityDeclaration` — this module's only new output type)
 *
 * This module does not implement contract-building or binding resolution
 * itself — both already exist in `@xo/capability-contract` and are reused
 * as-is (`buildAllSemanticCapabilityContracts`, `resolveCapabilityBinding`).
 * Its only job is the last, previously-missing step: deciding which
 * `BindingOutcome`s are eligible to become a manifest-level, self-reported
 * `CapabilityDeclaration`, and building that declaration from a contract +
 * its resolved binding without inventing any field neither one actually
 * carries.
 *
 * Eligibility is exactly `BindingOutcome.status === 'resolved'` — never
 * `unresolved`, `ambiguous`, or `denied`. Those three remain fully
 * *discovered* (a `SemanticCapabilityContract` still exists for them, and
 * the underlying XOIR `capability` node is untouched and still ships in
 * `knowledge_graph.json`, per `xoir-to-package.ts`), they are simply not
 * *executable*, and this module makes no attempt to promote them anyway.
 *
 * This module never registers anything against a
 * `RuntimeCapabilityRegistry` — that boundary
 * (`@xo/runtime`'s `registerResolvedCapabilityBinding`) is a distinct,
 * separately-authorized act performed by whoever embeds the Runtime, not
 * by the compiler. A manifest `CapabilityDeclaration` is the package's own
 * *claim*; it is not, by itself, an execution grant. See
 * `runtime-capability-declaration.ts`'s top doc comment for the full
 * distinction this module is careful not to blur.
 */

/**
 * A resolved binding's `implementationClass` this module knows how to
 * describe honestly in a manifest declaration. Mirrors `@xo/runtime`'s
 * `registerResolvedCapabilityBinding`, which — as of Action Capability
 * Binding v1 — accepts exactly the same two classes
 * (`'deterministic_rule'`, `'human_in_the_loop'`) — kept in sync
 * deliberately, not by coincidence: a binding this module lowers into
 * the manifest should be exactly the kind of binding the Runtime side
 * can later re-resolve and register, not a wider set the runtime bridge
 * can't act on. Adding `'human_in_the_loop'` here does not change how
 * `'deterministic_rule'` is lowered in any way — see
 * `toCapabilityDeclaration`, which dispatches on `implementationClass`
 * and leaves the deterministic-rule branch untouched.
 */
const LOWERABLE_IMPLEMENTATION_CLASSES: ReadonlySet<CapabilityBinding['implementationClass']> = new Set(['deterministic_rule', 'human_in_the_loop']);

/**
 * A `deterministic_rule` binding is a pure, synchronous, in-process
 * function over already-retrieved package data — no model round trip, no
 * network call, no paid tool invocation. Zero is therefore not a guess at
 * this binding class's cost/latency, it is the only value this module can
 * derive without inventing a pricing or timing model this codebase does
 * not have. A future `implementationClass` with real I/O would need its
 * own, honestly-derived estimate — this module does not generalize this
 * constant to classes it doesn't lower.
 */
const DETERMINISTIC_RULE_ESTIMATED_LATENCY_MS = 0;
const DETERMINISTIC_RULE_ESTIMATED_COST = { currency: 'USD', amount: 0 } as const;

/**
 * A `human_in_the_loop` binding's `evaluate` (`ActionEscalationBindingResolver`,
 * `@xo/capability-contract`) is, by that resolver's own doc comment, "pure
 * and deterministic... never fails on its own account... only a routing
 * decision" — it produces an inspectable escalation record and returns,
 * exactly like a `deterministic_rule` evaluator's own in-process call.
 * Zero is therefore this same honest, non-fabricated estimate of *that*
 * call's cost/latency — not a claim about how long the human's
 * subsequent action takes, which this binding's `evaluate` never
 * performs and this module has no data to estimate. A future revision
 * that wants to model human-completion latency would need its own,
 * separately-justified estimate; this constant makes no such claim.
 */
const HUMAN_IN_THE_LOOP_ESTIMATED_LATENCY_MS = 0;
const HUMAN_IN_THE_LOOP_ESTIMATED_COST = { currency: 'USD', amount: 0 } as const;

/** The one `ComponentKind` a lowered capability's data legitimately lives in: `capability` XOIR nodes are always serialized into `knowledge/graph.json` (see `xoir-to-package.ts#buildKnowledgeGraphComponent`), never anywhere else — so a lowered declaration can truthfully declare this as its sole required component without inspecting the rest of the package build. */
const CAPABILITY_REQUIRED_COMPONENTS = ['knowledge_graph'] as const;

export interface LowerCapabilitiesOptions {
  /**
   * Which `BindingResolver`s to try, in order — defaults to
   * `STANDARD_BINDING_RESOLVERS` (`@xo/capability-contract` —
   * the two resolvers this codebase actually implements today (Action
   * Capability Binding v1's `ActionEscalationBindingResolver` is a
   * production default as of the Human-in-the-Loop Execution Class
   * Lowering milestone; it was previously exercised only by tests/demos,
   * never by this module's default list). The two partition every
   * contract disjointly by construction (one requires `rules.length > 0`,
   * the other requires `rules.length === 0` — see
   * `ActionEscalationBindingResolver`'s own doc comment), so adding the
   * second changes zero `deterministic_rule` outcomes: a contract that
   * used to resolve via `StructuredComparisonBindingResolver` still does,
   * identically. A caller with additional resolvers (e.g. a future
   * `ai_provider`-backed one) can pass its own list — this module never
   * hardcodes a resolver import requirement beyond the default.
   */
  readonly resolvers?: readonly BindingResolver[];
  /**
   * Model families a lowered capability may claim `providerCompatibility`
   * for. Per `@xo/types`' `CapabilityDeclaration.providerCompatibility`
   * doc comment ("a subset of the families listed in the manifest's own
   * `compatibility.modelFamilies`"), this module never invents a family —
   * it only ever narrows whatever the caller (the Packager, which already
   * computed the package's own `CompatibilityDeclaration`) passes in.
   * Defaults to an empty list (no claimed compatibility) rather than
   * guessing, if the caller doesn't supply one.
   */
  readonly providerCompatibility?: readonly ModelFamily[];
}

/** One discovered contract's outcome, whether or not it was lowered — this is the audit trail `xo capabilities` (and this module's own tests) read to explain *why* a given XOIR capability node did or didn't become a manifest declaration. */
export interface LoweredCapabilityOutcome {
  readonly contractId: string;
  readonly name: string;
  readonly status: BindingOutcome['status'];
  /** Present whenever this outcome was not actually lowered — either because binding resolution itself did not produce `'resolved'`, because it resolved to an `implementationClass` this module doesn't yet know how to describe in a manifest declaration, or because embedding the resolved contract into the packaged knowledge graph itself failed (see `lowerCapabilitiesToManifest`'s doc comment — a genuine graph-mutation failure here means this capability is NOT promoted, even though its contract/binding resolved cleanly, rather than shipping a manifest declaration whose `execution.contractId` points at a knowledge-graph node that doesn't actually carry that contract). */
  readonly reason?: string;
  /** Present if and only if `declaration` was added to `LowerCapabilitiesResult.declarations` — i.e. `status === 'resolved'` AND `reason` is absent. A `'resolved'` outcome can still have no `declaration` (and a `reason` instead) if its binding's `implementationClass` isn't lowerable yet, or if embedding failed. */
  readonly declaration?: CapabilityDeclaration;
}

export interface LowerCapabilitiesResult {
  /** Every XOIR `capability` node found in the graph — semantic discovery, independent of whether any of them resolved. Equal to `outcomes.length`. */
  readonly discoveredCount: number;
  /** Every discovered capability whose binding resolved and was lowered — equal to `declarations.length`, and always `<= discoveredCount`. */
  readonly resolvedCount: number;
  /** Deterministically ordered (sorted by `id`) — safe to feed straight into `ManifestBuilder.setCapabilities()`. */
  readonly declarations: readonly CapabilityDeclaration[];
  /** Deterministically ordered (sorted by `contractId`) — one entry per discovered capability, resolved or not. */
  readonly outcomes: readonly LoweredCapabilityOutcome[];
}

function byId(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Recursively collects every leaf `inputKey` out of one
 * `StructuredComparisonBindingResolver` `check` tree (Phase 2's
 * `CompiledCheck` shape — a leaf `'comparison'`/`'categorical'`/`'range'`
 * node carries its own `inputKey`; a composite `'and'`/`'or'` node
 * carries a `checks` array that itself needs the same treatment). Adds
 * every leaf's key to `into` and returns `true` iff the whole subtree's
 * shape was recognized — a single malformed leaf invalidates the entire
 * tree rather than silently yielding a partial key set, same
 * shape-checked-not-assumed discipline as the rest of this function.
 */
function collectInputKeysFromCheck(check: unknown, into: Set<string>): boolean {
  if (typeof check !== 'object' || check === null) return false;
  const kind = (check as Record<string, unknown>).kind;
  if (kind === 'and' || kind === 'or') {
    const checks = (check as Record<string, unknown>).checks;
    if (!Array.isArray(checks) || checks.length === 0) return false;
    for (const sub of checks) {
      if (!collectInputKeysFromCheck(sub, into)) return false;
    }
    return true;
  }
  if (kind === 'comparison' || kind === 'categorical' || kind === 'range') {
    const inputKey = (check as Record<string, unknown>).inputKey;
    if (typeof inputKey !== 'string' || inputKey.length === 0) return false;
    into.add(inputKey);
    return true;
  }
  return false;
}

/**
 * Reads `binding.derivation.rules[].inputKey` (legacy single-comparison
 * shape) or, as of Phase 2's generalized comparison/categorical/range/
 * and/or grammar, `binding.derivation.rules[].check` (a `CompiledCheck`
 * tree, walked recursively via `collectInputKeysFromCheck` above) —
 * metadata `StructuredComparisonBindingResolver` already computed while
 * resolving the binding (see its doc comment: "deterministic,
 * content-derived metadata... never opaque"). This function does NOT
 * re-parse any condition or re-derive any field key itself; it only
 * projects an already-resolved binding's own inspectable output into a
 * `CapabilityInputSchema`. `buildEvaluator` (the same resolver) requires
 * every leaf `inputKey` to be present at evaluation time, so `required`
 * is not a guess — it's exactly what the evaluator this binding already
 * *is* actually demands. `type: 'number'` is only assumed for keys that
 * appear *exclusively* in `'comparison'`/`'range'` leaves; a key that
 * ever appears in a `'categorical'` leaf is typed `'string'` instead
 * (and a key appearing as both is left untyped — `{}` — rather than
 * asserting a type the evaluator does not itself enforce uniformly).
 *
 * Deliberately shape-checked rather than assumed: `CapabilityBinding.derivation`
 * is typed `Readonly<Record<string, unknown>>` precisely because a
 * different (future) resolver's derivation may have a different shape.
 * If `binding.derivation.rules` doesn't look like
 * `StructuredComparisonBindingResolver`'s own output (legacy or Phase 2
 * shape), this returns `undefined` rather than fabricating a schema — the
 * resulting `CapabilityDeclaration.execution` will then simply omit
 * `inputSchema`, per R1's "if available" contract, not silently claim a
 * wrong one.
 */
function deriveInputSchemaFromDerivation(binding: CapabilityBinding): CapabilityInputSchema | undefined {
  const rules = (binding.derivation as { readonly rules?: unknown }).rules;
  if (!Array.isArray(rules) || rules.length === 0) return undefined;

  const numericKeys = new Set<string>();
  const stringKeys = new Set<string>();

  for (const rule of rules) {
    if (typeof rule !== 'object' || rule === null) return undefined;
    const record = rule as Record<string, unknown>;

    if (typeof record.check === 'object' && record.check !== null) {
      // Phase 2 shape: { sourceNodeId, check, outcome }.
      const keysInThisRule = new Set<string>();
      if (!collectInputKeysFromCheck(record.check, keysInThisRule)) return undefined;
      const typedByKind = new Map<string, 'number' | 'string'>();
      (function classify(check: unknown): void {
        const c = check as Record<string, unknown>;
        if (c.kind === 'and' || c.kind === 'or') {
          for (const sub of c.checks as unknown[]) classify(sub);
          return;
        }
        const key = c.inputKey as string;
        typedByKind.set(key, c.kind === 'categorical' ? 'string' : 'number');
      })(record.check);
      for (const key of keysInThisRule) {
        if (typedByKind.get(key) === 'string') stringKeys.add(key);
        else numericKeys.add(key);
      }
      continue;
    }

    // Legacy shape: { sourceNodeId, inputKey, operator, threshold, outcome }.
    const inputKey = record.inputKey;
    if (typeof inputKey !== 'string' || inputKey.length === 0) return undefined;
    numericKeys.add(inputKey);
  }

  // `CapabilityInputSchema.properties[key].type` is a required, single
  // `CapabilityInputPropertyType` (@xo/types) — no union/untyped option
  // exists, so a key that appears in both a categorical and a numeric
  // leaf across different rules of the same binding (an inconsistency in
  // how the source authored those rules, not something this function can
  // resolve) is typed `'string'`, the more specific/restrictive of the
  // two, rather than silently guessing `'number'` for a field a
  // categorical rule also depends on.
  const allKeys = new Set([...numericKeys, ...stringKeys]);
  const sortedKeys = [...allKeys].sort();
  const properties: Record<string, { readonly type: CapabilityInputPropertyType }> = {};
  for (const key of sortedKeys) properties[key] = { type: stringKeys.has(key) ? 'string' : 'number' };
  return { type: 'object', properties, required: sortedKeys };
}

/**
 * Converts one resolved `(contract, binding)` pair into a manifest
 * `CapabilityDeclaration`. Every field is either copied verbatim from the
 * contract (`id`, `name`, `description`, `confidence.score`) or derived
 * from a fact this module can state honestly for any binding of this
 * `implementationClass` (see the constants above) — nothing here is a
 * guess about what the capability is worth, how long it takes, or which
 * hosts can use it beyond what the caller already told us.
 *
 * As of R1's compiler-side closure: also populates `execution`
 * (`@xo/types`' `CapabilityDeclaration.execution`, the runtime's
 * authoritative execution-strategy decision point) from this SAME
 * already-resolved `(contract, binding)` pair — `mode` derived verbatim
 * from `binding.implementationClass` via `executionModeFor` (see below;
 * this function is only ever called for an `implementationClass` in
 * `LOWERABLE_IMPLEMENTATION_CLASSES`, per `lowerCapabilitiesToManifest`'s
 * eligibility check), `bindingId`/`contractId` copied verbatim,
 * `inputSchema` derived read-only from the binding's own `derivation`
 * (see `deriveInputSchemaFromDerivation`, never re-resolved — naturally
 * `undefined` for a `human_in_the_loop` binding, whose `derivation` shape
 * carries `actionKnowledgeRefs`, not `rules`, so no schema is fabricated
 * where none exists), and `requiredPermissionIds` copied verbatim from
 * `contract.requiredPermissions` (already exactly the right shape — a
 * list of permission-id strings the compiler extracted, not fabricated
 * here). No new resolution logic; every value here already existed on
 * `contract`/`binding` before this function ran.
 */
function toCapabilityDeclaration(contract: SemanticCapabilityContract, binding: CapabilityBinding, providerCompatibility: readonly ModelFamily[]): CapabilityDeclaration {
  const inputSchema = deriveInputSchemaFromDerivation(binding);
  const execution: CapabilityExecutionDeclaration = {
    mode: executionModeFor(binding),
    bindingId: binding.id,
    contractId: contract.id,
    contractContentHash: computeContractContentHash(contract),
    ...(inputSchema !== undefined ? { inputSchema } : {}),
    ...(contract.requiredPermissions.length > 0 ? { requiredPermissionIds: contract.requiredPermissions } : {}),
  };
  const { cost, latencyMs } = estimatesFor(binding);
  return {
    id: contract.id,
    name: contract.name,
    description: contract.description,
    providerCompatibility,
    requiredComponents: CAPABILITY_REQUIRED_COMPONENTS,
    estimatedCost: cost,
    estimatedLatencyMs: latencyMs,
    confidence: { score: contract.confidence, basis: 'self_reported' },
    execution,
  };
}

/**
 * Maps a lowerable binding's `implementationClass` to the
 * `CapabilityExecutionMode` it is honestly described by — a 1:1,
 * non-inventive projection: `'deterministic_rule'` -> `'deterministic_rule'`,
 * `'human_in_the_loop'` -> `'human_in_the_loop'`. Only ever called for a
 * class already checked against `LOWERABLE_IMPLEMENTATION_CLASSES` at the
 * call site, so the `default` branch below is unreachable in practice —
 * kept as an exhaustiveness guard, not a real fallback, so a future
 * `implementationClass` added to `LOWERABLE_IMPLEMENTATION_CLASSES`
 * without a corresponding case here fails loudly (a thrown error) instead
 * of silently mislabeling a binding's execution mode.
 */
function executionModeFor(binding: CapabilityBinding): CapabilityExecutionDeclaration['mode'] {
  switch (binding.implementationClass) {
    case 'deterministic_rule':
      return 'deterministic_rule';
    case 'human_in_the_loop':
      return 'human_in_the_loop';
    default:
      throw new Error(`toCapabilityDeclaration: no CapabilityExecutionMode mapping for implementationClass "${binding.implementationClass}" — add one to executionModeFor before adding it to LOWERABLE_IMPLEMENTATION_CLASSES`);
  }
}

/** Same dispatch shape as {@link executionModeFor}, for the honestly-derived (never fabricated) cost/latency constants declared above. */
function estimatesFor(binding: CapabilityBinding): { readonly cost: typeof DETERMINISTIC_RULE_ESTIMATED_COST; readonly latencyMs: number } {
  switch (binding.implementationClass) {
    case 'deterministic_rule':
      return { cost: DETERMINISTIC_RULE_ESTIMATED_COST, latencyMs: DETERMINISTIC_RULE_ESTIMATED_LATENCY_MS };
    case 'human_in_the_loop':
      return { cost: HUMAN_IN_THE_LOOP_ESTIMATED_COST, latencyMs: HUMAN_IN_THE_LOOP_ESTIMATED_LATENCY_MS };
    default:
      throw new Error(`toCapabilityDeclaration: no cost/latency estimate for implementationClass "${binding.implementationClass}" — add one before adding it to LOWERABLE_IMPLEMENTATION_CLASSES`);
  }
}

/**
 * Phase 3: the compiler-side authorization-integrity gate. `contract.requiredPermissions`
 * is a plain `string[]` verbatim from whatever the compiler's extraction
 * layer produced (see `SemanticCapabilityContract`'s own doc comment) —
 * nothing between extraction and this point has ever checked those
 * strings are well-formed `PermissionId`s (`domain.action`, a registered
 * domain — see `@xo/permissions`' `parsePermissionId`). The only place
 * that check previously happened was `@xo/runtime`'s
 * `registerResolvedCapabilityBinding`, a distinct, optional, separately-
 * invoked runtime act that a given host may never call for a given
 * capability. Without this gate, a capability carrying a malformed
 * permission string could still cross the compiler's executable-binding
 * boundary (`mode: 'deterministic_rule'`) with authorization metadata
 * that was never actually validated — exactly the "understanding is not
 * authorization" failure mode, inverted: not a missing requirement, but
 * an unverified one shipped as if it meant something.
 *
 * Reuses `@xo/permissions`' existing `parsePermissionId` — the exact
 * function `capability-binding-registration.ts` already uses for this
 * same purpose — rather than duplicating permission-format logic here.
 * An empty `requiredPermissions` array trivially passes (nothing to
 * validate), unchanged from today's behavior.
 */
function findInvalidRequiredPermission(requiredPermissions: readonly string[]): string | undefined {
  for (const value of requiredPermissions) {
    const parsed = parsePermissionId(value);
    if (!parsed.ok) return value;
  }
  return undefined;
}

/**
 * The compiler lowering entry point. For every XOIR `capability` node in
 * `graph` (via `buildAllSemanticCapabilityContracts`, reused unmodified):
 *
 *   1. Build its `SemanticCapabilityContract` (skipped if the builder
 *      itself rejects the node — a structural `CONTRACT_*` error, not a
 *      normal "no rules" outcome, and not this module's concern to
 *      surface further; `buildAllSemanticCapabilityContracts` only ever
 *      fails this way for a node that isn't really a well-formed
 *      capability, which is out of scope for a lowering eligibility
 *      decision).
 *   2. Resolve a binding for it via `resolveCapabilityBinding`.
 *   3. Only a `resolved` outcome whose binding's `implementationClass` is
 *      one this module knows how to describe honestly (see
 *      `LOWERABLE_IMPLEMENTATION_CLASSES`) is lowered into a
 *      `CapabilityDeclaration`. `unresolved`/`ambiguous`/`denied` — and a
 *      `resolved` binding of some future, not-yet-lowerable
 *      `implementationClass` — are recorded in `outcomes` but never
 *      promoted, and their underlying XOIR `capability` node is left
 *      completely untouched (no embedding — see step 4).
 *   4. For exactly the same set lowered in step 3 (never a wider one —
 *      this is the "only embed contracts for capabilities that are
 *      actually eligible for the executable declaration" requirement),
 *      `embedResolvedContractInCapabilityNode` (`@xo/capability-contract`)
 *      is called with the SAME `contract` object already built in step 1
 *      — no second `buildSemanticCapabilityContract` call, no risk of the
 *      manifest's `execution.contractId` and the packaged knowledge
 *      graph's embedded contract ever silently diverging, since they are
 *      provably the same object serialized twice, not two independent
 *      resolutions. This mutates `graph` in place; callers (`packager.ts`)
 *      MUST call this function BEFORE serializing the knowledge_graph
 *      component from the same graph, or the embedding will simply not
 *      be present in the packaged bytes — see `packageXoirGraph`'s
 *      ordering.
 *
 *      If embedding fails (a genuine `XoirGraph` mutation failure —
 *      `getNode`/`removeNode`/`createAndAddNode`/`addEdge` all returning
 *      `err`), this capability is NOT promoted: it is recorded in
 *      `outcomes` with `status: 'resolved'` and a `reason` explaining the
 *      embedding failure, and no `CapabilityDeclaration` for it is added
 *      to `declarations`. This is deliberate fail-closed behavior — per
 *      this module's charter, "make a mismatch between the manifest
 *      declaration and the embedded graph contract fail clearly rather
 *      than silently producing inconsistent package metadata." A
 *      resolved-but-not-embeddable capability stays fully *discovered*
 *      (its plain XOIR node, contract-free, still ships in
 *      `knowledge_graph.json`) but not *executable* — exactly the same
 *      posture already used for a non-lowerable `implementationClass`.
 *
 * Deterministic: same graph, same resolvers, same result every time — no
 * timestamps, no randomness, both output arrays explicitly sorted rather
 * than left in whatever order `Map`/`Array` iteration happened to produce.
 */
export function lowerCapabilitiesToManifest(graph: XoirGraph, options: LowerCapabilitiesOptions = {}): LowerCapabilitiesResult {
  const resolvers = options.resolvers ?? STANDARD_BINDING_RESOLVERS;
  const providerCompatibility = options.providerCompatibility ?? [];

  const contractResults = buildAllSemanticCapabilityContracts(graph);

  const outcomes: LoweredCapabilityOutcome[] = [];
  const declarations: CapabilityDeclaration[] = [];

  for (const contractResult of contractResults) {
    if (!contractResult.ok) continue;
    const contract = contractResult.value;
    const outcome = resolveCapabilityBinding(contract, resolvers);

    if (outcome.status === 'resolved' && LOWERABLE_IMPLEMENTATION_CLASSES.has(outcome.binding.implementationClass)) {
      const invalidPermission = findInvalidRequiredPermission(contract.requiredPermissions);
      if (invalidPermission !== undefined) {
        outcomes.push({ contractId: contract.id, name: contract.name, status: 'resolved', reason: `Binding resolved to a lowerable implementationClass, but contract "${contract.id}" declares an invalid required permission ("${invalidPermission}") that does not parse as a well-formed PermissionId — refusing to promote this capability to an executable manifest declaration with unverified authorization metadata` });
        continue;
      }
      const embedResult = embedResolvedContractInCapabilityNode(graph, XoirNodeId(contract.id), contract);
      if (!embedResult.ok) {
        outcomes.push({ contractId: contract.id, name: contract.name, status: 'resolved', reason: `Binding resolved to a lowerable implementationClass, but embedding its contract into the packaged knowledge graph failed, so this capability is not promoted to an executable manifest declaration: [${embedResult.error.code}] ${embedResult.error.message}` });
        continue;
      }
      const declaration = toCapabilityDeclaration(contract, outcome.binding, providerCompatibility);
      declarations.push(declaration);
      outcomes.push({ contractId: contract.id, name: contract.name, status: 'resolved', declaration });
    } else if (outcome.status === 'resolved') {
      // Resolved, but to an implementationClass this module doesn't yet
      // know how to describe honestly in a manifest declaration — stays
      // discovered, not executable-via-manifest, same as any other
      // non-lowerable outcome. Not a `denied`/`unresolved` outcome in its
      // own right, so it's recorded with its real status and a reason
      // explaining why it still wasn't lowered.
      outcomes.push({ contractId: contract.id, name: contract.name, status: 'resolved', reason: `Binding resolved to implementationClass "${outcome.binding.implementationClass}", which this compiler's lowering module does not yet promote into a manifest CapabilityDeclaration` });
    } else {
      outcomes.push({ contractId: contract.id, name: contract.name, status: outcome.status, reason: outcome.reason });
    }
  }

  declarations.sort(byId);
  const sortedOutcomes = outcomes.slice().sort((a, b) => (a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1 : 0));

  // P0.9B: embedding contracts above mutated `graph`'s content, so its
  // identity (`XoirGraph.contentHash()`) moved. `manifest.graphHash` is
  // documented as a cached snapshot of that same value, so refresh it
  // here — the one place the mutation happens — rather than let the cache
  // go stale (a receipt built from `contentHash()` and a manifest read
  // back from the persisted graph would otherwise name different graphs).
  // Only refreshes a graphHash that was already recorded; never invents a
  // manifest for a graph that has none.
  const existing = graph.manifest;
  if (existing?.graphHash !== undefined) {
    graph.setManifest(
      createManifest({
        schemaVersion: existing.schemaVersion,
        ...(existing.compilerVersion !== undefined ? { compilerVersion: existing.compilerVersion } : {}),
        professionTags: existing.professionTags,
        sourceManifestRefs: existing.sourceManifestRefs,
        passHistory: existing.passHistory,
        graphHash: ContentHash(graph.contentHash()),
        ...(existing.sourceQuality !== undefined ? { sourceQuality: existing.sourceQuality } : {}),
        now: () => existing.createdAt,
      }),
    );
  }

  return {
    discoveredCount: contractResults.length,
    resolvedCount: declarations.length,
    declarations,
    outcomes: sortedOutcomes,
  };
}
