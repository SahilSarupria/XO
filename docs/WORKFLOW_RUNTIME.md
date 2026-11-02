# Workflow runtime (`@xo/workflow-runtime`, `xo flow`)

A durable, resumable runner for Workflow IR 1.0. Unmeasured: no load, latency, or accuracy numbers exist for it.

## Try it (no network, no API key)

`npm run build && sh examples/workflows/refund-desk/run.sh` validates, reports, runs a deterministic refund workflow, replays the same event
(not re-executed), and shows an undecidable case escalating. The CLI command is `xo flow` (the name `xo workflow` already belongs to the older composer).
`xo flow run` exit codes: 0 completed, 2 escalated or waiting, 3 failed or refused.

## What it implements

Decide (tree, rules, formula, lookup), branch, act, compensate, escalate, extract (structured passthrough; free text only via an injected
`Extractor`), timer waits, retries with backoff and jitter, per-connector circuit breakers and concurrency limits, authority ceilings, a kill switch,
a whole-run wall-clock cap, dry-run. **Not implemented:** `approve` steps, `wait` on events, `forEach` (a workflow that needs them is refused whole at
construction), rate limiting, a dead-letter queue (exhausted steps escalate or fail), the free-text `Extractor` itself (an interface only).

## Journal

`<runs>/<runId>/journal.jsonl`: append-only, fsynced per entry, each entry hashes the previous one. State is rebuilt by replaying it. A torn last line
from a crash is dropped and repaired; any other break is `JournalCorruptError` and the run is not resumed. This journal is the run ledger; folding it
into the desk `HashChainLedger`, bounded in-memory windows and segment recovery are **not done**.

## Guarantees

- **At-most-once acceptance:** a run id (or dedupe key) creates its directory atomically; a second start returns the existing state with `accepted:false`.
- **Recorded outcome before the next step:** `call_intent` is durable before an external call, `call_outcome` after it and before anything depends on it.
  After a crash, a recorded outcome is reused and never re-called.
- **Same key on takeover:** an intent without an outcome is called again with the **same** external idempotency key (derived from workflow, step and
  rendered key). Journal write failures propagate as crashes, not as step failures.
- **Fail closed:** undecidable, missing-fact, ungranted, unresolvable-key, over-ceiling, kill-switched and timed-out cases escalate or refuse; nothing defaults.
- **Compensation:** on `onError: compensate`, completed write steps with a declared `compensatedBy` are undone in reverse completion order; if any
  completed write has none, or an undo fails, the run **escalates and names what could not be undone**. Irreversible steps cannot be undone.

## NOT guaranteed (read this)

- **Not exactly-once.** Execution is at-least-once: a crash between the external call and its journaled outcome causes a second call. An external
  system that ignores idempotency keys can see a duplicate in that window. Transient failures may also be retried; each retry reuses the key.
- One process per run: there is no cross-process lock or lease yet (section F). Two runners driving the same run directory can race.
- The journal detects tampering after the fact; it does not stop a user with disk access from deleting a whole run directory.
- Timers need `tick()` to be called; there is no scheduler daemon yet.
- Authority ceilings and the kill switch are checked in the runner only; they are not a substitute for upstream controls.

## Human approval (section D, backend only)

An `approve` step parks its run and builds an `ApprovalRequest`: the case (step inputs), evidence fields the author named, the decision trace
(rules fired by upstream decide steps), the connector operations that depend on the step (the proposed actions), whether edits are allowed, and an
expiry. Delivery: an `ApprovalSink` callback; `directoryApprovalSink(dir)` writes `<approvalId>.json` atomically for a frontend or poller.
Webhook and SMTP delivery for approvals are **not built**, and there is **no HTTP route yet** (the `/v1/approvals` surface is section F). The runner
API a frontend will sit behind is `listApprovals()`, `getApproval(id)` and `decideApproval(runId, signedDecision)`.

A decision is `approve`, `reject` or `edit_and_approve`, signed with the reviewer's Ed25519 key over the canonical decision payload. The runner refuses, and
changes nothing, on: unknown or revoked reviewer, bad signature (including a flipped action), a decision bound to another run/step/approval, a reviewer
with no permitted role, edits that are not allowed or do not match the declared output type, an expired request, or a second decision. Roles are
`publisher, reviewer, installer, auditor`; **auditors are read-only and can never decide**, even if a workflow lists the role. The approval id is
derived from workflow, version, step and run, so a decision cannot be replayed on another run. The accepted decision, reviewer, role and signature
are written to the journal, so audits can re-verify it. **Timeouts escalate (`APPROVAL_TIMEOUT`); no code path approves by default.** A rejection
completes the step with `decision: rejected` (downstream `runIf` decides what happens); extra edit outputs are `null` on rejection.

Limits: the reviewer registry is a static in-process list (a trust-policy file loader comes with section G); key custody, rotation and revocation
distribution are the operator's job; one process per run still applies.

## Determinization controls (section E, partial)

- **Structured-first routing:** an `extract` step with `structuredFirst` and a complete, valid `structured` input makes **zero model calls**
  (tested). Free text goes through the injected extractor once; validated results are memoized on disk by the normalized case (whitespace collapsed),
  so an identical case never re-invokes the model. A damaged or invalid memo entry is a miss. Not measured: hit rates on real traffic.
- **Shadow mode** (`shadow: true`, `xo flow run --shadow`): everything decides, **no connector call is made**, each would-be action is journaled as
  `shadow_action`. `xo flow compare` reads human decisions from a CSV and reports agree / disagree / deferred (the workflow escalated) / missing, with
  agreement among cases it chose to decide. It describes only the cases supplied; it is not an accuracy claim.
- **Authority limits:** per-workflow ceilings (IR `authority`), a kill switch, and persisted daily caps on side effects and on model calls (`UsageCaps`).
  All fail closed: an unreadable counter file escalates (`CAPS_UNAVAILABLE`), an exhausted cap escalates (`DAILY_CAP`). Spend in currency is not tracked,
  only call counts. Caps are per directory and single-process.
- **Promotion loop** (`proposeRules`, `validatePatch`, `signPatchAcceptance`, `applyPatch`): learns from logged human decisions, **never auto-applies**.
  It proposes single-condition rules (equality, `<=`, `>=`) with support at least 5 and zero counterexamples, validates them against **every** logged case,
  and only a trusted publisher's verifying signature over the exact patch lets `applyPatch` return a new workflow version (patch+1, learned rules first,
  full IR validation re-run). The live component is never mutated, and the result still has to be packaged, signed and installed. Limits: one output
  field, no multi-feature interactions, learned rules may only read workflow inputs of the same name, the CLI `xo promote` is **not built** (library only),
  and nothing is measured on real data.
