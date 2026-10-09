import { ErrorCode } from '@xo/errors';
import type { CompilationStore } from '../compilations/compilation.js';
import type { HumanTaskDecision, HumanTaskResumeOutcome } from './execution.js';
import { resumeCapabilityExecution } from './execute-capability.js';

/**
 * P0.7's real resume implementation, and the direct answer to P0.6's
 * open question ("why direct capability execution currently creates no
 * resumable checkpoint" / "whether the current escalation resolver is
 * stateless and must be extended").
 *
 * ## Why no NEW checkpoint/continuation-context store was needed
 *
 * A `WorkflowExecutor` checkpoint (`workflow-checkpoint.ts`) exists to
 * resume a multi-step GRAPH execution — it has to remember which nodes
 * already ran, their outputs, and where in the graph to pick back up.
 * A single-capability execution (the only kind P0.5/P0.6/P0.7 ever
 * create — no `@xo/workflow-composer` dependency anywhere in this API)
 * has no such intermediate state: there is exactly one step, and it
 * already fully ran once (producing the persisted escalation record).
 * Resuming it needs only three things, all of which `ExecutionRecord`
 * (P0.5/P0.6) already persists: `compilationId` (to re-fetch the exact
 * compiled graph this execution ran against — via
 * `CompilationStore.getCompiledGraph`, never a fresh recompile),
 * `capabilityId`, and `input` (the ORIGINAL input, re-supplied to
 * `resumeCapabilityExecution` unchanged — see that function's own doc
 * comment on why a resolver can't override it). That's the entire
 * "continuation context" — no new field, no new store.
 *
 * ## Why `ActionEscalationBindingResolver` was NOT modified
 *
 * `ActionEscalationBindingResolver.evaluate` is deliberately, and
 * extensively, documented as pure and stateless: "given the same
 * contract and the same input, it always produces the same record...
 * `evaluate` never attempts the underlying business action... Whether
 * the human actually completes the action is outside this resolver's —
 * and this binding's — scope entirely." That is a load-bearing safety
 * boundary, not an oversight: it is what makes "a `human_in_the_loop`
 * binding's successful `evaluate` call" impossible to mistake for "the
 * real-world action was performed." Adding a branch to `evaluate` that
 * makes it report success given some magic "the human approved" input
 * flag would be exactly the violation that resolver's own documentation
 * forecloses. It was left untouched.
 *
 * ## What "resume" means instead
 *
 * `resumeCapabilityExecution` (`execute-capability.ts`) genuinely
 * re-derives the contract/binding from the persisted graph and
 * genuinely re-invokes `RuntimeCapabilityExecutor.execute` — through a
 * FRESH `RuntimeCapabilityRegistry`/`PermissionManager`, so
 * authorization is truly re-checked, not assumed still valid. For
 * `ActionEscalationBindingResolver`'s binding specifically, that
 * re-invocation deterministically reproduces the identical escalation
 * record (by design — see above) — and THIS function treats that
 * outcome, combined with the human's own recorded approval, as the
 * human-in-the-loop task's genuine completion (`'succeeded'`), never as
 * an automated business result. A `'reject'` decision never invokes the
 * runtime at all (see `resumeCapabilityExecution`'s reject branch) — it
 * is a pure, structured business-level rejection.
 *
 * The mechanism itself is fully generic, not special-cased to this one
 * resolver: a binding whose `evaluate` DOES branch on the merged-in
 * `input.humanDecision` field gets a materially different, genuinely
 * computed result back — proven by this milestone's test-only fixture
 * (`apps/api/test/human-task-resume.test.ts`), built from the same
 * `BindingResolver`/`CapabilityBinding`/`SemanticCapabilityContract`
 * interfaces `@xo/capability-contract` already exports, per the
 * milestone brief's explicit "create the smallest additional test-only
 * capability fixture using existing runtime contracts" allowance —
 * without adding a new resolver to the shared default resolver list or
 * touching any compiler/capability-contract internals.
 *
 * ## What remains genuinely `'unsupported'` after this milestone
 *
 * Only the residual case where the continuation context itself cannot
 * be reconstructed — the owning compilation's graph is missing/corrupt
 * (e.g. deleted, or predates a future incompatible graph-schema
 * change). That is NOT reachable through this API today (nothing
 * deletes a compilation), so it is handled defensively rather than
 * tested as a live scenario — see the `getCompiledGraph` failure branch
 * below.
 */
export async function attemptResume(
  compilationStore: CompilationStore,
  compilationId: string,
  capabilityId: string,
  originalInput: unknown,
  decision: HumanTaskDecision,
  decisionData: Readonly<Record<string, unknown>> | undefined,
): Promise<HumanTaskResumeOutcome> {
  const graphFound = await compilationStore.getCompiledGraph(compilationId);
  if (!graphFound.ok) {
    return { kind: 'unsupported', errorCode: ErrorCode.HITL_RESUME_UNSUPPORTED, errorMessage: `could not resume: the compiled graph for compilation "${compilationId}" is no longer available (${graphFound.error.message})` };
  }

  const outcome = await resumeCapabilityExecution(graphFound.value, capabilityId, originalInput, decision, decisionData);
  switch (outcome.kind) {
    case 'succeeded':
      return { kind: 'succeeded', output: outcome.output };
    case 'rejected':
      return { kind: 'rejected', output: outcome.output };
    case 'invalid_input':
      return { kind: 'failed', errorCode: ErrorCode.RUNTIME_CAPABILITY_INPUT_INVALID, errorMessage: `decision data validation failed: ${outcome.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}` };
    case 'unresolved': {
      const codeByStatus: Record<'unresolved' | 'ambiguous' | 'denied', string> = { unresolved: ErrorCode.BINDING_UNRESOLVED, ambiguous: ErrorCode.BINDING_AMBIGUOUS, denied: ErrorCode.BINDING_DENIED };
      return { kind: 'failed', errorCode: codeByStatus[outcome.status], errorMessage: outcome.reason };
    }
    case 'error':
      return { kind: 'failed', errorCode: outcome.errorCode, errorMessage: outcome.errorMessage };
  }
}
