import type { CapabilityDeclaration } from '@xo/types';
/**
 * A capability as the runtime sees it: a package's own
 * {@link CapabilityDeclaration} (id, name, description,
 * providerCompatibility, requiredComponents, estimatedCost,
 * estimatedLatencyMs, confidence — all read verbatim from
 * `manifest.capabilities`, per the architectural change requiring
 * capabilities be a first-class part of the package format rather than
 * inferred from `metadata.json`) paired with which mounted package
 * offers it. Kept as a distinct type from `CapabilityDeclaration`
 * itself because a capability id is only unique *within* a manifest —
 * `packageName`/`packageVersion` is what lets the registry and
 * negotiator distinguish two different packages that happen to declare
 * the same capability id (e.g. two competing `contract_analysis`
 * packages), which a bare `CapabilityDeclaration` can't express on its
 * own.
 */
export interface CapabilityDescriptor {
    readonly declaration: CapabilityDeclaration;
    readonly packageName: string;
    readonly packageVersion: string;
}
//# sourceMappingURL=capability-descriptor.d.ts.map