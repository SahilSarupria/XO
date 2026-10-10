import type { PackageInstaller } from '@xo/package-sdk';
import {
  CapabilityRegistry,
  executeResolvedContract,
  resolveContractBinding,
  type MountedPackage,
  type PackageRegistry,
} from '@xo/runtime';
import {
  extractContractFromPropertyBag,
  StructuredComparisonBindingResolver,
  validateCapabilityInput,
  type SemanticCapabilityContract,
} from '@xo/capability-contract';
import {
  authorizeCapabilityExecution,
  isAuthorizationSubject,
  parsePermissionId,
  Permissions,
  PERMISSION_FREE,
  PermissionManager,
  attestAuthoritativeDeclaration,
  resolveDeclaredPermissionIds,
  resolveManifestCapabilityPermissions,
  RuleBasedPolicy,
  unresolvedDeclaration,
  type AuthorizationSubject,
  type PermissionDeclaration,
  type PermissionRequirement,
  type PolicyRule,
} from '@xo/permissions';
import type { CapabilityExecutionDeclaration, PackageId } from '@xo/types';

/**
 * `xo run <capabilityId>` must NOT resolve an AI provider merely because
 * a capability is being executed through the CLI — see the runtime
 * workstream brief's "PRIMARY ARCHITECTURAL ISSUE." This module is the
 * decision point that was missing.
 *
 * This file now implements three separately-scoped stages, run in order,
 * on top of the CapabilityDescriptor/CapabilityRegistry the runtime
 * already builds from every mounted package's manifest:
 *
 *   R1 — prefer the AUTHORITATIVE `CapabilityDeclaration.execution`
 *        field (`@xo/types`) over inferring a strategy by scanning
 *        knowledge-graph content. Falls back to the original
 *        knowledge-graph scan, explicitly, only when no authoritative
 *        declaration exists — see `resolveExecutionSource` below.
 *   R2 — validate `--input` against `execution.inputSchema`
 *        (`@xo/capability-contract`'s `validateCapabilityInput`) BEFORE
 *        the deterministic binding is ever evaluated.
 *   R3 — gate execution on the capability's own declared confidence
 *        (`CapabilityDeclaration.confidence`, R3's "execution-eligible
 *        confidence state") and on real, manifest-derived permission
 *        authorization (`@xo/permissions`' `resolveManifestCapabilityPermissions`
 *        + `PermissionManager`, default-deny) — replacing the previous,
 *        hardcoded always-ALLOW policy this file shipped with.
 *
 * Everything here remains additive: it never touches `ExecutionEngine`,
 * `ExecutionPipeline`, `CapabilityNegotiator`, or any AI-provider code,
 * and any `not_deterministic` outcome falls straight through to the
 * unchanged AI-provider path in `run.ts`.
 */

export type DeterministicRunOutcome =
  | {
      readonly kind: 'executed';
      readonly output: unknown;
      readonly bindingId: string;
      readonly contractId: string;
      readonly sourceXoirNodeIds: readonly string[];
      readonly source: ExecutionSourceKind;
      readonly confidence: number;
    }
  | { readonly kind: 'not_deterministic'; readonly reason: string }
  | { readonly kind: 'invalid_input'; readonly issues: readonly { readonly property: string; readonly message: string }[] }
  | { readonly kind: 'confidence_ineligible'; readonly score: number; readonly threshold: number }
  | { readonly kind: 'not_authorized'; readonly reason: string }
  | { readonly kind: 'error'; readonly message: string };

export type ExecutionSourceKind = 'authoritative_declaration' | 'knowledge_graph_fallback';

/**
 * R3's confidence eligibility threshold — deliberately a single named,
 * exported, testable constant rather than a magic number inlined at the
 * call site. `0.7` is a placeholder policy value, not a value derived
 * from any spec; a future phase may want this configurable per-host or
 * per-package, but R3's ask was only that it be *explicit*, not that it
 * be configurable yet — see the report's "not implemented" list.
 */
export const MIN_DETERMINISTIC_EXECUTION_CONFIDENCE = 0.7;

interface ExecutionSource {
  readonly kind: ExecutionSourceKind;
  readonly contract: SemanticCapabilityContract;
  readonly declaredExecution: CapabilityExecutionDeclaration | undefined;
  readonly confidence: number;
  readonly mountedPackage: MountedPackage;
  /** P1.0 M2 — the capability node's own persisted `requiredPermissions` property, exactly as stored in the package's knowledge_graph (`undefined` if the property is absent). The authoritative permission declaration; never a CLI flag. */
  readonly declaredRequiredPermissions: unknown;
}

/**
 * Searches every mounted package's `knowledge_graph` component for a
 * `capability`-kind node whose id matches `contractId` and that carries
 * an embedded `semanticCapabilityContract`. This is now called ONLY in
 * two situations: (a) the fallback path, when no authoritative
 * `execution` field exists at all, in which case `contractId ===
 * capabilityId` and this behaves exactly as it did before R1; or (b) a
 * TARGETED fetch, once an authoritative declaration has already named
 * exactly which `contractId` to look up — no longer a blind scan over
 * unknown node shapes for that case, since the mode/schema/permissions
 * decision was already made from `execution` before this function is
 * even called.
 */
async function fetchContract(
  contractId: string,
  installer: PackageInstaller,
  mountedPackages: readonly MountedPackage[],
): Promise<
  Result<
    | {
        readonly contract: SemanticCapabilityContract;
        readonly mountedPackage: MountedPackage;
        readonly declaredRequiredPermissions: unknown;
      }
    | undefined,
    string
  >
> {
  for (const mounted of mountedPackages) {
    const component = await installer.getComponent(mounted.name, mounted.version, 'knowledge_graph');
    if (!component.ok) continue; // no knowledge_graph component for this package — not an error, just nothing to find here

    let parsed: {
      readonly nodes?: readonly { readonly id: string; readonly kind: string; readonly properties?: Record<string, unknown> }[];
    };
    try {
      parsed = JSON.parse(new TextDecoder().decode(component.value)) as typeof parsed;
    } catch (cause) {
      return {
        ok: false,
        error: `"${mounted.name}@${mounted.version}"'s knowledge_graph component is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }

    const node = (parsed.nodes ?? []).find((n) => n.kind === 'capability' && n.id === contractId);
    if (!node?.properties) continue;

    const extracted = extractContractFromPropertyBag(node.properties);
    if (!extracted.ok) continue; // present but no embedded contract on this node — not this capability's source

    return {
      ok: true,
      value: { contract: extracted.value, mountedPackage: mounted, declaredRequiredPermissions: node.properties['requiredPermissions'] },
    };
  }
  return { ok: true, value: undefined };
}

/**
 * R1's decision point. Looks up `capabilityId` in the runtime's own
 * `CapabilityRegistry` (built from every mounted package's manifest —
 * the SAME index `CapabilityNegotiator` uses for the AI-provider path,
 * not a parallel one) and checks for an authoritative
 * `declaration.execution` field:
 *
 * - If present and `mode === 'deterministic_rule'`: fetch the named
 *   `contractId` directly (a targeted lookup, not a scan) and return an
 *   `authoritative_declaration` source, carrying whatever `inputSchema`/
 *   `requiredPermissionIds` the declaration itself specified.
 * - If present with any other `mode`: this capability is authoritatively
 *   NOT deterministic — return `undefined` immediately, without ever
 *   touching the knowledge graph. This is a meaningfully different,
 *   *faster* negative than the pre-R1 behavior, which had to fetch and
 *   parse the knowledge graph before it could conclude "not
 *   deterministic."
 * - If `execution` is absent entirely (every `.xo` package compiled
 *   before R1, or one whose compiler never populated it): fall back,
 *   EXPLICITLY, to the original knowledge-graph scan keyed by
 *   `capabilityId` itself, returning a `knowledge_graph_fallback`
 *   source. This is backward compatibility, not a silent behavior
 *   change — the outcome's `source` field lets a caller (and this
 *   module's tests) tell the two paths apart.
 * - If `capabilityId` isn't declared in any mounted manifest at all
 *   (matching R3's "discovered ≠ trusted ≠ executable": this capability
 *   was never even *discovered*), still attempt the knowledge-graph
 *   fallback rather than failing outright — a package predating
 *   manifest-level capability declarations entirely (unlikely in
 *   practice, since `CapabilityDeclaration` isn't new, but not
 *   impossible) shouldn't lose deterministic execution just because R1
 *   post-dates it.
 */
async function resolveExecutionSource(
  capabilityId: string,
  installer: PackageInstaller,
  packageRegistry: PackageRegistry,
): Promise<Result<ExecutionSource | undefined, string>> {
  const capabilities = CapabilityRegistry.fromPackages(packageRegistry.all()).find(capabilityId);
  const descriptor = capabilities[0]; // capability ids are expected unique across a store, matching every other lookup in this CLI; see helpers/README for the multi-package caveat

  if (descriptor?.declaration.execution !== undefined) {
    const execution = descriptor.declaration.execution;
    if (execution.mode !== 'deterministic_rule') return { ok: true, value: undefined };

    const contractId = execution.contractId ?? capabilityId;
    const fetched = await fetchContract(contractId, installer, packageRegistry.all());
    if (!fetched.ok) return fetched;
    if (fetched.value === undefined) {
      return {
        ok: false,
        error: `Capability "${capabilityId}" declares an authoritative deterministic execution with contractId "${contractId}", but no mounted package's knowledge_graph actually contains a contract under that id — the package is internally inconsistent`,
      };
    }
    return {
      ok: true,
      value: {
        kind: 'authoritative_declaration',
        contract: fetched.value.contract,
        declaredExecution: execution,
        confidence: descriptor.declaration.confidence.score,
        mountedPackage: fetched.value.mountedPackage,
        declaredRequiredPermissions: fetched.value.declaredRequiredPermissions,
      },
    };
  }

  // Fallback: no authoritative declaration anywhere for this capability id — try the knowledge-graph scan directly, exactly as before R1.
  const fetched = await fetchContract(capabilityId, installer, packageRegistry.all());
  if (!fetched.ok) return fetched;
  if (fetched.value === undefined) return { ok: true, value: undefined };
  // No manifest-level CapabilityDeclaration was found for this id, so there is no authoritative `confidence` to read either — the contract's OWN `confidence` (set by the compiler at extraction time, `@xo/capability-contract`'s `SemanticCapabilityContract.confidence`) is the best available signal, and R3 still applies to it.
  return {
    ok: true,
    value: {
      kind: 'knowledge_graph_fallback',
      contract: fetched.value.contract,
      declaredExecution: undefined,
      confidence: descriptor?.declaration.confidence.score ?? fetched.value.contract.confidence,
      mountedPackage: fetched.value.mountedPackage,
      declaredRequiredPermissions: fetched.value.declaredRequiredPermissions,
    },
  };
}

/**
 * `xo run`'s `--input` is always a plain string. R2 needs a structured
 * object before it can validate against an `inputSchema`, and the
 * deterministic evaluator needs one to execute at all — this parses
 * once, up front, and is reused by both. A non-JSON (ordinary free-text)
 * `--input` is `not_deterministic`, not `invalid_input`: R2's schema
 * validation is a stricter, capability-specific check that only applies
 * once we already know this is a structured-input request; a caller
 * simply asking a free-text question is the ordinary AI-provider case,
 * unchanged (see the brief's HYBRID EXECUTION section for the
 * text→structured path, not implemented here).
 */
function parseStructuredInput(raw: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

/**
 * R3's authorization step, reusing `@xo/permissions`' existing
 * manifest-derived requirement resolution
 * (`resolveManifestCapabilityPermissions`) rather than this file's
 * previous hand-rolled, hardcoded requirement + always-ALLOW policy.
 * Required permissions now come from TWO real sources, both additive:
 * the manifest's own `permissions[]` declarations for this capability
 * id (the package author's stated requirement), and the authoritative
 * `execution.requiredPermissionIds`, if any (an execution-*mode*-level
 * requirement — see that field's doc comment in `@xo/types`). Neither
 * is fabricated by this file.
 *
 * `manager` is built once per run by {@link buildPermissionManager} from
 * CLI-provided `--grant` flags — R3's "smallest necessary policy
 * boundary." With none granted, the `RuleBasedPolicy` default (`DENY`,
 * per `@xo/permissions`) applies and every requirement is refused,
 * closed — never "permission exists so it's fine," matching R3's
 * requirement 6.
 */
/**
 * P1.0 M2 — the authoritative permission declaration for one installed
 * capability. Sources, none of them a CLI flag:
 *
 *  1. the capability node's own persisted `requiredPermissions` property in
 *     the package's knowledge_graph — REQUIRED to be present (`[]` is the
 *     explicit permission-free declaration; absent/malformed => `unresolved`);
 *  2. the manifest's `permissions[]` entries naming this capability, and
 *  3. its `execution.requiredPermissionIds`, if declared — both ADDITIVE
 *     (they can only make the capability stricter), and both denied if
 *     malformed.
 */
function buildPermissionDeclaration(source: ExecutionSource, capabilityId: string): PermissionDeclaration {
  const label = `"${source.mountedPackage.name}@${source.mountedPackage.version}" capability "${capabilityId}"`;
  const base = resolveDeclaredPermissionIds(source.declaredRequiredPermissions, `${label} requiredPermissions`);
  if (base.kind === 'unresolved') return base;

  const manifestResolution = resolveManifestCapabilityPermissions(source.mountedPackage.manifest);
  if (!manifestResolution.ok)
    return unresolvedDeclaration(`${label}: malformed permission declaration(s) in the manifest: ${manifestResolution.error.join('; ')}`);

  const requirements: PermissionRequirement[] = [
    ...(base.kind === 'required' ? base.requirements : []),
    ...(manifestResolution.value.get(capabilityId) ?? []),
  ];

  if (source.declaredExecution?.requiredPermissionIds !== undefined) {
    const exec = resolveDeclaredPermissionIds(source.declaredExecution.requiredPermissionIds, `${label} execution.requiredPermissionIds`);
    if (exec.kind === 'unresolved') return exec;
    if (exec.kind === 'required') requirements.push(...exec.requirements);
  }

  const seen = new Set<string>();
  const unique = requirements.filter((r) => {
    const key = `${r.permission}|${JSON.stringify(r.scope ?? null)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.length === 0 ? PERMISSION_FREE : { kind: 'required', requirements: unique };
}

/**
 * `--grant` flags are local OPERATOR POLICY (an `ALLOW` rule per permission
 * for this one invocation) — they are not identity and not proof of any
 * principal. Subject = a `TrustedExecutionContext` minted by the CLI command
 * entry; a request/manifest/flag cannot create one.
 */
function buildPermissionManager(grantedPermissionIds: readonly string[]): Result<PermissionManager, string> {
  const grantRules: PolicyRule[] = [];
  for (const [i, raw] of grantedPermissionIds.entries()) {
    const parsed = parsePermissionId(raw);
    if (!parsed.ok) return { ok: false, error: `--grant "${raw}" is not a valid permission id: ${parsed.error}` };
    grantRules.push({ id: `cli-grant-${i}`, effect: 'ALLOW', match: { permission: parsed.value.id } });
  }
  return { ok: true, value: new PermissionManager({ policy: new RuleBasedPolicy(grantRules) }) };
}

/**
 * The one entry point `run.ts` calls before ever resolving a
 * `ModelProvider`. Runs, in order: R1 (locate an execution source),
 * `not_deterministic` short-circuit, R2 (input parsing + schema
 * validation), R3 (confidence eligibility, then authorization),
 * execution.
 */
export async function tryDeterministicRun(
  capabilityId: string,
  rawInput: string,
  installer: PackageInstaller,
  packageRegistry: PackageRegistry,
  grantedPermissionIds: readonly string[],
  subject: AuthorizationSubject,
): Promise<DeterministicRunOutcome> {
  // P1.0 M2: fail closed BEFORE anything is looked up or evaluated if the caller has no verified subject.
  if (!isAuthorizationSubject(subject))
    return { kind: 'not_authorized', reason: 'no verified trusted execution context — deterministic execution is denied' };
  const found = await resolveExecutionSource(capabilityId, installer, packageRegistry);
  if (!found.ok) return { kind: 'error', message: found.error };
  if (found.value === undefined)
    return {
      kind: 'not_deterministic',
      reason: `Capability "${capabilityId}" has no deterministic execution source — no authoritative execution declaration names it as "deterministic_rule", and no mounted package's knowledge_graph declares a matching embedded SemanticCapabilityContract either`,
    };

  const source = found.value;
  // Deliberately the narrower, single-resolver list (not
  // `STANDARD_BINDING_RESOLVERS`): the installed-package path only ever
  // routes structured-comparison bindings deterministically. Unchanged by
  // P0.9B — `resolveContractBinding` only supplies the call, never a wider set.
  const binding = resolveContractBinding(source.contract, [new StructuredComparisonBindingResolver()]);
  if (binding.status !== 'resolved' || binding.binding.implementationClass !== 'deterministic_rule') {
    return {
      kind: 'not_deterministic',
      reason:
        binding.status === 'resolved'
          ? `Contract "${source.contract.id}" resolved to implementationClass "${binding.binding.implementationClass}", which this CLI's deterministic router does not execute directly`
          : `Contract "${source.contract.id}" did not resolve to a deterministic binding (${binding.status}: ${binding.reason})`,
    };
  }

  // R2 — parse, then validate against the authoritative inputSchema if one was declared.
  //
  // Two different postures depending on whether an inputSchema exists:
  //   - inputSchema PRESENT (R1 authoritative declaration said so): this
  //     capability has a known, structured contract. --input that fails
  //     to parse as JSON at all is now a hard `invalid_input` (not a
  //     silent fall-through to the AI-provider path) — the contract is
  //     unambiguous, so "not JSON" is a contract violation, not "maybe
  //     this was meant as a free-text query instead."
  //   - inputSchema ABSENT (fallback path, or an authoritative
  //     declaration that simply omitted it): no structural claim was
  //     ever made about this capability's input shape, so non-JSON
  //     --input is treated as `not_deterministic` — falling through to
  //     the AI path exactly as this router behaved before R2 existed.
  const inputSchema = source.declaredExecution?.inputSchema;
  const structuredInput = parseStructuredInput(rawInput);

  if (inputSchema !== undefined) {
    if (structuredInput === undefined) {
      return {
        kind: 'invalid_input',
        issues: [{ property: '$', message: `--input is not valid JSON matching capability "${capabilityId}"'s declared input schema` }],
      };
    }
    const validation = validateCapabilityInput(inputSchema, structuredInput);
    if (!validation.valid) return { kind: 'invalid_input', issues: validation.issues };
  } else if (structuredInput === undefined) {
    return {
      kind: 'not_deterministic',
      reason: `Capability "${capabilityId}" has a deterministic binding, but --input is not structured JSON (a plain object) — a deterministic rule cannot be evaluated against free-text input without a model-assisted extraction step (see the brief's HYBRID EXECUTION section, not implemented by this router). Pass --input as JSON, e.g. '{"claim_amount": 15000}'.`,
    };
  }
  // structuredInput is defined at this point on every path that reaches here.
  const validatedInput = structuredInput as Record<string, unknown>;

  // R3, step 1 — confidence eligibility, fail closed.
  if (source.confidence < MIN_DETERMINISTIC_EXECUTION_CONFIDENCE) {
    return { kind: 'confidence_ineligible', score: source.confidence, threshold: MIN_DETERMINISTIC_EXECUTION_CONFIDENCE };
  }

  // R3, step 2 — real, manifest-derived authorization (default-deny).
  const managerResult = buildPermissionManager(grantedPermissionIds);
  if (!managerResult.ok) return { kind: 'error', message: managerResult.error };
  const manager = managerResult.value;

  // Minted for exactly this contract from the installed package's own metadata (never from --grant/--input/flags).
  const declaration = attestAuthoritativeDeclaration(buildPermissionDeclaration(source, capabilityId), {
    capabilityId: source.contract.id,
    origin: 'installed-package-manifest',
  });
  const authorization = await authorizeCapabilityExecution({
    manager,
    subject,
    requester: { packageId: `${source.mountedPackage.name}@${source.mountedPackage.version}` as PackageId, capabilityId },
    declaration,
  });
  if (!authorization.allowed) {
    const hint =
      authorization.code === 'permission-denied' && authorization.permission !== undefined
        ? ` — pass --grant ${authorization.permission} to authorize this run`
        : '';
    return { kind: 'not_authorized', reason: `${authorization.reason}${hint}` };
  }

  // The SAME declaration, subject and manager are re-applied inside `executeResolvedContract` (defense in depth).
  const executed = await executeResolvedContract(source.contract, binding.binding, {
    permissionManager: manager,
    subject,
    permissionDeclaration: declaration,
    input: validatedInput,
  });
  if (!executed.ok) {
    return executed.stage === 'registration'
      ? { kind: 'error', message: `Failed to register resolved binding: ${executed.error.message}` }
      : { kind: 'error', message: `[${executed.error.code}] ${executed.error.message}` };
  }
  const result = executed;

  return {
    kind: 'executed',
    output: result.value.output,
    bindingId: binding.binding.id,
    contractId: source.contract.id,
    sourceXoirNodeIds: source.contract.sourceXoirNodeIds,
    source: source.kind,
    confidence: source.confidence,
  };
}

// Re-exported so tests/callers can reference the same permission id this file's default `Permissions.runtime.execute` usage in earlier fixtures relied on, without importing `@xo/permissions` themselves just for that constant.
export { Permissions };

// Minimal local Result type — this file otherwise avoids depending on
// @xo/types' Result for its own internal helpers, since those helpers'
// errors are plain diagnostic strings, not RuntimeErrors.
type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };
