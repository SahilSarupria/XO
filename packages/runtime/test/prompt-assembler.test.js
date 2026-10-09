import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PromptAssembler } from '../src/prompt/prompt-assembler.js';
function context(overrides = {}) {
    return { systemPrompt: 'You are a helpful assistant.', slices: [], ...overrides };
}
test('assemble() builds a system message followed by a single user message when there are no prior turns', () => {
    const request = new PromptAssembler().assemble({ context: context(), model: 'claude-test', input: 'Review this contract' });
    assert.equal(request.messages.length, 2);
    assert.deepEqual(request.messages[0], { role: 'system', content: 'You are a helpful assistant.' });
    assert.deepEqual(request.messages[1], { role: 'user', content: 'Review this contract' });
    assert.equal(request.model, 'claude-test');
});
test('assemble() places prior working-memory turns between the system message and the current input', () => {
    const request = new PromptAssembler().assemble({
        context: context(),
        model: 'claude-test',
        input: 'And this one too',
        priorTurns: [
            { role: 'user', content: 'first question', recordedAt: '2026-01-01T00:00:00.000Z' },
            { role: 'assistant', content: 'first answer', recordedAt: '2026-01-01T00:00:01.000Z' },
        ],
    });
    assert.equal(request.messages.length, 4);
    assert.equal(request.messages[0]?.role, 'system');
    assert.equal(request.messages[1]?.content, 'first question');
    assert.equal(request.messages[2]?.content, 'first answer');
    assert.equal(request.messages[3]?.content, 'And this one too');
});
test('assemble() defaults maxOutputTokens when none is given, and respects an explicit one', () => {
    const withDefault = new PromptAssembler().assemble({ context: context(), model: 'claude-test', input: 'hi' });
    assert.ok(withDefault.maxOutputTokens > 0);
    const withExplicit = new PromptAssembler().assemble({ context: context(), model: 'claude-test', input: 'hi', maxOutputTokens: 42 });
    assert.equal(withExplicit.maxOutputTokens, 42);
});
test('assemble() has no tools/function-calling field — the real @xo/ai-core ModelProvider layer has no such concept', () => {
    const request = new PromptAssembler().assemble({ context: context(), model: 'claude-test', input: 'hi' });
    assert.equal('tools' in request, false);
});
//# sourceMappingURL=prompt-assembler.test.js.map