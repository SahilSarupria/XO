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
- **An intent without an outcome is settled before anything is sent again** (see "Duplicate-call window" below): what happens depends on what the destination
  can guarantee, and an unattested destination is treated as one that cannot dedupe. When a call is re-sent it uses the **same** external idempotency key
  (derived from workflow, step and rendered key). Journal write failures propagate as crashes, not as step failures.
- **Fail closed:** undecidable, missing-fact, ungranted, unresolvable-key, over-ceiling, kill-switched and timed-out cases escalate or refuse; nothing defaults.
- **Compensation:** on `onError: compensate`, completed write steps with a declared `compensatedBy` are undone in reverse completion order; if any
  completed write has none, or an undo fails, the run **escalates and names what could not be undone**. Irreversible steps cannot be undone.

## NOT guaranteed (read this)

- **Not exactly-once, and never claimed to be.** Exactly-once against an arbitrary external system is impossible: after a crash or timeout the runner cannot know
  whether the destination acted. What is guaranteed is described precisely under "Duplicate-call window"; the residual risk is named there and surfaced by `xo flow reconcile`.
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

## Explain and audit export (section G, partial)

`xo flow explain <workflows.json> --workflow <id> --runs <dir> --run <runId> [--json]` rebuilds a run from its hash-verified journal: inputs, the steps that ran or were
skipped, extracted facts, rules fired, the source provenance the compiler recorded on each step, every connector call with request hash, response hash, duration and idempotency key,
approvals with reviewer and role, escalations, and the total model calls (0 on a deterministic path). Call hashes are journaled for new runs; older journals show `-`.
It reads the journal and the workflow document only; **it does not recover which package nodes justified a decision beyond the `provenance` strings the compiler put on steps**.

`xo flow audit-export ... --run-ids a,b --key <pem> --out bundle.json` writes a signed bundle: the journal slices, workflow id/version and the SHA-256 of the workflow component bytes,
the operator's connector grants, an optional manifest and load receipt, a Merkle root over run head hashes, and an Ed25519 signature. `xo flow audit-verify bundle.json --pubkey <pem>`
re-checks the signature, the root and every hash chain with nothing else (exit 3 on any problem). Key management is the operator's job.

## Duplicate-call window (what is guaranteed, what is not)

The journal is a transactional outbox: `call_intent` is durable **before** an external write is sent and `call_outcome` after. The window is an intent with no outcome
(the process died mid-call, or the call timed out). Before a write is sent again the runner **settles** that earlier attempt according to what the destination can
guarantee. That is a property of the _system at the other end_, so the operator states it per operation next to the grant, in the `--policy` file:

    "connectors": { "bank": { "grant": ["pay", "find"], "idempotency": {
      "pay": { "mode": "supports_lookup",
               "lookup": { "operation": "find", "args": { "id": "{arg.order}" }, "foundWhen": { "field": "found", "equals": true } } } } } }

| Attested mode                                | After an unknown outcome the runner…                                                                                                                                                                                                               | Residual risk                                                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `supports_key`                               | re-sends under the **same** key; the destination deduplicates                                                                                                                                                                                      | the destination's dedupe window/semantics; a destination that claims this and does not                                                          |
| `supports_lookup`                            | **asks the destination first** (a declared, granted read; `{key}` and `{arg.name}` are substituted, URL-encoded). Found → adopts the answer and does **not** write. Confirmed absent → writes. Lookup fails or cannot be filled in → **escalates** | eventual consistency (a lookup that lags the write); the lookup's result must expose the step's declared outputs or the step fails `BAD_RESULT` |
| `none` (the default for anything unattested) | **never writes again automatically**; escalates `AMBIGUOUS_EFFECT` with the connector, operation, journal time and idempotency key                                                                                                                 | the effect may or may not have happened; a person must look. This is real work, not a guarantee                                                 |

Built in: the file connector's create-only write is `supports_key` (a repeat is a no-op, different content is refused). Every other connector is `none` until the operator attests.
A failure that **proves nothing was sent** (connection refused, DNS failure, TLS certificate rejected before the request is written) is journalled `call_not_sent` and is retried
automatically in every mode; a timeout or a reset mid-exchange is _not_ in that class. Attestations are validated when the host starts: an unknown operation, a lookup that is not a
declared and granted read, or a malformed `foundWhen` refuses to start.

`xo flow reconcile --runs <dir>` reads the journals (it calls nothing) and lists every external write that is `pending` (resume the run), `ambiguous` (a person must check the
destination) or `resolved` by lookup/same-key re-send. Exit code 1 means something needs attention, so it can run from cron.

**What is tested:** for each of the three modes, a crash before and after **every** journal append of a two-write workflow, restarted over the same external system, asserts the
destination never sees a second effect for any item, that `supports_*` runs always complete with every item effected once, and that `none` runs either complete or escalate
`AMBIGUOUS_EFFECT` (and that reconcile flags it). Plus in-process timeouts after the effect, a lookup that confirms absence, a lookup that fails, and attestation validation. This is a
fake destination: it shows the runner's logic, not any real system's behaviour. **Not covered:** two runners driving one run directory (item 9), a destination that lies about its
guarantees, side effects outside connectors (compensation by a person), and the journal being deleted wholesale.

## Running a signed package (`--bundle`)

`xo flow run`, `xo serve` and `xo flow resolve` accept `--bundle <package.xo | directory holding exactly one .xo>` instead of loose files. The workflows and decision trees are then read
from the **verified package**: it unpacks, its structure, component hashes and Merkle root validate, the operator's package-trust policy (the same one `xo install`/`verify` use) accepts it, and
the workflow component is validated against the trees that package ships. **With no trust policy configured this fails closed**; `XO_TRUST_MODE=development` is the only way to run an
unverified package, and every run says `trust: unverified [mode=development]` and prints the development warning. `--bundle` cannot be combined with `<workflows.json>` / `--trees` (it
would be unclear which workflows the signature covers). `xo serve --bundle` also backs `POST /v1/loader/resolve` and `GET /v1/receipts` with the package.

`xo flow resolve --bundle <pkg> --family <name> [--capabilities chat,tool_use] [--json]` prints what that host would get (level, consumed and skipped components with reasons, how the
package's workflows negotiate on a model-free runner). It calls the same `resolveForHost` function as the HTTP endpoint, and a test asserts the two answers are identical.

**Not done from this item:** anchoring the new journal with the existing ledger anchoring, the "embed in your app" example, and `xo flow validate|report --bundle`.
