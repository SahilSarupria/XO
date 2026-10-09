/**
 * A test double for `ModelProvider` whose outcomes are scripted call-by-
 * call (success, failure, success, ...) — used by this package's own
 * tests to exercise retry/circuit-breaker/fallback behavior in
 * `router.test.ts` without any real provider or network call. This is
 * the AI-layer equivalent of `@xo/testing`'s `MockLogger`: a real,
 * working implementation of the port, scoped as a test utility rather
 * than a production default.
 */
export class ScriptableTestProvider {
    id;
    descriptor;
    script;
    cursor = 0;
    callLog = [];
    constructor(id, script, descriptor = {
        providerId: id,
        models: ['test-model'],
        supportsStreaming: false,
        supportsStructuredOutput: true,
        supportsVision: false,
        maxContextTokens: 100_000,
    }) {
        this.id = id;
        this.descriptor = descriptor;
        this.script = [...script];
    }
    describeCapabilities() {
        return this.descriptor;
    }
    async complete(request) {
        this.callLog.push(request);
        const outcome = this.script[this.cursor] ?? this.script[this.script.length - 1];
        this.cursor += 1;
        if (!outcome)
            throw new Error('ScriptableTestProvider: no scripted outcome available');
        if (outcome.kind === 'failure')
            throw outcome.error;
        return outcome.response;
    }
}
export function jsonResponse(value, usage = { inputTokens: 10, outputTokens: 10 }, modelUsed = 'test-model') {
    return { text: JSON.stringify(value), usage, modelUsed, finishReason: 'stop' };
}
//# sourceMappingURL=scriptable-test-provider.js.map