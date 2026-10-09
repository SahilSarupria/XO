import { CapabilityRegistry } from './capability/capability-registry.js';
import { PackageRegistry } from './registry/mounted-package.js';
/**
 * The runtime's whole current state, as a single immutable snapshot:
 * which packages are mounted, and the capability index derived from
 * them. `CapabilityNegotiator.plan` takes a `RuntimeContext` rather than
 * a bare `PackageRegistry` so it never needs to re-derive
 * `CapabilityRegistry` per call.
 */
export interface RuntimeContext {
    readonly registry: PackageRegistry;
    readonly capabilities: CapabilityRegistry;
    readonly builtAt: string;
}
export declare function buildRuntimeContext(registry: PackageRegistry, now?: () => Date): RuntimeContext;
//# sourceMappingURL=runtime-context.d.ts.map