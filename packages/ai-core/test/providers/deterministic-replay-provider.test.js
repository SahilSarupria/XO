import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeterministicReplayProvider } from '../../src/providers/deterministic-replay-provider.js';
const request = { model: 'replay-1', messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: 100 };
test('returns the recorded response for an exact request match', async () => {
    const provider = new DeterministicReplayProvider();
    provider.record(request, { text: 'canned response', usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: 'replay-1', finishReason: 'stop' });
    const response = await provider.complete(request);
    assert.equal(response.text, 'canned response');
});
test('throws AI_REPLAY_FIXTURE_MISSING for a request with no recorded fixture', async () => {
    const provider = new DeterministicReplayProvider();
    await assert.rejects(() => provider.complete(request), /No replay fixture recorded/);
});
test('distinguishes requests by their exact message content', async () => {
    const provider = new DeterministicReplayProvider();
    provider.record(request, { text: 'A', usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: 'replay-1', finishReason: 'stop' });
    const differentRequest = { ...request, messages: [{ role: 'user', content: 'different' }] };
    await assert.rejects(() => provider.complete(differentRequest));
});
test('completeStream emits a text_delta then a done event derived from the recorded response', async () => {
    const provider = new DeterministicReplayProvider();
    provider.record(request, { text: 'streamed', usage: { inputTokens: 2, outputTokens: 3 }, modelUsed: 'replay-1', finishReason: 'stop' });
    const events = [];
    for await (const event of provider.completeStream(request))
        events.push(event);
    assert.deepEqual(events, [
        { type: 'text_delta', delta: 'streamed' },
        { type: 'done', usage: { inputTokens: 2, outputTokens: 3 }, finishReason: 'stop' },
    ]);
});
test('describeCapabilities reports a sensible default descriptor', () => {
    const provider = new DeterministicReplayProvider();
    const descriptor = provider.describeCapabilities();
    assert.equal(descriptor.providerId, 'deterministic-replay');
    assert.equal(descriptor.supportsStructuredOutput, true);
});
//# sourceMappingURL=deterministic-replay-provider.test.js.map