# External effects: one vocabulary

Every call XO makes to another system (a send, a payment, a write) is reported in the same six states, whichever part of XO made it: the Workflow IR runtime, the `@xo/adapters` dispatch ledger or a P1.1 procedure. The decisions are in ADR 0015, ADR 0024 and ADR 0033.

| State | Meaning | Needs a person? |
| --- | --- | --- |
| `intent_recorded` | Recorded and not yet sent. Nothing can have happened. | No |
| `dispatch_attempted` | Possibly sent, and the run can still settle it automatically: it retries with the same key, or checks with a destination lookup. | Not yet |
| `confirmed_success` | Confirmed by the destination, by a lookup, or by a person. | No |
| `confirmed_failure_no_effect` | Confirmed that nothing changed. | No |
| `outcome_unknown` | It may have taken effect, and nothing will settle it automatically. | Yes |
| `reconciliation_required` | XO stopped because the outcome cannot be established automatically. | Yes |

Two rules always hold:

- **Nothing is confirmed without confirmation.** Only an outcome, a destination lookup or a person confirms a call.
- **A call that may have gone out is never reported as failed or cancelled.** Until a person records what happened, it is shown as unknown.

## Where each state comes from

The table below is generated from `EFFECT_STATE_MAPPING` in `packages/workflow-runtime/src/effects.ts`. To regenerate it, run `npx tsx packages/workflow-runtime/scripts/render-effects-doc.ts`. A test fails if the table and the code differ.

<!-- effect-state-table:begin -->
| Source | Recorded fact | Effect state | Meaning |
| --- | --- | --- | --- |
| journal | `call_intent (no later outcome; the run can still resume)` | `dispatch_attempted` | Written durably immediately before the call. It cannot prove the call was not made, so it is never intent_recorded: the next attempt settles it first (same key, or a destination lookup). |
| journal | `call_intent (no later outcome; the run has ended)` | `outcome_unknown` | The call may have taken effect and nothing will settle it automatically. |
| journal | `effect_unknown` | `outcome_unknown` | The run was cancelled while the call was in flight (ADR 0024). Never reported as cancelled, repeated or undone. |
| journal | `effect_ambiguous` | `reconciliation_required` | An earlier attempt has no outcome and the destination cannot deduplicate or be checked; the runner stopped and escalated. A person must look. |
| journal | `effect_retry_same_key` | `dispatch_attempted` | Re-sent under the same key to a destination that deduplicates on it. |
| journal | `effect_lookup (found: false)` | `dispatch_attempted` | The destination confirmed the earlier attempt had no effect; written once more. |
| journal | `call_outcome (ok: true)` | `confirmed_success` | The destination answered with a result (or a lookup found the effect and it was adopted, with no second write). |
| journal | `call_outcome (ok: false)` | `confirmed_failure_no_effect` | A permanent refusal by the destination (for example DENIED, INVALID); recorded as final and never retried. |
| journal | `call_not_sent` | `confirmed_failure_no_effect` | The failure provably happened before anything reached the destination. |
| journal | `effect_reconciled (decision: confirmed_success)` | `confirmed_success` | A person checked the destination and recorded that the effect happened. |
| journal | `effect_reconciled (decision: confirmed_failure_no_effect)` | `confirmed_failure_no_effect` | A person checked the destination and recorded that nothing happened. Nothing is re-sent automatically. |
| journal | `effect_reconciled (decision: unresolved)` | `reconciliation_required` | A person looked and could not establish the outcome; it stays blocking. |
| adapter | `intent_recorded` | `intent_recorded` | Reserved by the O-3 model; no component in this repository writes it (the ledger claims a key with dispatch_attempted). |
| adapter | `dispatch_attempted` | `dispatch_attempted` | Claimed before the adapter is called. |
| adapter | `confirmed_success` | `confirmed_success` | The adapter confirmed the effect. |
| adapter | `confirmed_failure_no_effect` | `confirmed_failure_no_effect` | The adapter positively knows the external system made no change. |
| adapter | `outcome_unknown` | `outcome_unknown` | Anything not positively confirmed, including a throw, a timeout or a malformed reply. |
| adapter | `reconciliation (decision: unresolved)` | `reconciliation_required` | Someone looked and could not establish the outcome. |
| procedure | `step succeeded (external step)` | `confirmed_success` | The adapter confirmed the effect. |
| procedure | `step failed, XO_EXTERNAL_EFFECT_CONFIRMED_FAILURE_NO_EFFECT` | `confirmed_failure_no_effect` | The adapter confirmed nothing changed. |
| procedure | `step failed, XO_EXTERNAL_EFFECT_OUTCOME_UNKNOWN` | `outcome_unknown` | Reconciliation is required before any further dispatch (no retry, no automatic recovery). |
| procedure | `step waiting_for_human (payload_approval)` | `intent_recorded` | Nothing was claimed or dispatched; the step waits for a person to approve this exact input. |
<!-- effect-state-table:end -->

## Where you see it

- **Run report.** Every generated-workflow run view (and every Workflow entity run) has an `effects` list: one row per external call, with its state, key and detail.
- **Reconciliation.** For a call in `outcome_unknown` or `reconciliation_required`, a reviewer records what happened with `POST …/runs/{runId}/effects/{step}/reconciliation`. The decision is `confirmed_success`, `confirmed_failure_no_effect` or `unresolved`, and it needs a recent sign-in. Recording a decision never sends, re-sends or undoes anything.

## Cancelling (ADR 0024)

- **The cancel is recorded first.** It is written durably before anything else, so any API instance can record it, even while another instance is driving the run.
- **Nothing is sent after it.** The runner checks for a cancel before every step and immediately before every call. A call stopped this way is recorded as not sent.
- **Completed work stands.**
  - Calls that already finished keep their confirmed state.
  - A run whose steps had all finished completes normally.
  - In a batch, items already completed stay completed, items still open are cancelled, and items never started are not started.
- **A call that was in flight becomes `outcome_unknown`.** It is never marked cancelled, repeated or undone. The run, and the batch, then need a person.
- **The workflow decides what happens to completed writes** (`cancellation.onCancel`):
  - `abandon`: the run ends `cancelled`.
  - `compensate`: completed reversible writes are undone, and the run ends `compensated` with `cancelled: true` in its result.
- **Asking twice is harmless.** The first request stands, and every cancel is audited.
