import type { Result } from '@xo/types';
import type { PackageInstaller } from '@xo/package-sdk';
import type { RuntimeError } from '@xo/errors';
import { buildRuntimeContext, type RuntimeContext } from './runtime-context.js';
import { PackageLoader, type MountAllResult, type PackageLoaderOptions } from './loader/package-loader.js';
import { PackageRegistry } from './registry/mounted-package.js';
import { CapabilityNegotiator, type CapabilityNegotiatorOptions } from './capability/capability-negotiator.js';
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
export class Runtime {
  private readonly loader: PackageLoader;
  private readonly negotiator: CapabilityNegotiator;
  private readonly now: () => Date;
  private registry: PackageRegistry;

  constructor(installer: PackageInstaller, options: RuntimeOptions = {}) {
    this.loader = new PackageLoader(installer, options.loader);
    this.negotiator = new CapabilityNegotiator(options.negotiator);
    this.now = options.now ?? (() => new Date());
    this.registry = PackageRegistry.empty();
  }

  /** The current, immutable snapshot of every mounted package plus its derived capability index. */
  context(): RuntimeContext {
    return buildRuntimeContext(this.registry, this.now);
  }

  async mount(name: string, version: string): Promise<Result<RuntimeContext, RuntimeError>> {
    const result = await this.loader.mount(name, version, this.registry);
    if (!result.ok) return result;
    this.registry = result.value;
    return { ok: true, value: this.context() };
  }

  unmount(name: string, version: string): Result<RuntimeContext, RuntimeError> {
    const result = this.loader.unmount(name, version, this.registry);
    if (!result.ok) return result;
    this.registry = result.value;
    return { ok: true, value: this.context() };
  }

  async reload(name: string, version: string): Promise<Result<RuntimeContext, RuntimeError>> {
    const result = await this.loader.reload(name, version, this.registry);
    if (!result.ok) return result;
    this.registry = result.value;
    return { ok: true, value: this.context() };
  }

  /** Discovers and mounts every installed package version in one pass — booting the runtime. Returns any per-package mount failures rather than throwing. */
  async bootstrap(): Promise<MountAllResult> {
    const result = await this.loader.mountAllDiscovered(this.registry);
    this.registry = result.registry;
    return result;
  }

  /** Plans (never executes) `request` against the runtime's current state. */
  plan(request: ExecutionRequest): ExecutionPlan {
    return this.negotiator.plan(request, this.context());
  }
}
