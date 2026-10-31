import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EvalAbortedError, isTransportError, runEval, type Arm } from '../src/index.js';
import { generateEvalTasks } from '../src/index.js';

const deadArm: Arm = {
  id: 'plain',
  run: async () => ({
    output: null,
    rawText: '',
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: [],
    path: 'model',
    overridden: false,
    latencyMs: 1,
    error: 'Gemini API returned 404: model retired',
  }),
} as unknown as Arm;

describe('dead endpoints are not scored as wrong answers', () => {
  it('aborts after a streak of transport failures', async () => {
    const tasks = generateEvalTasks().slice(0, 30);
    await assert.rejects(runEval({ arms: [deadArm], tasks, concurrency: 2, abortAfterConsecutiveTransportErrors: 5 }), EvalAbortedError);
  });
  it('does not treat an unparseable reply as transport failure', () => {
    assert.equal(
      isTransportError({ run: { error: 'no JSON object in reply', path: 'model', inputTokens: 10, outputTokens: 3 } } as never),
      false,
    );
  });
});
