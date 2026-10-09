import type { RuntimeError } from '@xo/errors';
import type { ExecutionId } from '../ids.js';
import type { StructuredResponse } from '../response/response-assembler.js';
import type { ExecutionReceipt } from '../session/execution-receipt.js';
import type { ExecutionSession } from '../session/execution-session.js';
import type { WorkflowResult } from '../workflow/workflow-receipt.js';

/**
 * `ExecutionEngine.execute`'s return value. Exactly one of `response`/
 * `error` is set: a `session.status` of `'completed'` implies `response`
 * and `receipt` are both present; any other terminal status
 * (`'plan_failed'`, `'cancelled'`, `'timed_out'`, `'failed'`) implies
 * `error` is present instead. Not encoded as a discriminated union on
 * `session.status` because callers overwhelmingly want either "give me
 * the response" or "give me the session" without a type-narrowing dance
 * — `session` alone remains the authoritative record of what happened.
 * 
 * Stage 3: when `request.workflowGraph` was set, `workflowResult`
 * carries the full `WorkflowResult` (every node's outcome, the workflow
 * receipt, etc.) and `response`/`receipt` instead describe only the
 * workflow's own terminal outcome in Stage 2's single-capability terms —
 * `response.content` is JSON-stringified workflow output, chiefly so a
 * caller that only ever reads `result.response.content` (ignoring
 * `workflowResult` entirely) still gets *something* sensible back rather
 * than `undefined`. A caller that cares about per-node detail should
 * read `workflowResult` directly.
 */
export interface ExecutionResult {
  readonly executionId: ExecutionId;
  readonly session: ExecutionSession;
  readonly response?: StructuredResponse;
  readonly receipt?: ExecutionReceipt;
  readonly error?: RuntimeError;
  readonly workflowResult?: WorkflowResult;
}
