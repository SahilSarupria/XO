# XO P1.0 M4 — Durable Audit: guarantees, failure semantics, operations

Status: implemented, **pending owner acceptance** (not accepted).

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

## Known limits / unresolved decisions

- No tamper evidence (hash chain/signing) — a separate design decision.
- Local CLI runs are unaudited unless `XO_AUDIT_*` is set (the operator is a trusted local context, not a principal).
- Legal retention periods are an operator/legal decision; none is supplied.
- `execution.started` precedes record creation, so it carries no `executionId`; join via `correlationId`.
