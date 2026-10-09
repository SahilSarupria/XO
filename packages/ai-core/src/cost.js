export const DEFAULT_PRICING_TABLE = {
    anthropic: {
        'claude-sonnet-4-6': { inputPerThousand: 0.003, outputPerThousand: 0.015 },
        'claude-haiku-4-5-20251001': { inputPerThousand: 0.0008, outputPerThousand: 0.004 },
    },
    openai: {
        'gpt-4o': { inputPerThousand: 0.0025, outputPerThousand: 0.01 },
        'gpt-4o-mini': { inputPerThousand: 0.00015, outputPerThousand: 0.0006 },
    },
    gemini: {
        'gemini-1.5-pro': { inputPerThousand: 0.00125, outputPerThousand: 0.005 },
    },
    'azure-openai': {
        'gpt-4o': { inputPerThousand: 0.0025, outputPerThousand: 0.01 },
    },
    ollama: {},
    'deterministic-replay': {},
};
function lookupPricing(table, providerId, model) {
    return table[providerId]?.[model] ?? { inputPerThousand: 0, outputPerThousand: 0 };
}
export function computeCostUsd(providerId, model, usage, table = DEFAULT_PRICING_TABLE) {
    const pricing = lookupPricing(table, providerId, model);
    return (usage.inputTokens / 1000) * pricing.inputPerThousand + (usage.outputTokens / 1000) * pricing.outputPerThousand;
}
/** Accumulates cost across every capability call made through one `AiCapabilityLayer` instance — real running totals, queryable at any point (e.g. a CLI could print "$0.0142 spent so far" after a `xo compile` run). */
export class CostAccountant {
    pricingTable;
    records = [];
    constructor(pricingTable = DEFAULT_PRICING_TABLE) {
        this.pricingTable = pricingTable;
    }
    record(providerId, model, usage) {
        const costUsd = computeCostUsd(providerId, model, usage, this.pricingTable);
        const record = { providerId, model, usage, costUsd };
        this.records.push(record);
        return record;
    }
    totalCostUsd() {
        return this.records.reduce((sum, r) => sum + r.costUsd, 0);
    }
    totalsByProvider() {
        const totals = {};
        for (const r of this.records)
            totals[r.providerId] = (totals[r.providerId] ?? 0) + r.costUsd;
        return totals;
    }
    allRecords() {
        return this.records;
    }
}
//# sourceMappingURL=cost.js.map