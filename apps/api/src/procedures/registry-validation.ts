import { Sha256Hasher } from '@xo/crypto';
import type { ExternalToolWiring } from '@xo/runtime';
import { buildSemanticCapabilityContract, normalizeToFallbackKey, type SemanticCapabilityContract } from '@xo/capability-contract';
import { lowerCapabilitiesToManifest } from '@xo/compiler';
import type { CapabilityInputSchema } from '@xo/types';
import type { ProcedureDefinition, ProcedureFinding, ProcedureErrorCode, CapabilityStep } from '@xo/procedure';
import { canonicalStringify, fromJson, XoirNodeId, type XoirGraph, type XoirGraphJson } from '@xo/xoir';
import { deriveCapabilityApprovalState } from '../approvals/approval-binding.js';
import { declaredPermissionsForNode } from '../executions/authorization.js';
import type { CapabilityProjection, CompilationStore } from '../compilations/compilation.js';

/**
 * P1.1 M2 — registry-dependent procedure validation.
 *
 * Authoritative sources (nothing client-supplied is trusted):
 *   - the workspace's own compilation record (`status === 'succeeded'`), capability projections and persisted XOIR graph;
 *   - `graphHash` = `XoirGraph.contentHash()` of that persisted graph (the same value the runtime pins in execution receipts);
 *   - contract / permission-declaration / binding state = `deriveCapabilityApprovalState` (the M3 approval-state derivation, reused unchanged);
 *   - permission declaration = `declaredPermissionsForNode` (an absent or malformed declaration is `unresolved`, never "no permissions").
 *
 * FAIL CLOSED: a missing, failed, unreadable or cross-workspace compilation is `PROC_COMPILATION_UNAVAILABLE` and is
 * indistinguishable from an unknown id; absence of registry evidence is never treated as validity. Pure given its loader: no
 * network, no filesystem access of its own, no adapter or model call.
 */

export interface LoadedCompilation {
  readonly compilationId: string;
  readonly sourceDigestSha256: string;
  readonly graph: XoirGraph;
  readonly graphHash: string;
  readonly capabilities: readonly CapabilityProjection[];
}
/** Returns `undefined` for ANY failure to establish authoritative evidence (unknown, other workspace, failed, unreadable, corrupt). */
export type CompilationLoader = (compilationId: string) => Promise<LoadedCompilation | undefined>;

export function compilationLoaderFromStore(store: CompilationStore): CompilationLoader {
  const cache = new Map<string, Promise<LoadedCompilation | undefined>>();
  const load = async (compilationId: string): Promise<LoadedCompilation | undefined> => {
    try {
      const record = await store.get(compilationId);
      if (!record.ok || record.value.status !== 'succeeded') return undefined;
      const caps = await store.getCapabilities(compilationId);
      const graphJson = await store.getCompiledGraph(compilationId);
      if (!caps.ok || !graphJson.ok) return undefined;
      const graph = fromJson(graphJson.value as XoirGraphJson);
      if (!graph.ok) return undefined;
      return {
        compilationId,
        sourceDigestSha256: record.value.sourceDigestSha256,
        graph: graph.value,
        graphHash: graph.value.contentHash(),
        capabilities: caps.value,
      };
    } catch {
      return undefined;
    }
  };
  return (id) => {
    let hit = cache.get(id);
    if (hit === undefined) {
      hit = load(id);
      cache.set(id, hit);
    }
    return hit;
  };
}

export interface StepRegistryState {
  readonly stepId: string;
  readonly capabilityId: string;
  readonly contractId: string;
  readonly contractContentHash: string;
  readonly declarationFingerprint: string;
  readonly implementationClass: string;
  readonly bindingId: string;
  readonly stateDigest: string;
  readonly confidence: number;
  /** M4: present only for a step admitted as `external_tool`; the host-configured input schema (already bound into `stateDigest`). */
  readonly externalInputSchema?: CapabilityInputSchema;
}

export interface RegistrySnapshot {
  readonly compilationId: string;
  readonly graphHash: string;
  /** sha256 over the canonical (compilationId, graphHash, per-step state digests). Changes if ANY resolved fact changes. */
  readonly digest: string;
  readonly steps: readonly StepRegistryState[];
}

export type RegistryResult =
  { readonly ok: true; readonly snapshot: RegistrySnapshot } | { readonly ok: false; readonly findings: readonly ProcedureFinding[] };

/** Consumer input schemas by contract id: the established contract representation for CLIENT-supplied input (property keys are `normalizeToFallbackKey(param name)`). */
export function schemasByContract(graph: XoirGraph): ReadonlyMap<string, CapabilityInputSchema> {
  const out = new Map<string, CapabilityInputSchema>();
  for (const outcome of lowerCapabilitiesToManifest(graph).outcomes) {
    const schema = outcome.declaration?.execution?.inputSchema;
    if (schema !== undefined) out.set(outcome.contractId, schema);
  }
  return out;
}

/** Key-order-independent JSON text, so the digest depends on the schema's content and not on how the host wrote it. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const SUPPORTED_CLASSES = new Set(['deterministic_rule', 'human_in_the_loop', 'external_tool']);

export async function validateAgainstRegistry(
  def: ProcedureDefinition,
  load: CompilationLoader,
  /**
   * M4 — explicit host configuration of external_tool adapters. Absent => behaviour is exactly the M2 behaviour. A step is admitted as
   * `external_tool` ONLY when the standard resolvers leave its capability unresolved AND the host configured an adapter (with an input
   * schema) for its contract. A capability the standard resolvers bind AND the host configured is a conflict and is refused.
   */
  externalTools?: ExternalToolWiring,
): Promise<RegistryResult> {
  const findings: ProcedureFinding[] = [];
  const add = (code: ProcedureErrorCode, path: string): void => void findings.push({ code, path });
  const capabilitySteps: { step: CapabilityStep; index: number }[] = [];
  def.steps.forEach((step, index) => {
    if (step.kind === 'capability') capabilitySteps.push({ step, index });
  });

  const ref = def.compilationRef;
  if (ref === undefined) {
    if (capabilitySteps.length > 0) add('PROC_COMPILATION_REF_REQUIRED', '/compilationRef');
    return { ok: false, findings };
  }
  const compilation = await load(ref.compilationId);
  if (compilation === undefined)
    return { ok: false, findings: [{ code: 'PROC_COMPILATION_UNAVAILABLE', path: '/compilationRef/compilationId' }] };
  if (compilation.graphHash !== ref.graphHash) {
    // Contract-hash drift: the persisted graph no longer hashes to what the author recorded. Nothing derived from it is trusted.
    return { ok: false, findings: [{ code: 'PROC_COMPILATION_DRIFT', path: '/compilationRef/graphHash' }] };
  }

  const contracts = new Map<string, { contract: SemanticCapabilityContract; state: StepRegistryState }>();
  for (const { step, index } of capabilitySteps) {
    const at = `/steps/${index}`;
    const projection = compilation.capabilities.find((c) => c.capabilityId === step.capabilityId);
    if (projection === undefined) {
      add('PROC_UNRESOLVED_CAPABILITY', `${at}/capabilityId`);
      continue;
    }
    const configured = externalTools?.describe(projection.contractId);
    if (projection.status !== 'resolved' && configured === undefined) {
      add('PROC_UNRESOLVED_CAPABILITY', `${at}/capabilityId`);
      continue;
    }
    if (step.contractId !== undefined && step.contractId !== projection.contractId) add('PROC_CONTRACT_MISMATCH', `${at}/contractId`);
    const built = buildSemanticCapabilityContract(compilation.graph, XoirNodeId(step.capabilityId));
    const derived = deriveCapabilityApprovalState(compilation.graph, step.capabilityId, compilation.sourceDigestSha256);
    if (!built.ok || !derived.ok) {
      add('PROC_UNRESOLVED_CAPABILITY', `${at}/capabilityId`);
      continue;
    }
    if (built.value.id !== projection.contractId) {
      add('PROC_CONTRACT_MISMATCH', `${at}/capabilityId`);
      continue;
    }
    if (declaredPermissionsForNode(compilation.graph, step.capabilityId).kind === 'unresolved') {
      add('PROC_PERMISSION_DECLARATION_UNRESOLVED', `${at}/capabilityId`);
      continue;
    }
    let cls = derived.value.implementationClass;
    let bindingId = derived.value.bindingId;
    let stateDigest = derived.value.stateDigest;
    let externalInputSchema: CapabilityInputSchema | undefined;
    if (configured !== undefined && !cls.startsWith('unresolved:')) {
      // Configuration conflict: the AUTHORITATIVE derivation (not the stored projection) says the standard resolvers bind this capability.
      // Refuse rather than choose between the approved standard binding and the adapter.
      add('PROC_UNSUPPORTED_CAPABILITY_CLASS', `${at}/capabilityId`);
      continue;
    }
    if (configured !== undefined) {
      const bound = externalTools?.resolver.resolve(built.value);
      if (bound === undefined || bound.status !== 'resolved') {
        add('PROC_UNRESOLVED_CAPABILITY', `${at}/capabilityId`);
        continue;
      }
      // The adapter configuration is part of what is approved: changing the adapter or its input schema changes this digest, so an
      // approval granted for one configuration is stale under another (fail-closed `stale_binding` before anything is dispatched).
      cls = 'external_tool';
      bindingId = bound.binding.id;
      externalInputSchema = configured.inputSchema;
      stateDigest = String(
        new Sha256Hasher().hash(
          canonicalStringify({
            schema: 'xo.external-step-state.v2',
            base: derived.value.stateDigest,
            bindingId,
            adapterId: configured.adapterId,
            inputSchema: stableJson(configured.inputSchema),
            // Digest of the adapter's security-relevant configuration (never the values): any change makes an earlier approval stale.
            adapterConfigDigest: configured.configDigest,
          }),
        ),
      );
    }
    if (cls === 'ai_provider') {
      add('PROC_AI_STEP_DISABLED', `${at}/capabilityId`);
      continue;
    }
    if (cls.startsWith('unresolved:')) {
      add('PROC_UNRESOLVED_CAPABILITY', `${at}/capabilityId`);
      continue;
    }
    if (!SUPPORTED_CLASSES.has(cls)) {
      add('PROC_UNSUPPORTED_CAPABILITY_CLASS', `${at}/capabilityId`);
      continue;
    }
    contracts.set(step.id, {
      contract: built.value,
      state: {
        stepId: step.id,
        capabilityId: step.capabilityId,
        contractId: derived.value.contractId,
        contractContentHash: derived.value.contractContentHash,
        declarationFingerprint: derived.value.declarationFingerprint,
        implementationClass: cls,
        bindingId,
        stateDigest,
        confidence: projection.confidence,
        ...(externalInputSchema !== undefined ? { externalInputSchema } : {}),
      },
    });
  }

  // Binding / reference checks run only against steps whose contracts were established.
  const schemas = schemasByContract(compilation.graph);
  for (const { step, index } of capabilitySteps) {
    const mine = contracts.get(step.id);
    if (mine === undefined) continue;
    const declared = new Map(mine.contract.inputs.map((p) => [p.name, p] as const));
    // A parameter is also declared when it names a property of the capability's execution input schema (P1.1 M3 finding: a
    // capability's client-supplied inputs live in that schema and need not appear among its contract `inputs`).
    const schemaProps = (mine.state.externalInputSchema ?? schemas.get(mine.state.contractId))?.properties ?? {};
    const bound = new Set<string>();
    (step.inputBindings ?? []).forEach((b, j) => {
      const bp = `/steps/${index}/inputBindings/${j}`;
      const param = declared.get(b.param);
      const inSchema = Object.prototype.hasOwnProperty.call(schemaProps, normalizeToFallbackKey(b.param));
      if (param === undefined && !inSchema) add('PROC_UNKNOWN_INPUT_PARAM', `${bp}/param`);
      else bound.add(b.param);
      if (!('step' in b.from)) return;
      const producer = contracts.get(b.from.step);
      if (producer === undefined) return; // producer itself already produced a finding (or is not a capability step: M1 caught it)
      const out = producer.contract.outputs.find((o) => o.name === (b.from as { output: string }).output);
      if (out === undefined) {
        add('PROC_BINDING_OUTPUT_UNDECLARED', `${bp}/from/output`);
        return;
      }
      const a = out.semanticType;
      const c = param?.semanticType;
      if (a !== undefined && c !== undefined && a !== 'unknown' && c !== 'unknown' && a !== c)
        add('PROC_BINDING_TYPE_MISMATCH', `${bp}/from/output`);
    });
    for (const p of mine.contract.inputs) {
      if (p.required === true && !bound.has(p.name)) add('PROC_UNBOUND_REQUIRED_INPUT', `/steps/${index}`);
    }
    // P1.1 M3 closeout (owner decision D5): a REQUIRED property of the capability's execution input schema must be bound too.
    // Execution inputs are assembled only from bindings, so an unbound required property can never be supplied; start-time
    // validation already fails such a procedure closed -- approval must not pass it. Same rule, enforced earlier (no inference).
    const boundKeys = new Set([...bound].map((n) => normalizeToFallbackKey(n)));
    for (const key of (mine.state.externalInputSchema ?? schemas.get(mine.state.contractId))?.required ?? []) {
      const path = `/steps/${index}`;
      if (!boundKeys.has(key) && !findings.some((f) => f.code === 'PROC_UNBOUND_REQUIRED_INPUT' && f.path === path))
        add('PROC_UNBOUND_REQUIRED_INPUT', path);
    }
  }

  // Condition references to step outputs must name a declared output of a capability step.
  const checkOutputRef = (path: string, at: string): void => {
    const segs = path.split('.');
    if (segs[0] !== 'steps' || segs.length < 4) return;
    const producer = contracts.get(segs[1] as string);
    if (producer === undefined) return;
    if (!producer.contract.outputs.some((o) => o.name === segs[3])) add('PROC_BINDING_OUTPUT_UNDECLARED', at);
  };
  def.steps.forEach((s, i) => {
    if (s.kind === 'decision') checkOutputRef(s.condition.path, `/steps/${i}/condition/path`);
  });
  (def.then ?? []).forEach((c, j) => checkOutputRef(c.path, `/then/${j}/path`));

  if (findings.length > 0) return { ok: false, findings };
  const steps = capabilitySteps.map(({ step }) => (contracts.get(step.id) as { state: StepRegistryState }).state);
  const digest = String(
    new Sha256Hasher().hash(
      canonicalStringify({
        schema: 'xo.procedure-registry-state.v1',
        compilationId: compilation.compilationId,
        graphHash: compilation.graphHash,
        steps: steps.map((s) => ({ stepId: s.stepId, capabilityId: s.capabilityId, stateDigest: s.stateDigest })),
      }),
    ),
  );
  return { ok: true, snapshot: { compilationId: compilation.compilationId, graphHash: compilation.graphHash, digest, steps } };
}

/** True when ANY step is presumed effectful: an advisory `effectIntent: write` (escalation-only) or an `external_tool` class. Authoritative effect classification is unresolved (owner O-2) and is NOT claimed. */
export function presumedEffectful(def: ProcedureDefinition, snapshot: RegistrySnapshot | undefined): boolean {
  if (def.steps.some((s) => s.kind === 'capability' && s.effectIntent === 'write')) return true;
  return snapshot?.steps.some((s) => s.implementationClass === 'external_tool') === true;
}
