import { err, ok } from '@xo/types';
import { PackageId } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
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
export class RuntimeCapabilityExecutor {
    registry;
    permissionManager;
    constructor(options) {
        this.registry = options.registry;
        this.permissionManager = options.permissionManager;
    }
    async execute(request) {
        // 1. Resolution — fails closed on an unknown capability id.
        const resolved = this.registry.resolve(request.capabilityId);
        if (!resolved.ok)
            return err(resolved.error);
        const declaration = resolved.value;
        // 2. Permission gate — every requirement registered for this
        // capability id must independently resolve to `allow`.
        const requirements = this.registry.permissions.resolve(request.capabilityId);
        const requesterPackageId = PackageId(request.requesterPackageId ?? NATIVE_CAPABILITY_REQUESTER);
        for (const requirement of requirements) {
            const decision = await this.permissionManager.check({
                permission: requirement.permission,
                ...(requirement.scope !== undefined ? { scope: requirement.scope } : {}),
                requester: { packageId: requesterPackageId, capabilityId: request.capabilityId },
                ...(request.context !== undefined ? { context: request.context } : {}),
            });
            if (decision.effect !== 'allow') {
                if (requirement.optional)
                    continue;
                return err(new RuntimeError(ErrorCode.RUNTIME_PERMISSION_DENIED, `Permission "${requirement.permission}" required by Runtime capability "${request.capabilityId}" was not granted: ${decision.reason}`));
            }
        }
        // 3. Execution — only ever reached after 1 and 2 both succeed.
        let handlerResult;
        try {
            handlerResult = await declaration.handler(request.input);
        }
        catch (cause) {
            return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_HANDLER_UNAVAILABLE, `Runtime capability "${request.capabilityId}"'s handler threw: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }));
        }
        if (!handlerResult.ok)
            return err(handlerResult.error);
        return ok({ capabilityId: request.capabilityId, output: handlerResult.value });
    }
}
//# sourceMappingURL=runtime-capability-executor.js.map