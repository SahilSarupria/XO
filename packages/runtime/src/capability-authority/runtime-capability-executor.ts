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

/**
 * P1.0 M4 — audit port for DIRECT runtime execution (CLI, embedders, anything that is not the API). Structural on
 * purpose: `@xo/runtime` does not depend on `@xo/audit`; `@xo/audit` provides an adapter.
 *
 * Semantics (enforced by `RuntimeCapabilityExecutor.execute`):
 *  - `beforeExecute` is a PRECONDITION called after authorization allowed and before the handler. If it rejects, the
 *    handler is NOT invoked and `execute` returns `AUDIT_UNAVAILABLE` (fail closed).
 *  - `onDenied` is best effort and never changes the denial.
 *  - `afterExecute` is best effort; it resolves `true` when completion evidence was recorded. It never changes or
 *    re-runs the result; `false` is surfaced as `auditFinalization` on a successful result.
 */
export interface RuntimeExecutionAuditInfo {
  readonly capabilityId: string;
  readonly requesterPackageId: string;
  readonly subject: AuthorizationSubject;
}
export interface RuntimeExecutionAudit {
  beforeExecute(info: RuntimeExecutionAuditInfo): Promise<void>;
  onDenied(info: RuntimeExecutionAuditInfo & { readonly reasonCode: string }): Promise<void>;
  afterExecute(info: RuntimeExecutionAuditInfo & { readonly ok: boolean; readonly reasonCode?: string }): Promise<boolean>;
}

export interface RuntimeCapabilityExecutorOptions {
  /** P1.0 M4 — optional durable-audit port; see {@link RuntimeExecutionAudit}. */
  readonly audit?: RuntimeExecutionAudit;
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
  /** P1.0 M4 — present ONLY when the capability ran but its completion audit evidence could not be recorded. The result is real; it was not re-run. */
  readonly auditFinalization?: 'failed';
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
  private readonly audit: RuntimeExecutionAudit | undefined;

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
    this.audit = options.audit;
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
    const auditInfo: RuntimeExecutionAuditInfo = {
      capabilityId: request.capabilityId,
      requesterPackageId: request.requesterPackageId ?? NATIVE_CAPABILITY_REQUESTER,
      subject: this.subject,
    };
    const denyAudited = async (reasonCode: string): Promise<void> => {
      try {
        await this.audit?.onDenied({ ...auditInfo, reasonCode });
      } catch {
        /* a denial is enforced regardless of whether it could be recorded */
      }
    };
    if (request.minConfidence !== undefined && (request.confidenceScore === undefined || request.confidenceScore < request.minConfidence)) {
      await denyAudited(ErrorCode.RUNTIME_CONFIDENCE_BELOW_THRESHOLD);
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
      await denyAudited(ErrorCode.RUNTIME_PERMISSION_DENIED);
      return err(
        new RuntimeError(
          ErrorCode.RUNTIME_PERMISSION_DENIED,
          `Runtime capability "${request.capabilityId}" was not authorized: ${authorization.reason}`,
        ),
      );
    }

    // 3b. P1.0 M4 precondition: durable evidence that execution is starting. Failure => handler never runs.
    if (this.audit !== undefined) {
      try {
        await this.audit.beforeExecute(auditInfo);
      } catch (cause) {
        return err(
          new RuntimeError(
            ErrorCode.AUDIT_UNAVAILABLE,
            `Runtime capability "${request.capabilityId}" was NOT executed: required audit evidence could not be durably recorded`,
            { cause },
          ),
        );
      }
    }
    const finish = async (ok: boolean, reasonCode?: string): Promise<boolean> => {
      if (this.audit === undefined) return true;
      try {
        return await this.audit.afterExecute({ ...auditInfo, ok, ...(reasonCode !== undefined ? { reasonCode } : {}) });
      } catch {
        return false;
      }
    };

    // 4. Execution — only ever reached after 1, 2, and 3 all succeed.
    let handlerResult: Result<unknown, RuntimeError>;
    try {
      handlerResult = await declaration.handler(request.input);
    } catch (cause) {
      await finish(false, ErrorCode.RUNTIME_CAPABILITY_HANDLER_UNAVAILABLE);
      return err(
        new RuntimeError(
          ErrorCode.RUNTIME_CAPABILITY_HANDLER_UNAVAILABLE,
          `Runtime capability "${request.capabilityId}"'s handler threw: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        ),
      );
    }
    if (!handlerResult.ok) {
      await finish(false, handlerResult.error.code);
      return err(handlerResult.error);
    }
    const recorded = await finish(true);

    return ok({
      ...(recorded ? {} : { auditFinalization: 'failed' as const }),
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
