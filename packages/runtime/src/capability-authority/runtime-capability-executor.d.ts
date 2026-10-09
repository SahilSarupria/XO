import { type Result } from '@xo/types';
import { PackageId } from '@xo/types';
import { RuntimeError } from '@xo/errors';
import type { PermissionContext, PermissionManager } from '@xo/permissions';
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
export declare const NATIVE_CAPABILITY_REQUESTER: PackageId;
export interface RuntimeCapabilityExecutorOptions {
    readonly registry: RuntimeCapabilityRegistry;
    readonly permissionManager: PermissionManager;
}
export interface RuntimeCapabilityExecutionRequest {
    readonly capabilityId: string;
    readonly input: unknown;
    /** Overrides `NATIVE_CAPABILITY_REQUESTER` for this call's permission-check audit attribution. Does not change *which* capability or permission requirements are checked — only who the check is recorded as being on behalf of. */
    readonly requesterPackageId?: string;
    readonly context?: PermissionContext;
}
export interface RuntimeCapabilityExecutionResult {
    readonly capabilityId: string;
    readonly output: unknown;
}
/**
 * Runtime capability authority's execution boundary. Every call goes
 * through, in order: (1) resolve the declaration from
 * `RuntimeCapabilityRegistry` — fails closed on an unknown id; (2) check
 * every permission requirement registered for that id via
 * `registry.permissions` (the *same* `CapabilityPermissionRegistry`
 * `PermissionManagerGate` reads for the manifest-declared path — see
 * that file), using the *same* `PermissionManager.check` the rest of the
 * runtime already uses — this class creates no new permission machinery
 * of its own; (3) only once every requirement resolves `allow`, invoke
 * `declaration.handler(input)`.
 *
 * There is no path through this class that reaches a `handler` without
 * both 1 and 2 succeeding — a capability with zero registered
 * requirements still passes through the check (trivially: an empty
 * requirement list has nothing to deny), it never skips the gate itself.
 *
 * Mirrors `permission-manager-gate.ts`'s own denial semantics: a
 * `prompt` decision from `PermissionManager.check` is treated as a
 * denial here too (this class never calls `PermissionManager.request`,
 * so it never triggers interactive consent on the caller's behalf) —
 * same reasoning as that file's doc comment: there is no way to pause
 * mid-execution for a user prompt from inside a synchronous-from-the-
 * caller's-perspective capability call.
 */
export declare class RuntimeCapabilityExecutor {
    private readonly registry;
    private readonly permissionManager;
    constructor(options: RuntimeCapabilityExecutorOptions);
    execute(request: RuntimeCapabilityExecutionRequest): Promise<Result<RuntimeCapabilityExecutionResult, RuntimeError>>;
}
//# sourceMappingURL=runtime-capability-executor.d.ts.map