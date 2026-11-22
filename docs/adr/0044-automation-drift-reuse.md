# 0044: Automation, drift and reuse (UW-15)

## Status

Accepted under owner delegation, 2026-11-20 (UW-15, wave W3). Signed off by Claude under the owner's delegation of decision
authority. This is a delegated sign-off, not an independent review.

**Amended 2026-11-22 under the owner's delegation:** the API's schedules now run on the `AutomationEngine` (item 4). Webhooks stay on
the API route, sharing the same policy layer (item 4a). The original version of this ADR left both undone.

## Context (audit)

- `packages/automation` (`AutomationEngine`, ledger, at-most-once keys, exclusive directory lock, `ScheduleTrigger`, `CronTrigger`) is used by
  the CLI desk and ab-eval. The API never runs it. The API's schedules, webhooks and certified triggers run through
  `workflow-controls/scheduler.ts` (a 30 s timer), `certified-trigger.ts` and `startGated`.
- The engine takes its workflow list at construction, writes its own ledger and takes a directory lock meant for one CLI process; the API's
  deployments change at runtime and its runs are journalled by the workflow runtime. The scheduler also does source-connection syncs and
  token-vault sweeps in the same tick, which are not triggers.
- The scheduler promised: one process only, no catch-up, "at least N minutes since the last slot".

## Decisions

### Trigger unification: what was and was not done

1. **Done: one slot function.** A parity test (`packages/automation/test/slots.test.ts`) shows the API's idempotency slot
   (`floor(now / (everyMinutes * 60000))`) equals the slot in the engine's `ScheduleTrigger` key for the same instants. The existing scheduler
   tests (`workflow-controls`, `composed-runner-retirement`, source-connection syncs) pass unchanged.
2. **Done: leases.** `LeaseStore` interface in `@xo/automation` with `MemoryLeaseStore` and `SqliteLeaseStore` (Node's built-in `node:sqlite`, one
   file `scheduler-lease.sqlite` in the instance data directory; `BEGIN IMMEDIATE`, expiry, a fence that grows when the holder changes).
   `tickWithLease` makes only the holder fire; `startScheduler` releases it on stop. A takeover after expiry is tested.
3. **Done: defined missed-slot behaviour.** `missedSlotPlan` and the setting `XO_SCHEDULE_MISSED_SLOTS` (`run_latest` default, `skip`).
   Missed slots are those strictly between the last fired slot and the current one. `run_latest` runs only the latest missed slot, if it ended within 24
   hours (its slot is the idempotency key), and records the others as `skipped: missed N earlier slots` in `lastOutcome` and the audit detail;
   `skip` runs none and resumes from now. On time or one slot late nothing is missed, so existing behaviour is unchanged.
4. **Done (amended): schedules run on the engine.** The API tick keeps its clock, its lease, and the source-sync and vault sweeps (maintenance,
   not triggers). What is due becomes one `TickTrigger` event per slot, emitted into a single engine (workflow `schedule`) in
   `<data directory>/automation/schedules/`. The event carries ids and counts only, and is keyed
   `<workspace>/<compilation>/<workflow>@<N>m:<slot>`. The engine's handler fires the slot through the existing policy layer: the controls
   (modes, daily cap, pause, sign-off) for uncertified starts, and `startCertifiedTrigger` with the slot key for certified ones (ADR 0035
   unchanged). What this adds over the old direct firing:
   - **At most once per slot, across restarts.** The keys are rebuilt from the engine's hash-chained ledger. Before, an uncertified schedule
     relied on the lease alone.
   - **A ledger of every fire.**
   - **Bounded intake.**
   - **Recovery of a slot accepted just before a crash.** It is the same at-least-once window as before: a crash between start and record
     refired before too.

   Settings: `concurrency: 1` and `maxAttempts: 1`, as before (in order, never retried in a loop); `outbox: false`, a new engine option,
   because outcomes are recorded on the deployment and in the audit log.

   **Two processes:** the engine's directory lock is held only by the lease holder. A tick without the lease stops its engine, freeing the
   lock. If another live process holds the lock, the tick fires nothing and logs it.

   **Parity:** every earlier scheduler test passes unchanged (`scheduler-slots`, `workflow-controls`, `composed-runner-retirement`,
   source-connection syncs). New tests cover the ledger, refiring after a restart and the lock. The old direct-firing loop is removed;
   `runDueSchedules`, `tickWithLease` and `startScheduler` keep their signatures.
   4a. **Webhooks stay on the API route.** The engine's `WebhookTrigger` is its own HTTP server, outside the API's authentication, rate limits
   and routing, so it cannot take the API's webhook route without weakening it. The route keeps calling the same policy layer
   (`startGated` / `startCertifiedTrigger`), and certified webhooks are keyed by the caller's idempotency key (ADR 0035). This is the one case
   kept outside the engine, as the owner's decision allows.

### Drift (UAC-34)

5. `detectDrift` (`packages/pre-execution/src/drift.ts`) compares a compiled table's fingerprint with an incoming one. Header names are trimmed,
   whitespace-collapsed and case-folded; order is ignored. Per column it compares the declared type and the **value shape** (letters collapse to `a`/`A`,
   each digit is `9`, other characters stay; a column's shape counts only when at least 80% of at least three filled cells share it).
   Blocking: a used column missing (with the new name suggested when exactly one new column has the same type and shape), retyped, or reformatted.
   Warning: a new column nothing uses. A used-column list may restrict the check (default: every compiled column).
6. `checkDataDrift` (API) compares each `.csv`/`.xlsx` the compilation was built from, as compiled, with the **newest same-named source** in the workspace;
   no baseline is stored. `startGeneratedRun` (the one function manual, webhook and schedule starts share) refuses a blocking result with
   `409 XO_DATA_SCHEMA_DRIFT` (new error code) **before a run record or any effect exists**, with the report in the error context; the refusal is audited as
   `generated-workflow.drift.refused` with counts only. `GET /workspaces/{ws}/compilations/{cid}/data-drift` previews the same check.
   Reports carry headers, types and shapes, never cell values (a shape such as `A-999` does describe how values are written).
7. **Tables a workflow reads (amended 2026-11-22 under the owner's delegation).** A compilation in the API has one source, so a workflow compiled
   from a procedure document was not tied to the workbooks its steps read. Generation (`…/generated-workflows` and the UW-2 workflow-entity create
   and revise) now takes `reads: [{ sourceId, recordSetId }]` (at most 20; each must be a current `.csv`/`.xlsx` table). Each table's schema
   fingerprint is recorded on the definition (`dataReads`), the reads are part of the definition id and the reuse key, and the start gate checks
   them against the newest same-named source exactly like the compilation's own tables; a table that is gone blocks. Declaring the reads is explicit
   for now: the UW-8 batch preview will fill them from the list a person picks (a confirmed source role).

### Reuse

8. Reuse key = sha256 of the goal digest, the compiled-schema digest, the capability-catalogue version, **plus the compilation id, the connector bindings
   and an explicit workflow choice** (stricter than the handoff's goal + schema + catalogue: a definition is bound to its compilation, and its lowering depends
   on the bindings). An index (`definition-reuse/<key>.json`) maps the key to the definition; a hit is used only if the stored definition exists, is for the same compilation
   and still has the digest it was indexed with. Responses say `reused: true|false`. A drift gate still applies to a reused definition at start.
   Cross-compilation reuse is **not** done: a definition's certificates and approvals are tied to its compilation.

### Exceptions (UAC-36)

9. `GET /workspaces/{ws}/generated-workflows/{id}/exceptions` (read role): over 30 days, runs, runs that asked for an approval or escalated, the share, and for fan-out runs
   the items and the share that needed a person (distinct steps named by those events, out of the fan-out count); `queue` lists only what is open (approvals not yet decided,
   escalations), oldest first. Computed from the run journals; counts, ids and step names only. There is no Studio screen.

## Consequences

- Two processes on one machine now cannot both fire; processes on different machines sharing a network directory are not covered (SQLite file locking over
  network filesystems is unreliable): a distributed lease must implement `LeaseStore`.
- `node:sqlite` is experimental in Node 22 (a warning is printed); the repository already depends on it (`knowledge-base`).
- Item-level exception accounting is approximate: it counts distinct steps named by approval and escalation events, not a per-item identity.

## Reopen if

- Webhooks need the engine's ledger or bounds (item 4a): emit them as `TickTrigger` events from the route.
- The engine's ledger grows by one entry per fired slot and is never compacted; add compaction if it becomes large.
- Real workbooks show the 80% shape rule is too strict or too loose (amounts of varying width have no dominant shape and are never format-checked).
- UW-8 picks the list for a batch: fill `reads` from it automatically.
