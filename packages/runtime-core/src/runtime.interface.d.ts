import type { CompatibilityLevel, ModelFamily, XoManifest } from '@xo/types';
/**
 * The pipeline stages from RUNTIME_ARCHITECTURE.md §1: mount a package,
 * negotiate what the host can consume, retrieve the right slice per
 * request, merge with everything else installed, fit a token budget,
 * check safety, assemble context, then emit a load receipt. Every stage
 * below is interface-only — no runtime implementation lives here.
 */
export interface MountedPackage {
    readonly manifest: XoManifest;
    readonly resolvedLevel: CompatibilityLevel;
}
export interface Mounter {
    mount(packageId: string, hostFamily: ModelFamily): Promise<MountedPackage>;
    unmount(packageId: string): Promise<void>;
}
export interface RetrievalRequest {
    readonly query: string;
    readonly packageId: string;
    readonly tokenBudget: number;
}
export interface RetrievedSlice {
    readonly componentKind: string;
    readonly content: string;
    readonly estimatedTokens: number;
}
export interface Retriever {
    retrieve(request: RetrievalRequest): Promise<readonly RetrievedSlice[]>;
}
export interface Merger {
    /** Merges slices from potentially many mounted packages into one ordered list, resolving conflicts (e.g. two packages both offering `safety_rules`). */
    merge(slices: readonly RetrievedSlice[][]): readonly RetrievedSlice[];
}
export interface Budgeter {
    /** Trims `slices` to fit within `tokenBudget`, preserving priority order. */
    fit(slices: readonly RetrievedSlice[], tokenBudget: number): readonly RetrievedSlice[];
}
export type SafetyVerdict = 'allow' | 'block' | 'redact';
export interface SafetyCheckResult {
    readonly verdict: SafetyVerdict;
    readonly reason?: string;
}
export interface SafetyChecker {
    check(slices: readonly RetrievedSlice[]): SafetyCheckResult;
}
export interface AssembledContext {
    readonly systemPromptFragments: readonly string[];
    readonly toolSchemas: readonly unknown[];
    readonly slices: readonly RetrievedSlice[];
}
export interface ContextAssembler {
    assemble(slices: readonly RetrievedSlice[]): AssembledContext;
}
export interface LoadReceipt {
    readonly packageId: string;
    readonly componentsUsed: readonly string[];
    readonly timestamp: string;
    readonly signature?: string;
}
/** The composed runtime facade a host session talks to (RUNTIME_ARCHITECTURE.md §1.1's "capability layer"). */
export interface Runtime {
    readonly mounter: Mounter;
    readonly retriever: Retriever;
    readonly merger: Merger;
    readonly budgeter: Budgeter;
    readonly safetyChecker: SafetyChecker;
    readonly contextAssembler: ContextAssembler;
    emitLoadReceipt(packageId: string, componentsUsed: readonly string[]): Promise<LoadReceipt>;
}
//# sourceMappingURL=runtime.interface.d.ts.map