# 0033: The canonical engine's effects, cancellation and batches (UW-7)

## Status

Accepted under owner delegation, 2026-11-16 (UW-7, wave W2). Signed off by Claude under the owner's delegation of decision
authority; this is a delegated sign-off, not an independent review. It implements ADR 0024 (cancellation, D-O), the
effect-state mapping table and the spike defects that ADR 0011 assigned to UW-7, and records how far the runner fold goes.

## Decisions

1. **Cancellation (ADR 0024) is built into `@xo/workflow-runtime`.**
   - **Recorded first.** `RunStoreLike.requestCancel` writes `<run>/cancel.json` exclusively and fsyncs it, before anything
     else. The first request wins, and a repeat returns the same record (`recorded: false`). The write is not fenced by the
     lease, so any instance can record a cancel while another instance drives the run.
   - **No dispatch after it.** The runner reads the request before every step and twice before every external call: once
     before journalling the intent, and once immediately before sending. A call stopped at the last check is journalled
     `call_not_sent`, so it is provably not an unknown outcome. An item of a batch obeys its batch's request, so a batch
     cancel needs no per-item fan-out and cannot race an item being created.
   - **Settled work stands.**
     - A run whose steps have all succeeded completes; it is not relabelled as cancelled.
     - In a batch, completed items stay completed, open items are cancelled (each under its own lease), and items never
       started are not started.
   - **In flight becomes `outcome_unknown`.** A call journalled as sent with no outcome gets an `effect_unknown` entry and
     the run escalates with `CANCELLED_OUTCOME_UNKNOWN`. Such a step is never marked cancelled, re-sent or undone. A batch
     with such an item escalates with `ITEMS_NEED_ATTENTION`.
   - **The declared policy decides the rest.**
     - `abandon`: the run ends `cancelled`.
     - `compensate`: completed reversible writes are undone (the only calls allowed after a cancel), and the run ends
       `compensated` with `cancelled: true` in its result. If something cannot be undone, the run escalates.
   - **Authority and audit.** `POST …/runs/{runId}/cancel` needs `author`. Every request is audited as
     `generated-workflow.run.cancelled`, a repeat included.
   - **Procedures are unchanged.** The P1.1 procedure routes keep their pinned "no cancel route" assertions. They are not on
     this engine yet; ADR 0024's retirement of the pin applies when they move.

2. **One effect vocabulary.**
   - `EFFECT_STATE_MAPPING` (`packages/workflow-runtime/src/effects.ts`) maps every journal fact about a call, every adapter
     ledger state and every procedure effect code onto the six O-3 states. `docs/EFFECTS.md` is generated from it.
   - Tests check that every call-related journal type the runner writes is mapped, that every state is reachable, and that
     the document matches the code.
   - `effectsOf(journal)` gives one row per external call. Run views carry it as `effects` (UAC-9).
   - A journal intent alone is `dispatch_attempted` while the run can still settle it, and `outcome_unknown` once it cannot.
     It is never `intent_recorded`, because the journal cannot prove the call was not made.

3. **Reconciliation is by a person and never re-sends.**
   - `POST …/runs/{runId}/effects/{step}/reconciliation` takes `confirmed_success`, `confirmed_failure_no_effect` or
     `unresolved`. It needs `review` and a recent sign-in, and only a call in `outcome_unknown` or
     `reconciliation_required` can be reconciled.
   - The decision is journalled as `effect_reconciled` and audited as `generated-workflow.effect.reconciled`.
   - Nothing is sent, re-sent or undone. `unresolved` keeps the call blocking. The escalated run stays with a person.

4. **UAC-8 holds structurally.** A destination that cannot deduplicate is never sent the same call twice: an unknown outcome
   escalates the item (`EFFECT_UNKNOWN`). After repeated failures the connector's circuit opens, and the remaining items stop
   without being sent (`CIRCUIT_OPEN`). None of them is assumed to have succeeded.

5. **Batches report partial completion.** A batch summary carries `outcome`: `all_completed`, `partially_completed` or
   `none_completed`. The Workflow entity's lifecycle gains `partially_completed`, which amends ADR 0032 decision 5. A
   `compensated` run is `cancelled` when it was a cancel and `failed` otherwise. Before UW-7 it showed as `completed`, which
   was wrong: compensated means undone.

6. **Orphaned run ids are recovered.** A run directory with no durable first entry (a crash between acceptance and
   `run_started`) is completed by a start with the same id. The check is repeated inside the lease, so two such starts give
   one run (spike defect, ADR 0011 decision 5).

7. **forEach conformance vectors.** `@xo/workflow-ir/conformance/foreach-vectors-1.0.json` holds ten vectors that any
   runtime must reproduce:
   - isolation, partial and none-completed batches;
   - an unknown outcome with no blind resend;
   - bounded concurrency;
   - hostile input refused before anything runs;
   - at-most-once acceptance;
   - cancel mid-batch.

   `packages/workflow-runtime/test/foreach-conformance.test.ts` runs them in CI (UAC-22).

8. **Effect class and typed outputs on capability contracts.**
   - `contractEffectOf` derives a class: `none` (rules), `human` (human task), `read`, `write` or `irreversible` (the
     operator's binding), or `unknown`. `unknown` is treated as a write.
   - `contractOutputSchema` gives the typed outputs, including a human task's outcome schema. Untyped outputs are named,
     not guessed.
   - Both are derived rather than stored, so no contract hash changes. The capability inventory records them as `effect`
     and `outputSchema`, which binds them into the inventory digest and the readiness certificate.

9. **A refused human task stops the workflow.**
   - The engine-parity test showed a gap: when a person rejected a procedure step, the Workflow IR run skipped the rest and
     ended `completed`. The composed runner ended `rejected`.
   - The lowering now follows each person's task with an `escalate` step. It runs only when the person reports the task was
     not done, and what follows needs that step, so a refusal stops the run before anything after it is considered.
   - This changes the definitions (and digests) generated for procedures; the corrected shape assertions say why.

10. **How far the runner fold goes.**
    - Because certified procedures now contain an escalation, the PX-10 rule (one certificate, one meaning) sends every
      certified workflow to the canonical engine. The composed start returns `XO_WORKFLOW_REQUIRES_IR_RUNTIME`, and Studio
      already starts such workflows on the Workflow IR runtime.
    - With certificates required (the production default), every production run therefore goes through one engine.
    - The composed-workflow runner stays only for uncertified development starts. Retiring it is a separate, owner-approved
      step (ADR 0011 decision 4). The parity test (`apps/api/test/engine-parity.test.ts`) is the evidence that step needs.

## Consequences

- One run report shows each external call's state, a person's reconciliation and a cancel. The Workflow entity's lifecycle
  follows from them.
- The certificate a production instance requires now means one engine, one effect vocabulary and one cancellation semantics.
- Generated procedure definitions change once (the not-done escalation). A certificate issued before UW-7 is stale against
  a regenerated definition, as for any change to a definition.

## Reopen if

A destination needs a cancel to reach a call already in flight (a provider-side abort). That would be a new effect fact and a
new row in the mapping table, never a reinterpretation of `outcome_unknown`.
