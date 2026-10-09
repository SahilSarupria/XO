import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveExecutionId } from '../src/engine/execution-id.js';
import { composeMiddleware, type ExecutionMiddleware } from '../src/hooks/execution-middleware.js';
import { RequestId, EnvironmentId } from '../src/ids.js';
import type { ExecutionRequest } from '../src/execution/execution-request.js';
import type { ExecutionResult } from '../src/execution/execution-result.js';
import { SessionId } from '../src/ids.js';

test('deriveExecutionId is a pure, deterministic function of RequestId', () => {
  const requestId = RequestId('req_abc');
  assert.equal(deriveExecutionId(requestId), deriveExecutionId(requestId));
});

test('deriveExecutionId produces different ids for different requests', () => {
  assert.notEqual(deriveExecutionId(RequestId('req_1')), deriveExecutionId(RequestId('req_2')));
});

function fakeRequest(): ExecutionRequest {
  return {
    requestId: RequestId('req_1'),
    environment: { environmentId: EnvironmentId('env_1'), hostProfile: { family: 'claude', capabilities: [] }, createdAt: 't' },
    requestedAt: 't',
  };
}

function fakeResult(request: ExecutionRequest): ExecutionResult {
  return {
    executionId: deriveExecutionId(request.requestId),
    session: {
      sessionId: SessionId('s1'),
      requestId: request.requestId,
      mountedPackages: [],
      chosenCapabilities: [],
      status: 'completed',
      receipts: [],
      createdAt: 't',
      updatedAt: 't',
    },
  };
}

test('composeMiddleware with no middleware calls core directly', async () => {
  const core = async (request: ExecutionRequest) => fakeResult(request);
  const composed = composeMiddleware([], core);
  const result = await composed(fakeRequest());
  assert.equal(result.session.sessionId, 's1');
});

test('composeMiddleware runs middleware outermost-first, in the given order', async () => {
  const order: string[] = [];
  const mwA: ExecutionMiddleware = async (request, next) => {
    order.push('A before');
    const result = await next(request);
    order.push('A after');
    return result;
  };
  const mwB: ExecutionMiddleware = async (request, next) => {
    order.push('B before');
    const result = await next(request);
    order.push('B after');
    return result;
  };
  const core = async (request: ExecutionRequest) => {
    order.push('core');
    return fakeResult(request);
  };
  await composeMiddleware([mwA, mwB], core)(fakeRequest());
  assert.deepEqual(order, ['A before', 'B before', 'core', 'B after', 'A after']);
});

test('a middleware can short-circuit by never calling next', async () => {
  let coreCalled = false;
  const shortCircuit: ExecutionMiddleware = async (request) => fakeResult(request);
  const core = async (request: ExecutionRequest) => {
    coreCalled = true;
    return fakeResult(request);
  };
  await composeMiddleware([shortCircuit], core)(fakeRequest());
  assert.equal(coreCalled, false);
});

test('a middleware can modify the request before calling next', async () => {
  let receivedRequestId: string | undefined;
  const rewriter: ExecutionMiddleware = async (request, next) => next({ ...request, requestId: RequestId('rewritten') });
  const core = async (request: ExecutionRequest) => {
    receivedRequestId = request.requestId;
    return fakeResult(request);
  };
  await composeMiddleware([rewriter], core)(fakeRequest());
  assert.equal(receivedRequestId, 'rewritten');
});
