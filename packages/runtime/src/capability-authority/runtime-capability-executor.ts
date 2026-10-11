import { err, ok, type Result } from '@xo/types';
import { PackageId, type ContentHash } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import {
  authorizeCapabilityExecution,
  isAuthorizationSubject,
  type AuthorizationSubject,
  type PermissionContext,
  type PermissionManager,
} from '@xo/permissions';
import type { RuntimeCapabilityRegistry } from './runtime-capability-registry.js';

/**
 * The identity a native Runtime capability's permission checks are
 * attributed to when no `.xo` package is involved — every
 * `PermissionRequest` (`@xo/permissions`) requires a `requester.packageId`
 * for its audit trail (see `request.ts`'s `PermissionRequester`), and a
 * capability registered directly against `RuntimeCapabilityRegistry` has
 * no package to supply one. A caller that *does* want per-caller
 * attribution (e.g. distinguishing which host subsystem invoked a given
 * native capability) can override this via
 * `RuntimeCapabilityExecutionRequest.requesterPackageId`.
 */
export const NATIVE_CAPABILITY_REQUESTER = PackageId('runtime:native-capability');

export interface RuntimeCapabilityExecutorOptions {
  readonly registry: RuntimeCapabilityRegistry;
  readonly permissionManager: PermissionManager;
  /**
   * P1.0 M2 — REQUIRED. WHO this executor acts for: an
   * `AuthenticatedPrincipal` (API) or a `TrustedExecutionContext` (local
   * CLI operator). Verified at construction AND on every `execute`; the
   * executor refuses to be built without one, so there is no
   * "no principal ⇒ unrestricted" mode. Distinct from the requesting
   * package/capability identity (`requesterPackageId` / `capabilityId`).
   */
  readonly subject: AuthorizationSubject;
}

export interface RuntimeCapabilityExecutionRequest {
  readonly capabilityId: string;
  readonly input: unknown;
  /** Overrides `NATIVE_CAPABILITY_REQUESTER` for this call's permission-check audit attribution. Does not change *which* capability or permission requirements are checked — only who the check is recorded as being on behalf of. */
  readonly requesterPackageId?: string;
  readonly context?: PermissionContext;
  /**
   * M1.4 confidence gate, propagated per call rather than stored on this
   * class — see the class doc comment for why. `confidenceScore` is the
   * specific capability's own confidence (for the `ExecutionPipeline`
   * caller, `CapabilityDeclaration.confidence.score` from the same
   * already-selected declaration everything else on this call comes
   * from); `minConfidence` is the single, host-configured floor —
   * `ExecutionPipelineOptions.minConfidence` — forwarded verbatim, never
   * re-declared or independently reconfigured here. There is exactly one
   * place a host sets this threshold; this field only carries that one
   * value down to the boundary where a `deterministic_rule` capability
   * actually executes, so a caller that reaches this class directly
   * (bypassing `ExecutionPipeline.prepare()`'s own R3 gate entirely)
   * cannot run a below-floor capability either. Omitting `minConfidence`
   * (the default for any caller that doesn't supply it) makes this gate
   * a no-op, identical in spirit to `ExecutionPipelineOptions.minConfidence`
   * being undefined by default — no existing caller's behavior changes
   * unless it opts in.
   */
  readonly confidenceScore?: number;
  readonly minConfidence?: number;
}

export interface RuntimeCapabilityExecutionResult {
  readonly capabilityId: string;
  readonly output: unknown;
  /**
   * Passed through verbatim from the resolved `RuntimeCapabilityDeclaration`
   * when present (i.e. the declaration was registered via
   * `registerResolvedCapabilityBinding`) — never fabricated for a
   * hand-authored declaration that carries none. See that field's doc
   * comment on `RuntimeCapabilityDeclaration` for what depends on this.
   */
  readonly contractId?: string;
  readonly bindingId?: string;
  readonly sourceXoirNodeIds?: readonly string[];
  /** P0.9B — same pass-through convention as the three fields above; see `RuntimeCapabilityDeclaration.graphHash`'s doc comment. */
  readonly graphHash?: ContentHash;
  /** P0.9B — same pass-through convention; see `RuntimeCapabilityDeclaration.contractContentHash`. */
  readonly contractContentHash?: ContentHash;
}

/**
 * Runtime capability authority's execution boundary. Every call goes
 * through, in order: (1) resolve the declaration from
 * `RuntimeCapabilityRegistry` — fails closed on an unknown id; (2) M1.4
 * confidence gate — if the caller supplied a `minConfidence` floor (see
 * `RuntimeCapabilityExecutionRequest`'s doc comment), deny unless
 * `confidenceScore` clears it; (3) check every permission requirement
 * registered for that id via `registry.permissions` (the *same*
 * `CapabilityPermissionRegistry` `PermissionManagerGate` reads for the
 * manifest-declared path — see that file), using the *same*
 * `PermissionManager.check` the rest of the runtime already uses — this
 * class creates no new permission machinery of its own; (4) only once
 * both gates pass, invoke `declaration.handler(input)`.
 *
 * There is no path through this class that reaches a `handler` without
 * 1, 2, and 3 all succeeding — a capability with zero registered
 * permission requirements still passes through the permission check
 * (trivially: an empty requirement list has nothing to deny), and a
 * call that supplies no `minConfidence` still passes through the
 * confidence check (trivially: nothing was asked to be enforced) —
 * neither gate is ever skipped outright, only satisfied vacuously when
 * unconfigured. This is what closes the M1.4 "direct
 * `RuntimeCapabilityExecutor` call bypasses confidence gating" gap:
 * `ExecutionPipeline.prepare()`'s own R3 gate (checked earlier, against
 * the same `minConfidence`) is unchanged and still runs first for any
 * call that goes through the pipeline; this is the same check enforced
 * again at the actual execution boundary, so a caller that reaches this
 * class some other way is held to the identical, single configured
 * floor rather than none at all. There is deliberately no
 * `minConfidence` field on `RuntimeCapabilityExecutorOptions` — see this
 * class's constructor and `RuntimeCapabilityExecutionRequest`'s doc
 * comment — so there is exactly one place a host configures this
 * threshold, never two that could drift apart.
 *
 * Mirrors `permission-manager-gate.ts`'s own denial semantics: a
 * `prompt` decision from `PermissionManager.check` is treated as a
 * denial here too (this class never calls `PermissionManager.request`,
 * so it never triggers interactive consent on the caller's behalf) —
 * same reasoning as that file's doc comment: there is no way to pause
 * mid-execution for a user prompt from inside a synchronous-from-the-
 * caller's-perspective capability call.
 */
export class RuntimeCapabilityExecutor {
  private readonly registry: RuntimeCapabilityRegistry;
  private readonly permissionManager: PermissionManager;
  private readonly subject: AuthorizationSubject;

  constructor(options: RuntimeCapabilityExecutorOptions) {
    // Fail closed at construction: an executor with no verifiable subject or
    // no policy must not exist (JS callers can omit what TypeScript requires).
    if (!isAuthorizationSubject(options.subject)) {
      throw new RuntimeError(
        ErrorCode.RUNTIME_PERMISSION_DENIED,
        'RuntimeCapabilityExecutor requires a verified AuthenticatedPrincipal or TrustedExecutionContext as its subject',
      );
    }
    if (
      options.permissionManager === undefined ||
      options.permissionManager === null ||
      typeof options.permissionManager.check !== 'function'
    ) {
      throw new RuntimeError(
        ErrorCode.RUNTIME_PERMISSION_DENIED,
        'RuntimeCapabilityExecutor requires a PermissionManager (no gate configured ⇒ denied)',
      );
    }
    this.registry = options.registry;
    this.permissionManager = options.permissionManager;
    this.subject = options.subject;
  }

  async execute(request: RuntimeCapabilityExecutionRequest): Promise<Result<RuntimeCapabilityExecutionResult, RuntimeError>> {
    // 1. Resolution — fails closed on an unknown capability id.
    const resolved = this.registry.resolve(request.capabilityId);
    if (!resolved.ok) return err(resolved.error);
    const declaration = resolved.value;

    // 2. M1.4 confidence gate — see the class doc comment and
    // `RuntimeCapabilityExecutionRequest`'s doc comment. Runs before the
    // permission loop, mirroring `ExecutionPipeline.prepare()`'s own
    // confidence-before-authorization ordering, and denies with the same
    // `RUNTIME_CONFIDENCE_BELOW_THRESHOLD` code that gate uses, so a
    // confidence denial and a permission denial remain distinguishable
    // by error code at this boundary too. A no-op whenever the caller
    // doesn't supply `minConfidence` for this call.
    if (request.minConfidence !== undefined && (request.confidenceScore === undefined || request.confidenceScore < request.minConfidence)) {
      return err(
        new RuntimeError(
          ErrorCode.RUNTIME_CONFIDENCE_BELOW_THRESHOLD,
          `Runtime capability "${request.capabilityId}" has confidence ${request.confidenceScore ?? 'unknown'}, below the configured minimum of ${request.minConfidence}`,
        ),
      );
    }

    // 3. Authorization — ONE decision (`@xo/permissions`'
    // `authorizeCapabilityExecution`) over: the verified subject, the
    // requesting package/capability, and the capability's explicit
    // permission declaration. A missing/unresolved declaration, an
    // unverifiable subject, or any non-`allow` requirement is a denial
    // BEFORE the handler runs. A permission-free capability (`[]`) still
    // needs the verified subject.
    const requesterPackageId = PackageId(request.requesterPackageId ?? NATIVE_CAPABILITY_REQUESTER);
    const authorization = await authorizeCapabilityExecution({
      manager: this.permissionManager,
      subject: this.subject,
      requester: { packageId: requesterPackageId, capabilityId: request.capabilityId },
      declaration: this.registry.permissionDeclaration(request.capabilityId),
      ...(request.context !== undefined ? { context: request.context } : {}),
    });
    if (!authorization.allowed) {
      return err(
        new RuntimeError(
          ErrorCode.RUNTIME_PERMISSION_DENIED,
          `Runtime capability "${request.capabilityId}" was not authorized: ${authorization.reason}`,
        ),
      );
    }

    // 4. Execution — only ever reached after 1, 2, and 3 all succeed.
    let handlerResult: Result<unknown, RuntimeError>;
    try {
      handlerResult = await declaration.handler(request.input);
    } catch (cause) {
      return err(
        new RuntimeError(
          ErrorCode.RUNTIME_CAPABILITY_HANDLER_UNAVAILABLE,
          `Runtime capability "${request.capabilityId}"'s handler threw: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        ),
      );
    }
    if (!handlerResult.ok) return err(handlerResult.error);

    return ok({
      capabilityId: request.capabilityId,
      output: handlerResult.value,
      ...(declaration.contractId !== undefined ? { contractId: declaration.contractId } : {}),
      ...(declaration.bindingId !== undefined ? { bindingId: declaration.bindingId } : {}),
      ...(declaration.sourceXoirNodeIds !== undefined ? { sourceXoirNodeIds: declaration.sourceXoirNodeIds } : {}),
      ...(declaration.graphHash !== undefined ? { graphHash: declaration.graphHash } : {}),
      ...(declaration.contractContentHash !== undefined ? { contractContentHash: declaration.contractContentHash } : {}),
    });
  }
}
