# XO P1.0 M4 — Durable Audit: guarantees, failure semantics, operations

Status: implemented. **Accepted by the owner for P1.0** (owner decision recorded 2026-10-16 in `P10_CLOSURE_BASELINE.md`),
contingent on the evidence and the limitations below, which remain in force. Acceptance is a P1.0 scope decision; it does not make
this audit log tamper-evident, atomic with execution storage, or safe for multi-host or network-filesystem use.

## What is recorded

`@xo/audit` defines a versioned (`schemaVersion: 1`) event: `eventId`, `seq`, `recordedAt`, `retainUntil`,
`classification: "restricted"`, `type`, `action`, `outcome`, `actor` (verified principal, or `system`/`anonymous`),
`target`, `correlationId`, `executionId`, `reasonCode`, flat sanitized `metadata`. Callers supply a _draft_; id, sequence,
time, retention and receipt are assigned only by the store. Metadata rejects secret-looking values/keys, content-bearing
keys (`prompt`, `input`, `payload`, `document`, `token` …), opaque blobs and reserved trusted-field names. Rejections never
echo the offending value. The actor must be minted from a verified `AuthenticatedPrincipal` (`actorFromPrincipal`).

## Durability guarantee (exactly this)

A **durable receipt** from `FileAuditStore` means: the event line was appended to `audit.jsonl` and `fsync`ed before
`append` resolved, so it survives process crash/kill. Receipts are minted only inside `@xo/audit` (module-private registry;
literals, spreads, JSON/structured clones fail `isDurableReceipt`). Not guaranteed: tamper resistance (no hash chain —
out of M4 scope, separate decision), media/power-loss durability beyond what the OS/disk honour for fsync, replication,
cross-process safety on network filesystems. Cross-process writes use an advisory lock file with stale-lock stealing
(local POSIX only; run one writer per directory for strong guarantees). `seq` is strictly increasing and gap-free between
purges (gaps appear only after an authorized purge; the purge marker records the removed range).

Failed appends are **indeterminate** (bytes may have landed). Retry with an `idempotencyKey` to avoid duplicates; a dedupe
hit is re-fsynced before a receipt is minted. A torn tail from a crash mid-write is detected, newline-terminated before
the next event, and reported as `corruptLines` on read — never silently repaired.

## Ordering and failure semantics

| Situation                                       | Behaviour                                                                                                                                                                                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protected read                                  | owner authorization → durable `access.attempted` → read. Audit failure ⇒ 503 `XO_AUDIT_UNAVAILABLE`, nothing read or disclosed. The event says _attempted_, never _completed_.                                                                           |
| Denial                                          | recorded best-effort; the denial is enforced whether or not the record was written.                                                                                                                                                                      |
| Execution / workflow / HITL start               | authorized → durable `*.started` / `*.attempted` **before** any record is created or capability runs. Failure ⇒ 503, no side effect.                                                                                                                     |
| Completion (after side effect)                  | recorded after the fact. Failure ⇒ the **real outcome is returned** with `auditFinalization: { status: "failed", correlationId, executionId }`; the side effect is never retried; failure is logged and counted.                                         |
| Crash between side effect and completion append | **no completion event exists**; the store cannot know. Detect a `*.started`/`*.attempted` with a correlation id and no later outcome, cross-checked against execution/workflow records. No atomicity exists between execution storage and audit storage. |
| Direct runtime (CLI, embedders)                 | `RuntimeCapabilityExecutor` `audit` port: same before/after semantics; `AUDIT_UNAVAILABLE` blocks the handler; after-failure surfaces `auditFinalization: "failed"` on the result.                                                                       |

Workflow step events are written from the persisted record when a segment returns (accurate states, not a live stream).

## Operational recovery

- **Audit store outage:** protected reads and all mutations return 503; denials still enforce. Restore the volume or
  permissions; no restart is needed. Watch the `audit write failed` log lines and `AuditService.failureCount`.
- **Unresolved post-execution failures:** find responses/logs carrying `auditFinalization.failed`, query
  `GET /audit/events?correlationId=…`, and reconcile out-of-band. Do **not** re-run the operation.
- **Corrupt lines:** reported by `GET /audit/events` (`corruptLines`); investigate, do not delete evidence casually.
- **Stale `audit.lock`:** stolen automatically after 30 s; remove manually only if no writer is running.

## Startup and retention

Set **all** of `XO_AUDIT_DIR`, `XO_AUDIT_RETENTION_DAYS`, `XO_AUDIT_MIN_RETENTION_DAYS` (retention ≥ minimum > 0).
`NODE_ENV=production` without them, or any partial set, aborts startup. With none set outside production the API runs in
explicit **non-production mode** (volatile, loudly logged, receipts say `volatile-memory`). No retention period is
defaulted or invented. `retainUntil` is stamped by the store. **Purge** (`POST /audit/purge`, permission `audit.purge`)
removes only records past `retainUntil` **and** older than the configured minimum, rewrites atomically
(temp + fsync + rename), and appends a content-free `audit.purged` marker. Surviving events are never rewritten.

## Access control

`audit.read` / `audit.purge` are permissions in a new `audit` domain, decided by the existing M2 policy (default-deny).
A verified principal is required; by default only `service` principals are considered (`auditAccessKinds` widens this;
the policy still decides). Authorization is re-evaluated on every call and yields a single-use, 30 s grant that the store
consumes; revoked API keys fail authentication per request. Reading the audit log is itself audited (`audit.read`),
fail-closed.

## Model exclusion

Audit data is `restricted`. The repository had no data-classification mechanism, so the smallest explicit contract was
added: `isAuditData` (`@xo/types`) / `assertNotAuditData` (`@xo/errors`), enforced at the funnel of each ingestion path —
`ContextAssembler.assemble` (model context and retrieval slices), `RuntimeMemory.put` (memory), `AiCapabilityLayer`
(every provider request). The repository has no training or fine-tuning data path, so none is guarded. Limit: a
structural guard cannot recognise audit content that was paraphrased or re-keyed before reaching a boundary; nothing in
M4 hands audit records to those paths.

## Protected read surfaces (rationale)

Source content (raw user documents); execution list/get (inputs/outputs); human-task list/get; workflow list and
workflow-execution list/get (step results); the audit log. Not protected: workspace/registry/package metadata and
capability catalogues (derived metadata, no raw documents or run data).

## P1.0 owner dispositions and accepted limitations

The owner approved these dispositions for P1.0 (decision of 2026-10-16, recorded in `P10_CLOSURE_BASELINE.md` §4 and §9). They
accept the limitations; they do not remove them, and none of them is a claim of a stronger guarantee.

**Not tamper-proof and not tamper-evident (R7).** There is no hash chain, signature or other integrity protection.
**Anyone with write access to the audit file (`audit.jsonl`) or its directory can alter, delete or truncate events without
detection.** `seq` gaps and the `audit.purged` marker are not an integrity mechanism: they describe an authorized purge and can
be forged by the same party. Do not describe this audit history as tamper-proof or tamper-evident. Protect the directory with
filesystem permissions and copy the file to write-once storage if evidence value matters. Stronger integrity protection is
future work that needs a separate design decision (key custody, anchoring, verification procedure); it is not part of P1.0.

**Local CLI executions are unaudited by default (R8).** Under the current principal model the CLI has no authentication
boundary and carries no principal (decision record D2 and I8), and audit actors can only be minted from a verified principal.
So a local `xo run` leaves no audit record unless the operator sets the `XO_AUDIT_*` variables, and even then there is no
verified individual to attribute it to. No identity or attribution model was invented. Treat the CLI as a trusted local
operator context, not an audited path.

**Retention is operator-configured, with no default (R9).** Production requires explicit `XO_AUDIT_RETENTION_DAYS` and
`XO_AUDIT_MIN_RETENTION_DAYS`; startup aborts without them. XO supplies no recommended period; legal and operational
retention is the operator's decision.

**The crash window is detectable and manually reconcilable, not atomic (R10).** Execution storage and audit storage are
separate files with no transaction between them. If a process dies after a side effect and before its completion event, the
audit log holds a `*.started` / `*.attempted` event with no outcome while the execution or workflow record shows what really
happened. There is **no automatic reconciler**; reconciliation is the manual procedure in "Operational recovery" and is
exercised by `apps/api/test/audit-durable-e2e.test.ts` (the "R10 crash window" test). That test builds the post-crash state by
failing the completion append; it does not kill a real process, and it proves detectability, not atomicity.

**Local-filesystem, single-writer boundary (R11).** Guarantees hold for one writer process per audit directory on a local
POSIX filesystem. Several processes on one local filesystem are coordinated by an advisory lock file (tested for two store
instances). The store is **not** distributed, **not** multi-host safe and **not** safe on network filesystems, and there is no
replication. This matches the approved single-tenant, single-deployment model (decision record D1) and the in-process
idempotency coordination of M6.

## Failure reason codes on completion events (P1.0 F-1)

The completion event of a human-task resolution and of a failed workflow segment carries the **stored failure code** as
`reasonCode` — the `ErrorCode` already persisted on the execution/workflow record. Only the code is used, never the
associated message (which may carry free text). A stored code that does not match the audit `reasonCode` shape degrades to
`XO_UNKNOWN`. No HTTP status, response body, task state, execution state or audit schema changed.

| Situation (standalone `POST …/executions/:id/resolve`)                              | Event                                     | Outcome     | `reasonCode`                                 |
| ----------------------------------------------------------------------------------- | ----------------------------------------- | ----------- | -------------------------------------------- |
| Resume succeeded, or the human rejected (a recorded decision)                       | `humantask.resolved`                      | `completed` | none                                         |
| Resume failed (authorization denied, approval stale/missing, binding unresolved, …) | `humantask.resolved`                      | `failed`    | `record.errorCode`                           |
| Resume unsupported: task consumed, execution still `waiting_for_human`              | `humantask.resolved`                      | `failed`    | `XO_HITL_RESUME_UNSUPPORTED`                 |
| Not found / not a human task / already resolved / store error                       | `humantask.failed` (`humantask.denied`\*) | `failed`    | the existing codes (unchanged)               |
| Workflow segment ends `failed` / `rejected` / `interrupted` (`workflow.failed`)     | `workflow.failed`                         | `failed`    | `workflowExecution.errorCode`, when recorded |

\* `humantask.denied` is **reserved** (see taxonomy below).

Behaviour that is deliberately unchanged: a resolve whose resume fails is still HTTP 200 with the failed execution record,
the human task is still consumed (`humanTask.status: "resolved"`), and an `unsupported` resume still leaves the execution
`waiting_for_human`. Before F-1 the unsupported case was audited as `completed`; it is now `failed` (the event type is
unchanged).

**Limitation (deferred):** an approval denial at resume is stored — and therefore audited — as the coarse
`XO_RUNTIME_PERMISSION_DENIED`, because the approval gate returns a message only. The finer `APPROVAL_*` codes used at
execution start are not available at resume without changing the M3 gate's internal signature; that was out of scope.
`workflow.step.failed` carries no `reasonCode` (the step error code is on the workflow record).

## Event taxonomy: semantics and reserved types

`AUDIT_EVENT_TYPES` is a persisted-compatibility contract: `FileAuditStore` treats a stored line whose `type` is not in the
list as **corrupt**. No type is renamed or removed in P1.0; removal would make any such lines unreadable and requires a
`schemaVersion` decision.

| Type                                      | Status             | Meaning / caveat                                                                                                                                                                                          |
| ----------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authorization.denied`                    | emitted            | Emitted by execution preflight when the authorization check **errors** (outcome `failed`). It means "authorization could not be decided", not a confirmed permission denial. Name kept for compatibility. |
| `workflow.resumed`                        | emitted, defensive | The fallback for a segment that returns in a non-terminal, non-waiting status (reachability not proven). It is also the fallback after a start segment, so the name is imprecise.                         |
| `humantask.denied`                        | **reserved**       | Only referenced by a branch that cannot be hit today (store errors never carry a permission-denied code); a failed-resume denial is `humantask.resolved`/`failed` with a `reasonCode`.                    |
| `execution.attempted`, `workflow.started` | **reserved**       | Declared; no emitter in the repository and no consumer found (API, CLI, Environment Intelligence, docs, OpenAPI). Kept; removal only with a `schemaVersion` bump.                                         |

"Covered" in `apps/api/test/audit-event-coverage.test.ts` means a test drives an emitter and asserts the persisted event.
Types with no emitter are listed there explicitly as not emitted, and `authorization.denied` / `workflow.resumed` are listed
as emitted but without a direct test; reaching them was not forced.

## Known limits / unresolved decisions

- No tamper evidence (hash chain/signing): **accepted as a P1.0 limitation by the owner**; stronger protection needs a separate design decision (see "P1.0 owner dispositions").
- Local CLI runs are unaudited unless `XO_AUDIT_*` is set (the operator is a trusted local context, not a principal): accepted by the owner for P1.0.
- Legal retention periods are an operator/legal decision; none is supplied (ratified by the owner: explicit operator-configured retention, no invented default).
- `execution.started` precedes record creation, so it carries no `executionId`; join via `correlationId`.
- Approvals (P1.0 M3): `approval.attempted` is a durable precondition (no approval is stored without it), then `approval.granted`; refusals are `approval.denied`. A stale/legacy/foreign approval met at execution is `execution.denied` with reasonCode `APPROVAL_STALE` / `APPROVAL_LEGACY_UNBOUND` / `APPROVAL_MALFORMED` / `APPROVAL_TARGET_MISMATCH` / `APPROVAL_ATTRIBUTION_INVALID` / `APPROVAL_STATE_UNAVAILABLE` (a plain missing approval keeps `XO_RUNTIME_PERMISSION_DENIED`).
- Idempotency (P1.0 M6): `idempotency.replayed` (duplicate served from the original; durable precondition), `idempotency.recovered` (interrupted original adopted), `idempotency.conflict` (key reused with a different request), `idempotency.in_progress`, `idempotency.indeterminate` (interrupted, end unprovable, refused). `execution.started` carries `idempotent: true`, `keyRef` and, for a takeover, `takeover: true`. `keyRef` is a short digest; the key itself is never recorded.
