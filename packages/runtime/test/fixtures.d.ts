import type { CapabilityDeclaration, CompatibilityDeclaration, ManifestPermissionDeclaration, XoMetadata } from '@xo/types';
import { LocalFsBlobStore } from '@xo/storage';
import { PackageInstaller, type Clock, type PackageBundle } from '@xo/package-sdk';
export declare const contractCompatibility: CompatibilityDeclaration;
export declare const strictCompatibility: CompatibilityDeclaration;
export declare const sampleMetadata: XoMetadata;
export declare const contractAnalysisCapability: CapabilityDeclaration;
export declare const clauseLookupCapability: CapabilityDeclaration;
export declare const fraudDetectionCapability: CapabilityDeclaration;
export declare class FixedClock implements Clock {
    private current;
    constructor(current?: Date);
    now(): Date;
    advance(ms: number): void;
}
export interface BuildBundleOptions {
    readonly name?: string;
    readonly version?: string;
    readonly compatibility?: CompatibilityDeclaration;
    readonly capabilities?: readonly CapabilityDeclaration[];
    readonly knowledgeGraph?: Readonly<Record<string, unknown>>;
    readonly safetyRules?: Readonly<Record<string, unknown>>;
    readonly permissions?: readonly ManifestPermissionDeclaration[];
}
export declare const sampleSafetyRules: {
    rules: {
        pattern: string;
        action: string;
        reason: string;
    }[];
};
export declare function buildContractLawyerBundle(options?: BuildBundleOptions): PackageBundle;
export declare function buildFraudDetectorBundle(options?: BuildBundleOptions): PackageBundle;
export declare function withTempInstaller<T>(fn: (installer: PackageInstaller, store: LocalFsBlobStore) => Promise<T>, clock?: Clock): Promise<T>;
import { PackageRegistry, type MountedPackage } from '../src/registry/mounted-package.js';
import type { ModelProvider, ProviderCapabilityDescriptor, ProviderId, ProviderRequest, ProviderResponse, ProviderStreamEvent } from '@xo/ai-core';
/** Mounts `bundle` (already installed on `installer`) into a fresh `PackageRegistry`, for tests that don't need the full `PackageLoader` verification path exercised. */
export declare function mountBundle(installer: PackageInstaller, bundle: PackageBundle, registry?: PackageRegistry): Promise<PackageRegistry>;
export declare function fakeMountedPackage(bundle: PackageBundle): MountedPackage;
/**
 * A scriptable `ModelProvider` test double for `@xo/runtime`'s own
 * tests — distinct from `@xo/ai-core`'s own `ScriptableTestProvider`
 * (`providers/scriptable-test-provider.ts`), which doesn't implement
 * `completeStream` at all (its own doc comment: it exists to exercise
 * `router.ts`'s retry/circuit-breaker/fallback behavior, which doesn't
 * need streaming). This one supports streaming, since `@xo/runtime`'s
 * own tests need to exercise `executeStreaming`.
 */
export declare class ScriptedModelProvider implements ModelProvider {
    readonly id: ProviderId;
    private response;
    private readonly descriptor;
    readonly requests: ProviderRequest[];
    failNextWith: Error | undefined;
    streamEventsToYield: readonly ProviderStreamEvent[] | undefined;
    /** When set, `complete()` waits this long before resolving — for tests that need to race cancellation against an in-flight call. */
    delayMs: number;
    constructor(id?: ProviderId, response?: ProviderResponse, descriptor?: ProviderCapabilityDescriptor);
    describeCapabilities(): ProviderCapabilityDescriptor;
    setResponse(response: ProviderResponse): void;
    complete(request: ProviderRequest): Promise<ProviderResponse>;
    completeStream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
}
//# sourceMappingURL=fixtures.d.ts.map