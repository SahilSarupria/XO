import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCostUsd, CostAccountant } from '../src/cost.js';
const testPricing = {
    anthropic: { 'test-model': { inputPerThousand: 1, outputPerThousand: 2 } },
    openai: {},
    gemini: {},
    'azure-openai': {},
    ollama: {},
    'deterministic-replay': {},
};
test('computeCostUsd multiplies token counts by per-thousand pricing', () => {
    const cost = computeCostUsd('anthropic', 'test-model', { inputTokens: 1000, outputTokens: 500 }, testPricing);
    assert.equal(cost, 1 * 1 + 0.5 * 2);
});
test('computeCostUsd returns 0 for an unknown provider/model', () => {
    const cost = computeCostUsd('openai', 'unknown-model', { inputTokens: 1000, outputTokens: 1000 }, testPricing);
    assert.equal(cost, 0);
});
test('CostAccountant accumulates totals across multiple records', () => {
    const accountant = new CostAccountant(testPricing);
    accountant.record('anthropic', 'test-model', { inputTokens: 1000, outputTokens: 0 });
    accountant.record('anthropic', 'test-model', { inputTokens: 1000, outputTokens: 0 });
    assert.equal(accountant.totalCostUsd(), 2);
});
test('CostAccountant.totalsByProvider breaks down cost per provider', () => {
    const accountant = new CostAccountant(testPricing);
    accountant.record('anthropic', 'test-model', { inputTokens: 1000, outputTokens: 0 });
    const totals = accountant.totalsByProvider();
    assert.equal(totals.anthropic, 1);
});
test('CostAccountant.allRecords exposes every recorded call', () => {
    const accountant = new CostAccountant(testPricing);
    accountant.record('anthropic', 'test-model', { inputTokens: 100, outputTokens: 50 });
    assert.equal(accountant.allRecords().length, 1);
});
//# sourceMappingURL=cost.test.js.map