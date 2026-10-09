import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponseAssembler } from '../src/response/response-assembler.js';
import { contractAnalysisCapability } from './fixtures.js';
const capability = { declaration: contractAnalysisCapability, packageName: 'xo_lawyer', packageVersion: '1.0.0' };
test('assemble() maps ProviderResponse fields (renaming input/outputTokens to prompt/completionTokens) and attributes the capability/package', () => {
    const response = new ResponseAssembler().assemble({
        providerResponse: { text: 'result text', usage: { inputTokens: 1, outputTokens: 2 }, modelUsed: 'test-model', finishReason: 'stop' },
        capability,
        degraded: false,
    });
    assert.equal(response.content, 'result text');
    assert.equal(response.stopReason, 'end_turn');
    assert.deepEqual(response.usage, { promptTokens: 1, completionTokens: 2 });
    assert.equal(response.capabilityId, 'contract_analysis');
    assert.equal(response.packageName, 'xo_lawyer');
    assert.equal(response.packageVersion, '1.0.0');
    assert.equal(response.degraded, false);
});
test('assemble() maps every ProviderResponse finishReason to the runtime\'s own StopReason vocabulary', () => {
    const assembler = new ResponseAssembler();
    const base = { text: '', usage: { inputTokens: 0, outputTokens: 0 }, modelUsed: 'test-model' };
    assert.equal(assembler.assemble({ providerResponse: { ...base, finishReason: 'stop' }, capability, degraded: false }).stopReason, 'end_turn');
    assert.equal(assembler.assemble({ providerResponse: { ...base, finishReason: 'length' }, capability, degraded: false }).stopReason, 'max_tokens');
    assert.equal(assembler.assemble({ providerResponse: { ...base, finishReason: 'content_filter' }, capability, degraded: false }).stopReason, 'content_filtered');
    assert.equal(assembler.assemble({ providerResponse: { ...base, finishReason: 'error' }, capability, degraded: false }).stopReason, 'error');
});
test('assemble() carries the degraded flag through', () => {
    const response = new ResponseAssembler().assemble({
        providerResponse: { text: '', usage: { inputTokens: 0, outputTokens: 0 }, modelUsed: 'test-model', finishReason: 'stop' },
        capability,
        degraded: true,
    });
    assert.equal(response.degraded, true);
});
test('a StructuredResponse is frozen (immutable)', () => {
    const response = new ResponseAssembler().assemble({
        providerResponse: { text: '', usage: { inputTokens: 0, outputTokens: 0 }, modelUsed: 'test-model', finishReason: 'stop' },
        capability,
        degraded: false,
    });
    assert.ok(Object.isFrozen(response));
});
//# sourceMappingURL=response-assembler.test.js.map