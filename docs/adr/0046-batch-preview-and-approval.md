# 0046: Batch preview and batch-bound approval (UW-8)

## Status

Accepted under the owner's delegation, 2026-11-22. Implements UAC-7 and ADR 0045 decisions 5 and 10.

## Context

The audit before this work found:

- **No human approval for most generated runs.** A generated workflow asks a person only where its source document states a human task. A generated batch that sends 300 emails through a `write` or `irreversible` binding ran with no approval at all (see `run-cancellation.test.ts` before this change).
- **Per-item approvals where they exist.** A `forEach` run asks once per item, so 300 approvals. Nothing binds the set of recipients, attachments and messages a person saw.
- **Building blocks already in place:**
  - the engine's shadow mode (`shadow_action` records each would-be call with its arguments, sending nothing);
  - the one signing primitive (the platform approval key, signing on the reviewer's behalf; ADR 0031);
  - the per-call gate (PX-10).
- **The gap in shadow mode:** it stops at approval steps and timers, so it never reaches the calls after them.

## Decision

1. **Engine preview mode** (`WorkflowRunnerOptions.preview`).
   - **What it is:** shadow mode in which an approval step counts as approved with no edits (`preview_approval`) and a timer wait as elapsed (`preview_wait`). Every would-be call is journaled with its exact arguments, and nothing is sent.
   - **What stops it:** a model step (`extract`) or a wait for an outside event escalates with `PREVIEW_NOT_EXACT`, because what follows can't be shown exactly. A call that takes another call's result is marked `not_exact` by the API, which finds it with a static walk of the step inputs.
2. **Preview** (`POST …/generated-workflows/{id}/previews`, author role).
   - **Gates:** the same as a start (certificate, pause, drift).
   - **Items:** each item (every item of a list run, or the run itself as a batch of one) gets:
     - a state (`sends`, `no_effect`, `stops`, `not_exact`);
     - the approval steps it reaches;
     - its actions. Each action has step, connector, operation, effect class, the **binding digest** (the connector's workspace bindings plus the sending account: `accountRef`, or user@host for basic credentials) and the **argument digest**. Attachments are named by content hash in `message.send` (UW-10), so the digest binds the bytes.
   - **Digests:** a leaf per item, and one root over every leaf, the definition, the certificate and the input digest.
   - **Reading it:** `GET …/previews/{id}` pages through it, exceptions first. A preview is kept 24 hours and is shown only to workspace members.
3. **Approval** (`POST …/previews/{id}/approve`, review role and a recent sign-in).
   - The person sends the **root they were shown**.
   - The approval is signed with the platform approval key as their decision (payload `kind: "batch"`), and there is one per preview.
   - It is refused when:
     - the root differs;
     - the preview expired;
     - any item is `not_exact`;
     - with `XO_APPROVAL_SEPARATION=required` (production default), the approver prepared the preview.
   - **Grant granularity, the ADR question the plan asks:** **one batch grant, checked per item.** The approval is one signed object; every approval step and every call of every item is checked against that item's leaf. There are no per-item grants to issue, store or revoke, and one item's mismatch never affects another.
4. **Start** (`batchApprovalId` on `…/runs` and on the Workflow entity start).
   - **Approval checks:** the approval must verify under the keyring, be for this definition and certificate, and be unexpired and unused.
   - **Input:** it must be the approved one; omit it to use the approved one.
   - **The preview is computed again:** it must give the same root. Any change since the approval (a recipient, attachment, message, sender, binding or setting) refuses the start and names the changed items.
   - **Run id and single use:** the run id follows from the approval, so a repeat is the same run. The approval is consumed by an exclusive file create, so of two requests or processes only one uses it.
5. **During the run:**
   - **Approval steps.** Each approval step the preview showed for an item is decided by the batch approval, through a new engine hook (`approvals.presigned`). The host presents a decision signed as the approver; the engine verifies it like any decision (signature, role, approval id, run, step, expiry) and journals `approval_presigned`. An undefined or invalid decision leaves the step for a person: never an approval without a person.
   - **Calls.** Immediately before each call, the gate compares the call's actual digest (step, connector, operation, current binding digest, argument digest) with the approved actions of that item. A mismatch is refused (`DENIED`, audited) and nothing is sent.
6. **Requirement.** `XO_RUN_APPROVAL=required` (production default) refuses a run of a definition with any `write` or `irreversible` act or compensate step unless it starts with a batch approval (`409 XO_BATCH_APPROVAL_REQUIRED`). `optional` (development default) keeps the previous behaviour.
7. **Audit.** `generated-workflow.batch.{previewed,approved,refused,required}` record ids, counts and reason codes, never a recipient, subject or argument (tested).
8. **Concurrency fix found by the tests.** Two simultaneous starts of the same run (the same approval, or the same `Idempotency-Key`, which predates UW-8) made the second request fail with 500 on the run lease. A start that finds its run held now answers with the run's state (`200`), waiting briefly for the run's first entry.

## Consequences

- **Production behaviour change:** a generated workflow that can send or change things starts only with a batch approval from someone other than the person who prepared it. Studio has no preview or approval screen yet (UW-12b, next in W4). Until then, production starts of such workflows go through the API.
- **The approval binds exactly what a person saw:**
  - at approval, by the root;
  - at start, by recomputing it;
  - at each step and call, by the leaf.
- **An approval never outlives its certificate:** a binding change makes the certificate stale first.
- **Workflows that can't be batch-approved:** those whose sends depend on a model, an outside event or another call's result. In production they need their own approval steps, or a document that states them. Recorded as a limit.

## Reopen if

- Batches far above the `forEach` bound are needed (the preview is held whole; paging is in the view only).
- Delegation or a quorum of approvers is required (ADR 0045 decision 10).
- Standing approvals arrive (UW-16): they reuse this grant and its checks.

## Amendments

- **Decision 5, approval steps: amended by ADR 0051.** A batch approval decides only the approval steps its approver names (`presignSteps`, inside the signature); the others wait for a person in each item. Approvals signed before this change (payload `v: 1`) keep deciding every step the preview showed.
