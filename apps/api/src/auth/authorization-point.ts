import { join } from 'node:path';
import { DenyOverridesPolicy, PermissionManager, type PermissionPolicy } from '@xo/permissions';
import { createAuthorizationPolicy } from '../workspace/authorizer.js';
import { InstancePolicy } from './instance-policy.js';

/**
 * UW-1 (ADR 0010) — the instance's single authorization point. One `PermissionManager` decides for every path that runs work: HTTP
 * routes (attached to each request), chat and AI execution (they run through those routes' runner contexts) and scheduled runs (the
 * scheduler receives the same object from the composition root). Workspace roles are a ceiling the operator policy can only narrow;
 * every other domain is decided by the operator policy.
 *
 * The operator policy is the persisted instance policy (`<WORKSPACE_DATA_DIR>/_instance/policy.json`, managed by
 * scripts/manage-policy.ts) combined with any code-supplied policy so that either side's DENY wins. A broken file suspends operator
 * ALLOWs (fail closed) and is reported through `onError`.
 */
export interface AuthorizationPoint {
  readonly permissionManager: PermissionManager;
  readonly instancePolicy: InstancePolicy;
  /** Stops the periodic reload of the instance policy file. */
  stop(): void;
}

export interface AuthorizationPointOptions {
  readonly dataRootDir: string;
  /** Default `<dataRootDir>/_instance/policy.json`. */
  readonly instancePolicyPath?: string;
  /** Code-supplied operator policy, combined deny-overrides with the instance policy. */
  readonly permissionPolicy?: PermissionPolicy;
  /** How often the policy file is re-read, in ms (0 disables; default 10000). */
  readonly reloadMs?: number;
  readonly onError?: (message: string) => void;
}

export function createAuthorizationPoint(options: AuthorizationPointOptions): AuthorizationPoint {
  const instancePolicy = new InstancePolicy(options.instancePolicyPath ?? join(options.dataRootDir, '_instance', 'policy.json'));
  const report = (): void => {
    if (instancePolicy.lastError !== undefined) options.onError?.(`instance policy suspended: ${instancePolicy.lastError}`);
  };
  report();
  const reloadMs = options.reloadMs ?? 10_000;
  const timer =
    reloadMs > 0
      ? setInterval(() => {
          void instancePolicy.reload().then(report, () => undefined);
        }, reloadMs)
      : undefined;
  timer?.unref();
  const operatorPolicy =
    options.permissionPolicy !== undefined ? new DenyOverridesPolicy([options.permissionPolicy, instancePolicy]) : instancePolicy;
  return {
    permissionManager: new PermissionManager({ policy: createAuthorizationPolicy(operatorPolicy) }),
    instancePolicy,
    stop: () => {
      if (timer !== undefined) clearInterval(timer);
    },
  };
}
