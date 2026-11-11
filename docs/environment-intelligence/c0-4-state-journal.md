# C0.4 — Durable EI lifecycle state (state journal)

Status: implemented (owner-approved scope); see the tests in `packages/environment-intelligence/test/state-journal.test.ts` and `packages/audit/test/creation-marker.test.ts`. Scope is durable **evidence-lifecycle state** only: the
`EvidenceLedger` entries and the `EnvironmentInventory` source state. Not in scope: evidence payloads or provenance,
purge execution, retention policy, application wiring, D2 tenant membership, platform-wide audit unification.

## Two stores, two authorities — and NO cross-store atomicity

| Store                    | Authoritative for                                                                             | Where                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Audit chain (C0.3)       | what happened and who did it                                                                  | `ChainedAuditStore`, `audit.chain.jsonl`                                                                 |
| **State journal** (C0.4) | the **current lifecycle state** (which evidence is eligible/revoked/purged; per-source state) | a **separate** `ChainedAuditStore` instance in its own directory, with the closed `x-ei-state` extension |

A write to the audit chain and a write to the state journal are **two independent durable writes. There is no
transaction and no atomicity across them.** Safety comes from a fixed ordering plus restart reconciliation, and every
crash window below leaves the system in a state that is **never more permissive** than the last confirmed fact.

The journal is a state store, not a second audit history: it never records who accessed what. It carries operation ids
and audit event ids only as cross-references, and `crossCheckState()` reports disagreements as findings (diagnostics, not authority).

## Outcome vocabulary (journal writes)

| Outcome           | Meaning                                                       | Caller must                                                                                                               |
| ----------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **confirmed**     | record written AND fsynced (or an exact duplicate of one)     | proceed                                                                                                                   |
| **rejected**      | definite refusal, nothing written (invalid, conflict, closed) | treat as failure; nothing to reconcile                                                                                    |
| **indeterminate** | the write may or may not have landed                          | stop; the store becomes **non-operational** until reopened and `start()`ed; retry by the same `operationId` after restart |

Every record has a deterministic idempotency key (`rel:<op>:<n>`, `qua:<op>:<n>`, `int:<op>`, `trn:<op>:<kind>`,
`src:<sourceId>:<rev>`), so a retry after restart returns the original record or writes it once; the same key with
different content is a conflict (never a silent overwrite).

## Fail-closed rule (owner decision 5)

The store is **operational** only after a successful `start()` (journal opened, whole chain verified, state restored,
unresolved intents reconciled, gate installed) and until any persistence failure, integrity failure, indeterminate write,
or close. While **not operational**: `EvidenceLedger.isEligible()` is false for **every** id (the ledger's eligibility
gate), protected EI operations (discover, declare, acquire, revoke, purge) are refused with `EI_STATE_UNAVAILABLE`
**before** any audit attempt or read, and there is **no memory-only fallback**.

## Crash / outcome matrix (A = audit-chain write, J = journal write, M = in-memory apply)

### Release (acquire)

Order: `A.attempt` → read → `A.terminal(completed)` → `J.release` → `M.ledger.release` (inside the same serialized section) → return evidence.

| Boundary                                               | Durable state afterwards                                             | Reconciliation                                                                                                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| crash after A.attempt, before A.terminal               | audit: open attempt. journal: nothing                                | evidence never released; retry with the same `operationId`                                                                                                       |
| A.terminal rejected / unconfirmed (existing C0.3 path) | journal: `quarantine` (best effort)                                  | evidence withheld (quarantined), unchanged behavior                                                                                                              |
| crash after A.terminal, before J.release               | audit: completed. journal: **nothing** → id unknown → **ineligible** | caller got nothing; `crossCheckState` reports `audited_not_released`; retry (A duplicates, J.release writes)                                                     |
| J.release **rejected**                                 | nothing; ledger not released; evidence quarantined in memory         | caller gets `EI_EVIDENCE_QUARANTINED`; store stays operational (nothing was written)                                                                             |
| J.release **indeterminate**                            | record may exist                                                     | store non-operational (all ineligible); after restart the record either exists (eligible but undelivered — harmless) or not (ineligible); retry by `operationId` |
| crash after J.release, before return                   | audit completed, journal released                                    | consistent; evidence eligible but undelivered                                                                                                                    |

Invariant: a journal `release` exists only if the matching audit `completed` was **confirmed first**. `crossCheckState`
flags the opposite (`released_without_audit`).

### Revoke

Order: `A.attempt` → `J.sync inventory` → `J.intent(revoke)` → `M.apply` → `J.transition(revoked)` + inventory snapshot → `A.terminal(revoked)`.

| Boundary                                                     | Durable state afterwards                                     | Reconciliation                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| crash after A.attempt, before J.intent                       | nothing changed; evidence still eligible; audit open attempt | the revoke never began; retry with the same `operationId`                                                                         |
| J.intent rejected / indeterminate                            | maybe an intent                                              | memory is revoked anyway (safe direction); caller gets `EI_STATE_UNAVAILABLE`; store non-operational if unavailable/indeterminate |
| crash after J.intent, before J.transition (includes M.apply) | intent only                                                  | **restart replays the unresolved intent as a revoke** and persists a `transition(recovered)`; evidence ineligible                 |
| J.transition indeterminate                                   | transition may exist                                         | non-operational; after restart either it exists or the intent replays — revoked either way                                        |
| crash after J.transition, before A.terminal                  | state revoked; audit open attempt                            | `crossCheckState` reports `applied_not_audited`; retry with the same `operationId` (revoke is idempotent)                         |
| A.terminal fails after J.transition                          | state revoked                                                | existing behavior: `EI_AUDIT_UNAVAILABLE` with `applied:true`                                                                     |

### Purge

Order: `A.attempt` → `J.intent(purge)` → revoke steps → `targets.purge(ids)` → `M.purge` → `J.transition(purged)` + snapshot → `A.terminal(purged)`.

| Boundary                                                   | Durable state afterwards                         | Reconciliation                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| crash after J.intent, before revoke journaled              | intent only                                      | replayed as a **revoke only** — recovery never marks anything purged                                                    |
| crash after revoke journaled, during/after `targets.purge` | revoked; `purgeRequired` true; purge intent open | targets may have deleted; retry with the same `operationId` re-runs targets (their contract is idempotent), then purges |
| crash after M.purge, before J.transition(purged)           | revoked (conservative)                           | retry completes                                                                                                         |
| J.transition(purged) indeterminate                         | revoked or purged, both ineligible               | non-operational; retry after restart                                                                                    |
| crash after J.transition(purged), before A.terminal        | purged; audit open attempt                       | `applied_not_audited`; retry                                                                                            |

`purged` is journaled only after every target's `purge()` resolved.

### Inventory mutation (discover / declare)

The core mutates memory; the wrapper then **diffs** the inventory against the last persisted snapshots and writes one
`source` snapshot per changed source (`src:<sourceId>:<rev>`). A crash between loses that call's inventory progress:
restart restores the **previous** snapshot, i.e. an equal-or-lesser state (for example `authz=granted` is lost, so acquire
is refused until re-discovery). A snapshot failure returns `EI_STATE_UNAVAILABLE`. Inventory never affects eligibility;
only the ledger does.

## Recovery of the journal file itself

| Situation                             | Behavior                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| partial final record                  | cut back and recorded as a `recovery` record (C0.3)                                      |
| corrupt/tampered record, gap, reorder | `AUDIT_CORRUPT` → `start()` fails → **non-operational**; operator action                 |
| failed fsync / indeterminate write    | instance poisoned; reopen verifies and fsyncs everything first (C0.3)                    |
| stale lock / leftover takeover guard  | C0.3 behavior (takeover only if owner provably dead; a leftover guard needs an operator) |
| crash during initial header creation  | recovered **only** under the creation marker (below); otherwise operator action          |

**Header-only torn recovery (owner decision 4).** The journal is opened with `creationMarker: true`. Before the first
header write a marker file (`audit.chain.init`) is created and fsynced; it is removed only after the header is written and
fsynced and the directory is synced. A non-empty log with **no complete record** is recovered as fresh **only if the marker is
present**. Proof that nothing is discarded (crash model): acknowledgement requires a complete, fsynced line; state records
are only appended after `open()` returns, which is after the marker is removed. So marker present ⇒ no acknowledged record
and no valid state record can exist. Marker absent + torn/short file ⇒ `AUDIT_CORRUPT`, operator intervention. A local
attacker who can write the directory can also forge the marker; this is inside the documented local-chain limitation
(tamper-evident, not tamper-proof), not a new guarantee.

## What is persisted (and what is not)

- Ledger entries: evidence id, state, source id, operation id. Inventory: source id, source type, connector ids,
  detected/first/last-seen times, identity fingerprint and last-scan fingerprint (digests), lifecycle axes, counters,
  `purgeRequired`, `changedSinceLastScan`, and only the **code and retryable flag** of the last error.
- **Never persisted:** `locator`, `displayName`, error messages or contexts, transition history, evidence payloads,
  provenance, principals' details beyond the audit-style actor id. After a restart `locator` and `displayName` are
  empty until the next detection re-observes the source; the environment model reflects that.
- Schema: closed, bounded, typed `x-ei-state` extension; the global secret filter applies; persisted records are
  re-validated on every open/read.

## Security

Writes require the authenticated principal (`AuditTrust`), bound exactly as in the audit adapter; reading state
(`start(grant)`) needs a single-use `read` grant; the journal exposes no append surface to callers.

## Observability

`diagnostics()` returns only: status code, record/event counts, journal head hash, ledger counts by state, number and
ids of unresolved intents, last load outcome code, recovery count. No paths, payloads, ids of evidence, messages or tokens.

## Limitations

Single host, local filesystem, one writer (C0.3 scope). Tamper-evident, not tamper-proof; no external anchoring. No
atomicity across the audit chain and the state journal. Transition history is not durable (the audit chain is the authority
for what happened). EI is not yet composed into an application.

## Implementation notes (as built)

- `EiStateStore` (`src/state-journal.ts`) wraps a dedicated `ChainedAuditStore` opened with `creationMarker: true` and the closed
  `x-ei-state` schema. Every state write is `append → confirmed | rejected | indeterminate`; only a definite content rejection
  (invalid/conflict) leaves the store operational. Unavailable storage, integrity failure and an unconfirmed write make it
  non-operational.
- Journal order equals in-memory apply order: each ledger mutation runs inside one serialized section (journal first for
  `release`; memory first for `revoke`/`purge`/`quarantine`, the safe direction).
- `ConnectorContext.state` is optional. With none configured, ledger, inventory and every EI operation behave exactly as before.
  With one configured, `ctx.ledger` must be the ledger the store was started with, and a non-operational store is refused
  before any audit attempt (`beginAudit`), lookup, or read.
- `count`, `recovered` and `auditEventId` are volatile fields (excluded from record identity) so an idempotent retry that
  differs only in them is a duplicate, not a conflict. Everything else about a record must match.
- Persisted ids must satisfy the platform filters (identifiers up to 128 characters for idempotency keys, no secret-shaped
  values). An unrepresentable id is **refused** (the write is rejected), never truncated.
- A journal failure during `revoke`/`purge` leaves the audit **attempt open** (no terminal event) so a retry with the same
  `operationId` can complete it; it is not recorded as `failed`.
- `ChainedAuditStore.creationMarker` (`@xo/audit`) is the only change to C0.3 code and is **off by default**: C0.3 behaviour is unchanged
  unless a store opts in.

## Owner-review hardening: decisions and final invariants

### Decision 1 — the audit attempt is left OPEN when the state journal fails

**Rule.** When a journal write for a revoke or purge is rejected, unconfirmed or indeterminate, the operation returns
`EI_STATE_UNAVAILABLE` and records **no terminal audit event** (the write-ahead attempt stays open). It is _not_ recorded as `failed`.

**Why.** A journal write whose outcome is unknown may have landed. After a restart an intent that landed is **replayed as a
revoke**. A `failed` terminal would then contradict the durable state (revoked), and — because an operation has exactly one
terminal event — would also block the retry that can finish the operation. An open attempt honestly means "unknown", and the audit
chain already surfaces it (`openAttempts`).

**A definite failure of a purge holder is different** and behaves exactly as without a durable store: the state is known
(revoked, not purged), so it is audited as `failed`.

**Invariants (each is a test in `state-hardening.test.ts`, run against a real audit chain and a real journal):**

1. _No duplicate events._ A retry with the same `operationId` — in the same process or after a restart of both stores — produces
   exactly one attempt and exactly one terminal event (idempotent attempt/intent/transition/terminal keys).
2. _No false success._ A call whose journal write was rejected, unconfirmed or indeterminate is never reported as `ok`, and a
   completed-journal-but-failed-audit call is `AUDIT_UNAVAILABLE`, never `ok`.
3. _Never more permissive than the last confirmed fact._ Revoke is applied in memory before it is journaled; an intent that
   landed is replayed as a revoke; while the store is non-operational nothing is eligible.
4. _Revoked evidence cannot be released again by a retry._ An exact duplicate of a release is never re-applied; if any of its evidence
   is no longer `released` the retry is **withheld** (`rejected`). This was a real defect found in this pass.
5. _No purge claim before every holder deleted._ `purged` is journaled only after every holder's `purge()` resolved; a failing holder
   leaves the evidence `revoked` with `purgeRequired` still set; a recovered purge **intent** is replayed as a revoke only.
6. _Recovery never infers success from an open audit attempt._ `start()` never reads the audit chain to decide state; only durable
   journal records drive recovery. An open attempt with no journal intent changes nothing (the evidence stays exactly as the journal says).
7. _A rejected request changes nothing._ A definitely-rejected intent does not revoke anything in memory (a request for the wrong
   source cannot revoke another source). A transition that is rejected **after** the in-memory apply poisons the store, so memory is never silently
   ahead of the journal while "operational".
8. _Disagreement fails closed — when audit evidence is supplied._ `start({ audit })` refuses to become operational (`disagreement`) on a
   **dangerous** finding: `released_without_audit` (an eligibility grant nobody audited) or `audited_not_applied` (an audited revoke/purge missing from the
   journal, i.e. a journal rolled back to an earlier valid prefix). The benign crash windows (`audited_not_released`, `applied_not_audited`)
   are reported by `crossCheckState` but never block.

### Decision 2 — malformed ("path-like") ids are rejected, never normalized or truncated

**The ID contract.** `[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}` — the same pattern as EI's audit normalization (`SAFE_ID`) and the platform
extension `id` kind. Operation and source ids are additionally limited to 100 characters so every idempotency key stays within the platform's
128 characters. EI **never** normalizes or truncates evidence, operation or source ids (the hash-mapping `safeIdentifier` exists only for log-safe
display fields), so rejecting a malformed id is the existing EI behavior, not a new rule.

**Behavior.**

- Every `EiStateStore` mutation validates its ids **first**, before any ledger, inventory or journal change, and answers with the fixed
  `EI_STATE_UNAVAILABLE` / `outcome: rejected` error. The store **stays operational**: bad input is not a persistence failure. (Before this pass a rejected release
  still _quarantined the malformed id into the ledger_; a test reproduced that.)
- `beginAudit` refuses a malformed caller-supplied `operationId` before anything else and does **not echo it** (the context carries a
  fixed placeholder). Before this pass the `EI_AUDIT_UNAVAILABLE` context echoed the raw value, unbounded (510 characters for a 300-character
  input). The error **code** is unchanged.
- Errors are bounded (fixed messages; context limited to `phase`/`outcome`) and never contain the offending value.
- `quarantine` is journaled **completely**, chunked 5000 ids per record. Before this pass it silently kept only the first 5000 per source.
  Duplicate ids within one call are de-duplicated (never dropped otherwise); valid ids round-trip byte for byte.

### Unresolved limitations (do not read the above as more than it is)

- The disagreement check needs the caller to **supply audit events** to `start`; nothing does so automatically, and nothing in the repo composes it.
  Without them, a journal rolled back to a valid earlier prefix is **not detectable** (the local-chain limitation).
- A journal failure during revoke/purge leaves an **open attempt** that needs a same-`operationId` retry or an operator; nothing closes it automatically.
- A completed purge whose holders deleted copies but whose `purged` write was lost is reported as `revoked` after restart until the retry re-asks the holders.
- Same limits as C0.3: tamper-evident, not tamper-proof; no external anchoring; single host / local filesystem; no atomicity across the audit chain and the journal.

## Final owner review: reconciliation coverage, recovery, and operator procedure

### Who calls `start()`, and who supplies audit events

| Caller                                             | Supplies `audit` events?                                                                                                         | Result                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Production / application code                      | **None exists.** EI is not imported by any app or package, so no production-facing caller of `EiStateStore.start()` exists today | n/a                                                        |
| `state-hardening.test.ts` (two disagreement tests) | yes                                                                                                                              | a dangerous disagreement refuses to start (`disagreement`) |
| every other test caller                            | no                                                                                                                               | no cross-check; the store starts operational               |

**Omission disables disagreement detection; it does not fail closed.** `start()` without `audit` verifies the journal's own chain and integrity
but cannot notice a journal that was rolled back to a valid earlier prefix, or a release nobody audited. This is a documented limit, and it is
the one open composition decision: whoever first wires EI into an application must either read the audit chain (with its own grant) and pass the
events to `start`, or consciously accept that limit. Doing this automatically would require `start()` to read the audit chain, i.e. a new
dependency and a new API contract, so it is **deferred to the EI composition milestone** (see below). No cross-store atomicity is claimed either way.

### Owner decision: the required-`audit` signature is DEFERRED to the EI composition milestone

The breaking change below was reviewed and **deliberately deferred**. `start({ audit })` therefore stays optional in C0.4, and the limitation above
stays in force and documented: **without audit events there is no rollback or disagreement detection**.

**Requirement at composition time.** When EI is first composed into an application:

1. Wherever rollback/disagreement detection is required, the composition root MUST read the audit chain (with its own read grant) and pass the
   events to `start({ audit })`. A dangerous disagreement then refuses to start (`disagreement`).
2. Any deliberately unverified start MUST be explicit and documented at the call site (not an omission), with its limitation recorded.
3. The signature change below is the intended way to make that choice impossible to omit; it is a breaking change to `start()` and belongs to that milestone.

```diff
-    audit?: readonly AuditEvent[];
+    /** REQUIRED. Pass the audit events to cross-check, or 'unverified' to start WITHOUT audit cross-checking (documented limit). */
+    audit: readonly AuditEvent[] | 'unverified';
```

No cross-store atomicity is claimed in either mode.

### Exact outcomes and retries (revoke / purge / release)

| Situation                                     | Durable state                              | Audit chain                             | Reported to caller                                                                | Retry with the same `operationId`                                                                                    |
| --------------------------------------------- | ------------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Intent write rejected (definite)              | unchanged                                  | attempt open                            | `EI_STATE_UNAVAILABLE` (`rejected`); **nothing mutated**, store stays operational | idempotent; completes                                                                                                |
| Intent write unconfirmed / indeterminate      | intent may exist                           | attempt open, **no terminal**           | `EI_STATE_UNAVAILABLE`; store non-operational, nothing eligible                   | after restart: an intent that landed is replayed as a revoke; completes with one terminal                            |
| Transition write indeterminate                | transition may exist                       | attempt open, no terminal               | `EI_STATE_UNAVAILABLE`; memory already revoked                                    | after restart revoked either way; completes                                                                          |
| Transition rejected after the in-memory apply | not written                                | attempt open                            | error; store **poisoned** (memory ahead of journal)                               | after restart journal is the truth; retry completes                                                                  |
| Inventory snapshot lost after the transition  | ledger transition present, snapshot absent | n/a                                     | error; store non-operational                                                      | **restart re-applies the transition to the inventory** (revoked axis + purge obligation) and journals the correction |
| Purge holder fails                            | revoked, **not purged**                    | `failed` terminal (unchanged behaviour) | error                                                                             | a failed terminal is final for that operation: use a **new** `operationId`                                           |
| `purged` write fails / indeterminate          | revoked (or purged if it landed)           | attempt open, no terminal               | `EI_STATE_UNAVAILABLE`                                                            | holders are asked **again**, then `purged` is written; terminal recorded once                                        |
| Duplicate release of since-revoked evidence   | unchanged                                  | n/a                                     | **withheld** (`rejected`)                                                         | n/a — evidence is not re-released                                                                                    |

**External-effect duplication.** The only external effect is `target.purge(ids)` on the holders. It is invoked once per attempt, **before** `purged`
is journaled, and again on a retry whenever the previous attempt did not end with a confirmed `purged` record. Holders MUST therefore be
idempotent. That is the existing `PurgeTarget` contract ("resolves only once the copies are gone"), and C0.4 does not add automatic retries.

**Could anything report confirmed success without durable confirmation?** No path found: `release` returns `ok` only after every chunk is a confirmed
append or an exact duplicate of a durable record; `beginLifecycle` after the intent; `applyRevoke`/`applyPurge` after the transition **and** the snapshot;
the lifecycle result only after the audit terminal. The one deliberate asymmetry: for `discover`/`acquire` the audit **completion** is confirmed
_before_ the release is journaled (a journaled release must follow a confirmed audited completion), so a journal failure there leaves
audit=`completed` and the evidence **withheld**. The terminal says the acquisition completed, not that anything was released;
`crossCheckState` reports it as the benign `audited_not_released`.

### Operator procedure (what automation does not do)

1. **Detect.** `diagnostics().status` other than `operational`; `openIntents` not empty; audit chain `openAttempts()` for revoke/purge operations.
2. **Never edit the journal or the audit log by hand, and never delete a lock/marker you cannot explain.**
3. **`start()` failed:** `corrupt` — stop, preserve the files, restore from a verified backup; `locked` — find the other writer (a leftover
   `audit.chain.lock.takeover` guard from a crash needs an operator); `disagreement` — the journal and the audit chain contradict each other in
   the dangerous direction: investigate before serving anything; `denied` — the read grant was refused.
4. **An open revoke/purge attempt:** re-run the SAME operation with the SAME `operationId`. It is idempotent end to end and completes with exactly one
   terminal event. For purge, confirm the holders are idempotent first.
5. **After a purge whose holders deleted copies but whose `purged` write was lost:** state reads `revoked` with the purge obligation still set until the
   retry succeeds; the evidence stays ineligible throughout.
6. **No automatic closing of open attempts exists**, by design: an open attempt means "outcome unknown".

### Defects found in this review and fixed

- **Lost inventory snapshot** after a journaled transition left the source `granted` with no purge obligation after restart (acquisition requires
  `granted`). Recovery now re-applies the transition unless a later snapshot supersedes it (`R1` tests incl. the re-authorization negative control).
- **Operation ids of 101–119 characters** were accepted by audit but could not be keyed by the journal: an unfinishable open attempt. Refused before
  any audit attempt when a store is configured (`R2`).
- **A declared source with an unrepresentable id** entered the inventory and then wedged every later sync. Refused before it enters (`R3`).
- **Structural memory-only fallback** in the purge branch (unreachable, but dependent on an earlier return) removed.
