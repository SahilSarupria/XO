import { CapabilityRegistry } from './capability/capability-registry.js';
export function buildRuntimeContext(registry, now = () => new Date()) {
    return Object.freeze({
        registry,
        capabilities: CapabilityRegistry.fromPackages(registry.all()),
        builtAt: now().toISOString(),
    });
}
//# sourceMappingURL=runtime-context.js.map