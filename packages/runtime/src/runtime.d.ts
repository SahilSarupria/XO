import type { Result } from '@xo/types';
import type { PackageInstaller } from '@xo/package-sdk';
import type { RuntimeError } from '@xo/errors';
import { type RuntimeContext } from './runtime-context.js';
import { type MountAllResult, type PackageLoaderOptions } from './loader/package-loader.js';
import { type CapabilityNegotiatorOptions } from './capability/capability-negotiator.js';
import type { ExecutionRequest } from './execution/execution-request.js';
import type { ExecutionPlan } from './execution/execution-plan.js';
export interface RuntimeOptions {
    readonly loader?: PackageLoaderOptions;
    readonly negotiator?: CapabilityNegotiatorOptions;
    readonly now?: () => Date;
}
/**
 * The stateful "process table" the OS-loading-applications analogy in
 * SPECIFICATION.md's Runtime Stage 1 goal describes. Every underlying
 * object — `PackageRegistry`, `RuntimeContext`, `ExecutionPlan` — is an
 * immutable value; `Runtime` is the mutable shell that holds "the
 * current one" and atomically swaps it for a new one on every
 * mount/unmount/reload, the same functional-core/imperative-shell split
 * `PackageInstaller` uses for on-disk install state one layer down.
 *
 * Not a required entry point — everything here is reachable directly
 * through `PackageLoader`/`CapabilityNegotiator` for callers (e.g. tests)
 * that want to thread `PackageRegistry` through themselves. `Runtime`
 * exists purely for convenience.
 */
export declare class Runtime {
    private readonly loader;
    private readonly negotiator;
    private readonly now;
    private registry;
    constructor(installer: PackageInstaller, options?: RuntimeOptions);
    /** The current, immutable snapshot of every mounted package plus its derived capability index. */
    context(): RuntimeContext;
    mount(name: string, version: string): Promise<Result<RuntimeContext, RuntimeError>>;
    unmount(name: string, version: string): Result<RuntimeContext, RuntimeError>;
    reload(name: string, version: string): Promise<Result<RuntimeContext, RuntimeError>>;
    /** Discovers and mounts every installed package version in one pass — booting the runtime. Returns any per-package mount failures rather than throwing. */
    bootstrap(): Promise<MountAllResult>;
    /** Plans (never executes) `request` against the runtime's current state. */
    plan(request: ExecutionRequest): ExecutionPlan;
}
//# sourceMappingURL=runtime.d.ts.map