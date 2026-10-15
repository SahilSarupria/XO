import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '@xo/errors';
import { safeReasonCode } from '../src/audit/audit-service.js';
import { classifyResolution } from '../src/routes/human-task-routes.js';
import type { ExecutionRecord, HumanTaskResumeOutcome } from '../src/executions/execution.js';

// P1.0 F-1 (Option A) — unit evidence for the audit reason-code derivation. These cover branches that the HTTP tests cannot
// reach (notably the `unsupported` resume, which no shipped binding produces through the API today).

function record(over: Partial<ExecutionRecord> & { resume?: HumanTaskResumeOutcome }): ExecutionRecord {
  const { resume, ...rest } = over;
  return {
    executionId: 'exec-1',
    workspaceId: 'ws-1',
    identityId: 'id-1',
    compilationId: 'c-1',
    capabilityId: 'cap-1',
    input: {},
    status: 'waiting_for_human',
    humanTask: { status: 'resolved', decision: 'approve', ...(resume !== undefined ? { resumeOutcome: resume } : {}) },
    ...rest,
  } as unknown as ExecutionRecord;
}

test('safeReasonCode passes a well-formed code through and degrades anything else to XO_UNKNOWN (never throws, never echoes free text)', () => {
  assert.equal(safeReasonCode(ErrorCode.RUNTIME_PERMISSION_DENIED), 'XO_RUNTIME_PERMISSION_DENIED');
  assert.equal(safeReasonCode(ErrorCode.HITL_RESUME_UNSUPPORTED), ErrorCode.HITL_RESUME_UNSUPPORTED);
  for (const bad of [undefined, null, 42, '', '1STARTS_WITH_DIGIT', 'has space', 'free text message: boom', 'x'.repeat(97), {}]) {
    assert.equal(safeReasonCode(bad), ErrorCode.UNKNOWN, String(bad));
  }
  assert.equal(safeReasonCode('x'.repeat(96)), 'x'.repeat(96));
});

test('classifyResolution: failed execution -> failed + stored code; message is never consulted', () => {
  const c = classifyResolution(
    record({
      status: 'failed',
      errorCode: ErrorCode.RUNTIME_PERMISSION_DENIED,
      errorMessage: 'secret free text',
      resume: { kind: 'failed', errorCode: ErrorCode.RUNTIME_PERMISSION_DENIED, errorMessage: 'secret free text' },
    }),
  );
  assert.deepEqual(c, { outcome: 'failed', reasonCode: 'XO_RUNTIME_PERMISSION_DENIED' });
  assert.deepEqual(classifyResolution(record({ status: 'failed', errorCode: 'not a code!' })), {
    outcome: 'failed',
    reasonCode: ErrorCode.UNKNOWN,
  });
  assert.deepEqual(classifyResolution(record({ status: 'failed' })), { outcome: 'failed', reasonCode: ErrorCode.UNKNOWN });
});

test('classifyResolution: unsupported resume (task consumed, execution still waiting_for_human) is NOT a completion', () => {
  const c = classifyResolution(
    record({
      status: 'waiting_for_human',
      resume: { kind: 'unsupported', errorCode: ErrorCode.HITL_RESUME_UNSUPPORTED, errorMessage: 'no resume path' },
    }),
  );
  assert.deepEqual(c, { outcome: 'failed', reasonCode: ErrorCode.HITL_RESUME_UNSUPPORTED });
});

test('classifyResolution: succeeded and rejected resolutions are completed with no reasonCode', () => {
  assert.deepEqual(classifyResolution(record({ status: 'succeeded', resume: { kind: 'succeeded', output: {} } })), {
    outcome: 'completed',
  });
  assert.deepEqual(classifyResolution(record({ status: 'rejected', resume: { kind: 'rejected', output: {} } })), { outcome: 'completed' });
});
