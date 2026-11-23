# Mandatory scenario index (RX-1h)

The runtime specification's twenty mandatory scenarios (section 18), each with the tests that prove it. Each evidence line names a test file and the test's title (or the start of it). `apps/api/test/scenario-index.test.ts` reads this file and fails if a file or a title is missing, so this index cannot drift from the tests.

Status follows ADR 0045's support envelope: **Done** is proven by the tests listed; **Not applicable** is outside the envelope by decision; **Planned** names its workstream.

## 1. Deterministic workflow, no model call — Done

- `packages/workflow-runtime/test/runner.test.ts` › runs to completion; the journal is a verifiable hash chain; no model or network involved
- `apps/api/test/generated-workflow-runs.test.ts` › a procedure runs as Workflow IR: certificate required, each step waits for a person, decisions are recorded

## 2. Invalid input rejected before any effect — Done

- `packages/workflow-runtime/test/runner.test.ts` › rejects invalid input before accepting a run
- `apps/api/test/generated-run-boundary.test.ts` › for_each is bounded against hostile input: too many items, too many bytes and the wrong shape are refused before anything runs

## 3. Default deny — Done

- `packages/runtime/test/capability-authority-boundary.test.ts` › the inverse of the above: same explicit declaration, permission NOT granted -> denied, never executes

## 4. Permission revoked during a paused run — Done

- `apps/api/test/generated-run-boundary.test.ts` › effects are authorized when they happen: a pause, a lost role or a changed binding while a run waits stops the effect, and nothing is sent

## 5. Approval digest mismatch or expiry blocks resume — Done

- `packages/workflow-runtime/test/approvals.test.ts` › refuses forged, tampered, replayed, misbound, unauthorised and revoked decisions
- `packages/workflow-runtime/test/approvals.test.ts` › an expired request escalates on tick and a late decision is refused; it is never approved by default
- `apps/api/test/batch-approval.test.ts` › UAC-7: a change after approval (a recipient in the input, the sending binding) refuses the start; nothing is sent

## 6. Model proposes an unauthorized action — Done

- `packages/pre-execution/test/intent-injection-corpus.test.ts` › a payload in the goal text, a section hint or a model proposal never changes the composed definition

## 7. Timeout before vs after dispatch — Done

- `packages/workflow-runtime/test/duplicate-window.test.ts` › none: a timeout after the effect is NEVER retried; the run escalates naming the ambiguity and the key
- `packages/workflow-runtime/test/duplicate-window.test.ts` › none: a failure that PROVES nothing was sent is still retried automatically

## 8. Crash after acceptance, before receipt — Done

- `apps/api/test/external-effect-durable-m4.test.ts` › durable e2e: crash window (adapter never answered) -> restart -> blocked until reconciled
- `packages/workflow-runtime/test/cancel.test.ts` › a call that was sent before a crash becomes outcome_unknown: escalated, never cancelled, never re-sent; a person reconciles it

## 9. Duplicate start requests — Done

- `apps/api/test/idempotency.test.ts` › a repeated equivalent request returns the established result and repeats NO side effect
- `apps/api/test/batch-approval.test.ts` › UAC-7: two starts with the same approval at the same moment make one run; each item is sent once

## 10. Parallel branch failure policy — Not applicable

Parallel branches are not a Workflow IR construct; unknown step types are rejected (ADR 0045).

## 11. Loop exceeds bounds — Done

- `apps/api/test/generated-run-boundary.test.ts` › for_each is bounded against hostile input
- `packages/workflow-ir/test/validate.test.ts` › refuses oversized collections via the schema (bounded by construction)

## 12. Cancellation in deterministic, human-wait and connector steps — Done

- `packages/workflow-runtime/test/cancel.test.ts` › a waiting run: cancelled at once, the approval disappears, a decision is refused, a repeat changes nothing
- `packages/workflow-runtime/test/cancel.test.ts` › a call in flight in this process finishes and is recorded as confirmed; nothing after it is sent
- `packages/workflow-runtime/test/cancel.test.ts` › no item starts after the cancel; settled items stand; in-flight items are confirmed; the rest are stopped; a repeat is harmless

## 13. Compensation succeeds, fails, partly succeeds — Done

- `packages/workflow-runtime/test/runner.test.ts` › runs compensations in reverse order when a later step fails with onError compensate
- `packages/workflow-runtime/test/runner.test.ts` › RX-1h scenario 13: a compensation that fails escalates COMPENSATION_FAILED to a person
- `packages/workflow-runtime/test/runner.test.ts` › escalates, naming what cannot be undone, when a completed write has no compensation

## 14. Provider rate limit, bounded backoff, deadline — Done

- `apps/api/test/rate-limits.test.ts` › Scenario 14: calls to a limited connector are spaced at its rate across a batch
- `apps/api/test/rate-limits.test.ts` › Scenario 14: a provider "slow down" pauses that connector for the time it asked
- `apps/api/test/rate-limits.test.ts` › Scenario 14: a pause longer than the step deadline fails the call RATE_LIMITED, provably not sent
- `packages/workflow-runtime/test/ratelimit-deadletter.test.ts` › retries after the pause it asked for, through the limiter; one effect; the circuit stays closed

## 15. OAuth revoked or expired blocks and asks to reconnect — Done

- `packages/connectors/test/credentials.test.ts` › a refresh the provider refuses ends the credential; nothing uses it until it is reconnected
- `packages/pre-execution/test/readiness.test.ts` › readiness: a revoked or wrong-capability connection blocks the authorization gate; an active one passes

## 16. Tenant isolation — Done

- `apps/api/test/credentials.test.ts` › cross-tenant matrix: another workspace, another person and a lower role cannot see, use, revoke or complete
- `apps/api/test/registry-routes.test.ts` › a different identity gets 404 (not another workspace's registry data) when reaching through a workspace it does not own

## 17. Replay uses pinned versions — Done

- `apps/api/test/pack-pinning.test.ts` › RX-1d: a pack installed after certification refuses the start; a new certificate pins it and the manifest records it

## 18. Post-run correction proposes, never activates — Done

A person's correction to a run is stored with the run, listed as an observation, and may be proposed as a knowledge change set (UW-11b). The knowledge head moves only when a reviewer other than the proposer approves it, and nothing learned from a run is executable.

- `apps/api/test/run-learning.test.ts` › Scenario 18: a person's correction to a run becomes a proposed change set; the knowledge head moves only when a reviewer approves it
- `apps/api/test/run-learning.test.ts` › UW-11b: run-outcome claims are never executable: no pack covers xo-run

## 19. Accepted but delivery unknown is not "delivered" — Done

- `packages/connectors/test/mail.test.ts` › Microsoft Graph: MIME send keeps the Message-ID, 202 is accepted not delivered

## 20. Kill switch stops new dispatch, handles in-flight work — Done

- `apps/api/test/emergency-stop.test.ts` › Scenario 20: a stop engaged mid-batch starts no further call, the call in flight completes, and after release every item is sent exactly once
- `packages/workflow-runtime/test/foreach.test.ts` › a hold engaged mid-batch starts no further item; released, the batch carries on and every item acts exactly once
