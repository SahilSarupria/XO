import type { ProviderId, TokenUsage } from './provider-types.js';

/** USD per 1,000 tokens. These are illustrative, hand-entered figures for the pattern to work end-to-end — NOT guaranteed current vendor pricing. A real deployment should source this table from each vendor's live pricing page/API rather than trust these numbers for actual billing; see this package's README. */
export interface ModelPricing {
  readonly inputPerThousand: number;
  readonly outputPerThousand: number;
}

export type PricingTable = Readonly<Record<ProviderId, Readonly<Record<string, ModelPricing>>>>;

export const DEFAULT_PRICING_TABLE: PricingTable = {
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

function lookupPricing(table: PricingTable, providerId: ProviderId, model: string): ModelPricing {
  return table[providerId]?.[model] ?? { inputPerThousand: 0, outputPerThousand: 0 };
}

export function computeCostUsd(providerId: ProviderId, model: string, usage: TokenUsage, table: PricingTable = DEFAULT_PRICING_TABLE): number {
  const pricing = lookupPricing(table, providerId, model);
  return (usage.inputTokens / 1000) * pricing.inputPerThousand + (usage.outputTokens / 1000) * pricing.outputPerThousand;
}

export interface CostRecord {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly costUsd: number;
}

/** Accumulates cost across every capability call made through one `AiCapabilityLayer` instance — real running totals, queryable at any point (e.g. a CLI could print "$0.0142 spent so far" after a `xo compile` run). */
export class CostAccountant {
  private readonly records: CostRecord[] = [];

  constructor(private readonly pricingTable: PricingTable = DEFAULT_PRICING_TABLE) {}

  record(providerId: ProviderId, model: string, usage: TokenUsage): CostRecord {
    const costUsd = computeCostUsd(providerId, model, usage, this.pricingTable);
    const record: CostRecord = { providerId, model, usage, costUsd };
    this.records.push(record);
    return record;
  }

  totalCostUsd(): number {
    return this.records.reduce((sum, r) => sum + r.costUsd, 0);
  }

  totalsByProvider(): Readonly<Record<string, number>> {
    const totals: Record<string, number> = {};
    for (const r of this.records) totals[r.providerId] = (totals[r.providerId] ?? 0) + r.costUsd;
    return totals;
  }

  allRecords(): readonly CostRecord[] {
    return this.records;
  }
}
