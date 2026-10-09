import type { ProviderId, TokenUsage } from './provider-types.js';
/** USD per 1,000 tokens. These are illustrative, hand-entered figures for the pattern to work end-to-end — NOT guaranteed current vendor pricing. A real deployment should source this table from each vendor's live pricing page/API rather than trust these numbers for actual billing; see this package's README. */
export interface ModelPricing {
    readonly inputPerThousand: number;
    readonly outputPerThousand: number;
}
export type PricingTable = Readonly<Record<ProviderId, Readonly<Record<string, ModelPricing>>>>;
export declare const DEFAULT_PRICING_TABLE: PricingTable;
export declare function computeCostUsd(providerId: ProviderId, model: string, usage: TokenUsage, table?: PricingTable): number;
export interface CostRecord {
    readonly providerId: ProviderId;
    readonly model: string;
    readonly usage: TokenUsage;
    readonly costUsd: number;
}
/** Accumulates cost across every capability call made through one `AiCapabilityLayer` instance — real running totals, queryable at any point (e.g. a CLI could print "$0.0142 spent so far" after a `xo compile` run). */
export declare class CostAccountant {
    private readonly pricingTable;
    private readonly records;
    constructor(pricingTable?: PricingTable);
    record(providerId: ProviderId, model: string, usage: TokenUsage): CostRecord;
    totalCostUsd(): number;
    totalsByProvider(): Readonly<Record<string, number>>;
    allRecords(): readonly CostRecord[];
}
//# sourceMappingURL=cost.d.ts.map