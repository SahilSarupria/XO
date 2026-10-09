import { ok, type Result } from '@xo/types';
import type { ComponentKind, CompatibilityDeclaration, XoManifest, XoMetadata } from '@xo/types';
import { PackageError } from '@xo/errors';
import { ManifestBuilder } from '@xo/package-sdk';
import type { ComponentInput, PackageBundle } from '@xo/package-sdk';
import type { Diagnostic, XoirGraph } from '@xo/xoir';
import {
  buildBenchmarkSuiteComponent,
  buildCaseLibraryComponent,
  buildDecisionTreesComponent,
  buildKnowledgeGraphComponent,
  buildLongTermMemoryGraphComponent,
  buildReasoningTracesComponent,
  buildSafetyRulesComponent,
} from '../xoir/xoir-to-package.js';
import { lowerCapabilitiesToManifest, type LowerCapabilitiesOptions, type LowerCapabilitiesResult } from './capability-lowering.js';

const ENCODER = new TextEncoder();

/** Deterministic JSON bytes: fixed 2-space indent, and every serializer in `xoir-to-package.ts` already sorts arrays and builds object literals in a fixed key order — so the same input `XoirGraph` always produces byte-identical output here, satisfying "package contents are deterministic." */
function jsonBytes(value: unknown): Uint8Array {
  return ENCODER.encode(JSON.stringify(value, null, 2));
}

export interface PackageXoirIdentity {
  readonly name: string;
  readonly version: string;
  readonly creatorDid: string;
  readonly formatVersion?: string;
}

/**
 * Per this module's design report: two default model-family entries,
 * built entirely from *which components actually got included* (never
 * hardcoded against components that turned out empty/omitted) —
 * `generic` gets the conservative L0/L1 baseline
 * (`knowledge_graph`/`safety_rules`/`benchmark_suite`, matching
 * `SPECIFICATION.md` §2.2's own L0/L1 definitions); `claude` gets
 * everything this compilation actually produced, since `decision_trees`
 * can be exposed as callable tools per the flagship package's own
 * precedent (`PACKAGE_README.md` §5). A caller who wants a different
 * compatibility story can pass `compatibilityOverride` — this default is
 * a reasonable starting point, not a claim about real-world model
 * capability negotiation, which is out of this module's scope.
 */
function defaultCompatibility(includedKinds: readonly ComponentKind[]): CompatibilityDeclaration {
  const baseline = includedKinds.filter((k) => k === 'knowledge_graph' || k === 'safety_rules' || k === 'benchmark_suite');
  return {
    modelFamilies: [
      { family: 'generic', minCapability: ['chat'], consumes: baseline },
      { family: 'claude', minCapability: ['chat', 'tool_use'], consumes: includedKinds },
    ],
    fallbackPolicy: 'degrade_gracefully',
  };
}

export interface PackageXoirOptions {
  readonly identity: PackageXoirIdentity;
  /** `metadata.json`'s content (domain/description/scope/limitations/tags) — always caller-supplied, never synthesized here: XOIR itself carries no document-title/domain concept (that lives in Stage 3's `ExperienceDocument`, one layer up from what this module touches), so inventing prose here would be fabrication, not lowering. */
  readonly metadata: XoMetadata;
  readonly compatibilityOverride?: CompatibilityDeclaration;
  /** Diagnostics from upstream compilation (`compileXoir`'s `PipelineResult.diagnostics`, Stage 6/7's validation/normalization passes) — passed straight through onto `PackagerResult.diagnostics` so a caller building a package doesn't lose them by calling this module. This function does not itself generate `Diagnostic`-typed findings; see `PackagerResult.components` for this module's own "what did I include and why" record. */
  readonly upstreamDiagnostics?: readonly Diagnostic[];
  /**
   * Forwarded verbatim to `lowerCapabilitiesToManifest` (`capability-lowering.js`)
   * — lets a caller supply e.g. its own resolver set. `providerCompatibility`
   * is always computed by this module from the package's own resolved
   * `CompatibilityDeclaration` (see `packageXoirGraph` below) and cannot be
   * overridden here, since a capability's provider compatibility must stay a
   * true subset of the package's own — see `CapabilityDeclaration.providerCompatibility`'s
   * doc comment (`@xo/types`).
   */
  readonly capabilityLowering?: Pick<LowerCapabilitiesOptions, 'resolvers'>;
}

/** One `ComponentKind`'s outcome for this compilation — the packager's own audit trail (satisfies "preserve diagnostics" at this layer without inventing a redundant second `Diagnostic` shape for a concern that's really "manifest bookkeeping", not a compiler pass finding). */
export interface PackagerComponentSummary {
  readonly kind: ComponentKind;
  readonly included: boolean;
  readonly nodeCount?: number;
  readonly reason: string;
}

export interface PackagerResult {
  readonly bundle: PackageBundle;
  readonly manifest: XoManifest;
  readonly components: readonly PackagerComponentSummary[];
  readonly diagnostics: readonly Diagnostic[];
  /**
   * The capability lowering audit trail (`capability-lowering.js`):
   * every XOIR `capability` node discovered, which of them resolved a
   * binding, and which of those were actually promoted into
   * `manifest.capabilities`. `manifest.capabilities` itself is always
   * exactly `capabilities.declarations` (in the same order) — this field
   * exists because the manifest alone can't explain *why* a discovered
   * capability didn't make it in, which is what `xo capabilities` (and
   * this module's own tests) need for the discovered-vs-resolved report.
   */
  readonly capabilities: LowerCapabilitiesResult;
}

interface ComponentBuildResult {
  readonly input?: ComponentInput;
  readonly summary: PackagerComponentSummary;
}

function jsonComponent(kind: ComponentKind, path: string, required: boolean, payload: { nodes?: readonly unknown[] } | undefined, emptyReason: string): ComponentBuildResult {
  if (payload === undefined) {
    return { summary: { kind, included: false, reason: emptyReason } };
  }
  const nodeCount = payload.nodes?.length;
  return {
    input: { kind, path, data: jsonBytes(payload), required },
    summary: { kind, included: true, ...(nodeCount !== undefined ? { nodeCount } : {}), reason: `lowered from XOIR (${nodeCount ?? 'n/a'} node(s))` },
  };
}

/**
 * The Packager (`EXPERIENCE_COMPILER.md` §9): lowers a compiled
 * `XoirGraph` into a real `PackageBundle` via `@xo/package-sdk`'s
 * `ManifestBuilder`, exactly as that SDK is designed to be used (no
 * subclassing, no bypassing hash/Merkle-root computation — this function
 * calls `addComponent`/`build()` the same way `package-sdk`'s own demo
 * script does). Signing is deliberately not done here: `ManifestBuilder`
 * already separates "build the bundle" from "sign it"
 * (`PackageSigner.sign` is a distinct step in `package-sdk`), and this
 * module preserves that layering rather than collapsing it.
 *
 * Never fails on "this graph has no X" for any optional component — an
 * empty/absent optional component is a legitimate outcome (see
 * `xoir-to-package.ts`'s per-component doc comments) reflected in
 * `PackagerResult.components`, not an error. This function only returns
 * `err` if `ManifestBuilder.build()` itself rejects the assembled state
 * (e.g. an invalid semver in `identity.version`) — a real, structural
 * packaging failure, not a "this document didn't have decision trees"
 * non-issue.
 */
export function packageXoirGraph(graph: XoirGraph, options: PackageXoirOptions): Result<PackagerResult, PackageError> {
  // A first, cheap pass over the UN-mutated graph, used only to decide
  // whether `knowledge_graph` will be included at all (and therefore
  // whether capability lowering — which requires that component to be
  // meaningful, see below — should run). Embedding a resolved contract
  // into an existing capability node's `properties` never adds or
  // removes a node, so this presence/emptiness decision is unaffected by
  // whether lowering has run yet; the ACTUAL bytes shipped for this
  // component are computed again, below, AFTER lowering, from the
  // (possibly now contract-embedded) graph — see the `capabilities`
  // block's comment for why that ordering is required, not incidental.
  const knowledgeGraphIncludedBeforeLowering = buildKnowledgeGraphComponent(graph) !== undefined;

  const decisionTrees = jsonComponent('decision_trees', 'reasoning/decision_trees.json', false, buildDecisionTreesComponent(graph), 'no decision_node nodes in this XOIR graph');
  const caseLibrary = jsonComponent('case_library', 'reasoning/case_library.json', false, buildCaseLibraryComponent(graph), 'no failure_case/success_pattern nodes — no extractor in this codebase produces them yet');
  const memoryGraph = jsonComponent('long_term_memory_graph', 'memory/long_term_graph.json', false, buildLongTermMemoryGraphComponent(graph), 'no memory_unit nodes — no extractor in this codebase produces them yet');

  const tracesJsonl = buildReasoningTracesComponent(graph);
  const reasoningTraces: ComponentBuildResult =
    tracesJsonl === undefined
      ? { summary: { kind: 'reasoning_traces', included: false, reason: 'no reasoning_step nodes in this XOIR graph' } }
      : {
          input: { kind: 'reasoning_traces', path: 'reasoning/reasoning_traces.jsonl', data: ENCODER.encode(tracesJsonl), required: false },
          summary: { kind: 'reasoning_traces', included: true, nodeCount: tracesJsonl.trim().split('\n').filter(Boolean).length, reason: 'lowered from XOIR reasoning_step nodes, one JSON object per line' },
        };

  const safety = buildSafetyRulesComponent(graph);
  const safetyRules: ComponentBuildResult = {
    input: { kind: 'safety_rules', path: 'safety/rules.json', data: jsonBytes(safety), required: true },
    summary: { kind: 'safety_rules', included: true, nodeCount: safety.nodes.length, reason: safety.nodes.length > 0 ? `lowered from XOIR (${safety.nodes.length} constraint/safety_policy/risk_policy/escalation_rule node(s))` : 'required component present but empty — this XOIR graph has no constraint/safety_policy/risk_policy/escalation_rule nodes' },
  };

  const benchmark = buildBenchmarkSuiteComponent(graph);
  const benchmarkSuite: ComponentBuildResult = {
    input: { kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', data: jsonBytes(benchmark), required: true },
    summary: { kind: 'benchmark_suite', included: true, nodeCount: benchmark.totalItems, reason: benchmark.note ?? `lowered from XOIR (${benchmark.totalItems} evaluation_artifact node(s))` },
  };

  // prompt_strategies / lora / finetune: never produced — no Prompt
  // Optimization pass and no weight-fine-tuning pipeline exist anywhere in
  // this codebase (see xoir-to-package.ts's top doc comment). Recorded as
  // explicitly omitted rather than silently absent, so a caller inspecting
  // `PackagerResult.components` sees *why*, not just that they're missing.
  const promptStrategies: PackagerComponentSummary = { kind: 'prompt_strategies', included: false, reason: 'no Prompt Optimization pass exists in this compiler (EXPERIENCE_COMPILER.md §4.2)' };
  const lora: PackagerComponentSummary = { kind: 'lora', included: false, reason: 'no fine-tuning/weights pipeline exists in this compiler' };
  const finetune: PackagerComponentSummary = { kind: 'finetune', included: false, reason: 'no fine-tuning/weights pipeline exists in this compiler' };

  const nonKnowledgeGraphInputs = [decisionTrees, caseLibrary, memoryGraph, reasoningTraces, safetyRules, benchmarkSuite].map((b) => b.input).filter((i): i is ComponentInput => i !== undefined);
  const includedKinds: ComponentKind[] = [...(knowledgeGraphIncludedBeforeLowering ? (['knowledge_graph'] as const) : []), ...nonKnowledgeGraphInputs.map((i) => i.kind)];

  const compatibility = options.compatibilityOverride ?? defaultCompatibility(includedKinds);

  // Capability lowering (Step 4 of the discovered -> resolved -> manifest
  // boundary): a capability may only claim `providerCompatibility` for
  // families the package itself already declares support for — computed
  // from `compatibility` above, never independently guessed. This must
  // happen *before* `setCapabilities` below, and only if `knowledge_graph`
  // actually made it into this build (a lowered declaration always names
  // `knowledge_graph` as its sole `requiredComponents` entry — see
  // `capability-lowering.ts` — so there is nothing legitimate to lower if
  // that component itself was omitted).
  //
  // CRITICAL ORDERING: this call happens BEFORE `buildKnowledgeGraphComponent`
  // is called (below, to produce the actual `knowledge` component bytes).
  // As of R1's compiler-side closure, `lowerCapabilitiesToManifest` embeds
  // each promoted capability's resolved `SemanticCapabilityContract`
  // directly into `graph`'s corresponding capability node (via
  // `embedResolvedContractInCapabilityNode`, `@xo/capability-contract`) —
  // a real mutation of `graph`, not a side-channel. Serializing the
  // knowledge_graph component from `graph` BEFORE this call would produce
  // a manifest `execution.contractId` that has no corresponding embedded
  // contract anywhere in the shipped package — exactly the inconsistency
  // this ordering exists to prevent.
  const capabilities: LowerCapabilitiesResult = knowledgeGraphIncludedBeforeLowering
    ? lowerCapabilitiesToManifest(graph, {
        ...(options.capabilityLowering?.resolvers ? { resolvers: options.capabilityLowering.resolvers } : {}),
        providerCompatibility: compatibility.modelFamilies.map((f) => f.family),
      })
    : { discoveredCount: 0, resolvedCount: 0, declarations: [], outcomes: [] };

  // The ACTUAL knowledge_graph component, built from `graph` AFTER
  // lowering has had a chance to embed contracts into it. Re-running
  // `buildKnowledgeGraphComponent` here is re-serialization, not
  // re-resolution — no contract is built or resolved a second time; this
  // is the same pure "read the graph's current node/edge state into
  // JSON" projection `buildDecisionTreesComponent` etc. already perform
  // once each above, just deferred for this one component specifically
  // because its content depends on lowering's side effect.
  const knowledge = jsonComponent('knowledge_graph', 'knowledge/graph.json', false, buildKnowledgeGraphComponent(graph), 'no concept/fact/heuristic/preference/capability nodes in this XOIR graph');

  const built = [knowledge, decisionTrees, caseLibrary, memoryGraph, reasoningTraces, safetyRules, benchmarkSuite];
  const includedInputs = built.map((b) => b.input).filter((i): i is ComponentInput => i !== undefined);

  let builder = ManifestBuilder.create()
    .setIdentity({
      formatVersion: options.identity.formatVersion ?? '1.0',
      name: options.identity.name,
      version: options.identity.version,
      creatorDid: options.identity.creatorDid,
    })
    .setCompatibility(compatibility)
    .setMetadata(options.metadata);

  for (const input of includedInputs) {
    builder = builder.addComponent(input);
  }

  if (capabilities.declarations.length > 0) {
    builder = builder.setCapabilities(capabilities.declarations);
  }

  const result = builder.build();
  if (!result.ok) return result;

  const components = [...built.map((b) => b.summary), promptStrategies, lora, finetune].sort((a, b) => a.kind.localeCompare(b.kind));

  return ok({
    bundle: result.value,
    manifest: result.value.manifest,
    components,
    diagnostics: options.upstreamDiagnostics ?? [],
    capabilities,
  });
}
