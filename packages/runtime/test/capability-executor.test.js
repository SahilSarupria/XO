import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityExecutor } from '../src/ai/capability-executor.js';
import { ScriptedModelProvider } from './fixtures.js';
function request(overrides = {}) {
    return { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 100, ...overrides };
}
test('execute() passes through a successful ProviderResponse unchanged', async () => {
    const provider = new ScriptedModelProvider();
    provider.setResponse({ text: 'the answer', usage: { inputTokens: 3, outputTokens: 7 }, modelUsed: 'test-model', finishReason: 'stop' });
    const executor = new CapabilityExecutor(provider);
    const result = await executor.execute(request());
    assert.ok(result.ok);
    if (result.ok)
        assert.equal(result.value.text, 'the answer');
});
test('execute() translates a provider throw into a RuntimeError', async () => {
    const provider = new ScriptedModelProvider();
    provider.failNextWith = new Error('provider is down');
    const executor = new CapabilityExecutor(provider);
    const result = await executor.execute(request());
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(result.error.code, 'XO_RUNTIME_EXECUTION_FAILED');
        assert.ok(result.error.message.includes('provider is down'));
    }
});
test('execute() forwards the exact request to the provider', async () => {
    const provider = new ScriptedModelProvider();
    const executor = new CapabilityExecutor(provider);
    const req = request({ maxOutputTokens: 55 });
    await executor.execute(req);
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0]?.maxOutputTokens, 55);
});
test('stream() forwards directly to a provider that implements completeStream', async () => {
    const provider = new ScriptedModelProvider();
    provider.streamEventsToYield = [
        { type: 'text_delta', delta: 'hello' },
        { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
    ];
    const executor = new CapabilityExecutor(provider);
    const events = [];
    for await (const event of executor.stream(request()))
        events.push(event);
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], { type: 'text_delta', delta: 'hello' });
});
test('stream() falls back to a single complete() call, emitted as one text_delta + done, for a provider without completeStream', async () => {
    const provider = {
        id: 'test-non-streaming',
        describeCapabilities: () => ({ providerId: 'test-non-streaming', models: ['test-model'], supportsStreaming: false, supportsStructuredOutput: false, supportsVision: false, maxContextTokens: 1000 }),
        complete: async () => ({ text: 'fallback text', usage: { inputTokens: 2, outputTokens: 2 }, modelUsed: 'test-model', finishReason: 'stop' }),
        // completeStream intentionally omitted — it's optional on ModelProvider
    };
    const executor = new CapabilityExecutor(provider);
    const events = [];
    for await (const event of executor.stream(request()))
        events.push(event);
    assert.deepEqual(events, [
        { type: 'text_delta', delta: 'fallback text' },
        { type: 'done', usage: { inputTokens: 2, outputTokens: 2 }, finishReason: 'stop' },
    ]);
});
//# sourceMappingURL=capability-executor.test.js.map