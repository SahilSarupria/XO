# P1.1 M4 — external_tool execution: implementation status (durable evidence + reconciliation slice)

Date: 2026-10-23. Branch `p11/m4-external-tool`. Base head at start of this slice: `15cb969` (verified by clone). PR #7 is reported open/draft/unmerged — **not verifiable from this environment** (no PR/CI API access was used). Nothing was pushed, merged or opened by this slice or by the follow-up finalization slice (§10). Local commits: `f4c30b3` (ledger + reconciliation), `6e870d9` (this doc, first version), `063e8d9` (finalization code, §10); `25410e4` (§10 doc), `172e8d6` (closure code, §11); `35be200` (§11 doc), `6cfd2ae` (approval modes + payload approval, §12); the §12 doc update is the next commit.

NOTE ON THIS FILE. `P11_M3_CLOSEOUT_RECORD.md` points to `claude/P11_M4_O7_CORE_IMPLEMENTATION_STATUS.md` as the M4 status document, but that file does **not exist** on `p11/m4-external-tool` at `15cb969` (nor in any branch fetched). It is created here, covering only what this slice can verify. Earlier M4 history is in commits `043317f`, `1878ab8`, `78a6571`.

M3 disposition (scheduling decision, not acceptance or waiver): all remaining M3 acceptance/closeout is deferred to the end of P1.1. M3 is **not** accepted; PR #6 is untouched; `P11_M3_CLOSEOUT_RECORD.md` is untouched. This slice depends on M3 only through what is already merged into this branch (`15cb969` merges `p11/m3-closeout`).

## 1. What changed

| Area                                     | Change                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@xo/adapters` `contract.ts`             | `DispatchLedger` is now sync-or-async; evidence carries `recordedAt`, `inputFingerprint` (SHA-256 of canonical input; the input itself is never stored) and an optional `reconciliation` record; new optional atomic ops `claim` (create-if-absent) and `appendAfter` (compare-and-append). `InMemoryDispatchLedger` keeps working and is documented volatile/test-only. |
| `@xo/adapters` `blob-ledger.ts` (new)    | `BlobDispatchLedger`: durable append-only ledger over the repo's existing `AtomicBlobStore` (`putIfAbsent`). No new infrastructure dependency.                                                                                                                                                                                                                           |
| `@xo/adapters` `dispatcher.ts`           | Write-ahead evidence now uses atomic `claim`; a lost claim means **no dispatch**. Terminal result uses compare-and-append; if the evidence moved meanwhile, both accounts are kept and the result is reported `outcome_unknown`. Exposes `evidenceFor` and `reconcile`.                                                                                                  |
| `@xo/adapters` `reconciliation.ts` (new) | `reconcileDispatch`: the only way to settle an unsettled dispatch. Never calls an adapter, never redispatches, never deletes/rewrites.                                                                                                                                                                                                                                   |
| `@xo/runtime` `external-tool-binding.ts` | `ExternalToolWiring` exposes `evidenceFor` / `reconcile` (additive).                                                                                                                                                                                                                                                                                                     |
| `apps/api` `procedure-routes.ts`         | `GET .../procedure-executions/:id/steps/:stepId/external-effect` and `POST .../external-effect/reconcile`.                                                                                                                                                                                                                                                               |

## 2. Durable evidence: data flow

1. Runner derives `dispatchKey = <procedureExecutionId>:<stepId>` server-side (unchanged from earlier M4; never client-supplied).
2. After authorization, approval freshness (adapter id + input schema are in the approval digest) and input validation, the dispatcher checks the key's evidence and the capability's unsettled evidence (fail closed if unreadable/corrupt).
3. `claim` writes `dispatch_attempted` (with input fingerprint) as `external-effects/events/<sha256(key)>/0000000001.json` via `putIfAbsent`. Exactly one concurrent caller wins. Only the winner calls the adapter.
4. Terminal state (`confirmed_success` | `confirmed_failure_no_effect` | `outcome_unknown`) is appended as seq 2 by compare-and-append.
5. Reconciliation appends a further entry (seq 3+) with actor, reason, evidence examined, decision, server timestamp.

Layout: `external-effects/events/<sha256(dispatchKey)>/<seq:10>.json` (immutable entries) and `external-effects/by-capability/<sha256(capabilityId)>/<sha256(dispatchKey)>.json` (index marker, written before the claim). Evidence is read back strictly: unknown fields, gaps, wrong key/seq, bad JSON ⇒ throws ⇒ dispatcher refuses (`ledger_unavailable`). Staging `*.tmp` files left by an in-flight or crashed writer are ignored (only `.json` entries count).

## 3. Guarantees and limits (read before any production claim)

Guaranteed (as tested):

- Evidence is on disk **before** the adapter is called; if it cannot be written, the adapter is not called.
- One dispatch per key, across restarts and across concurrent workers sharing the store.
- An unsettled dispatch (`dispatch_attempted` without terminal, or `outcome_unknown`) blocks that key **and every other key for the same capability** until reconciled, across restarts.
- A result that cannot be recorded is reported `outcome_unknown`, never success; the write-ahead entry stays, so it remains blocked.
- No automatic retry exists anywhere.

NOT guaranteed:

- **Not exactly-once.** A crash after the external system acts but before XO records a result leaves `dispatch_attempted`; XO cannot know the outcome. This is surfaced as blocked + reconciliation required, never as success or failure.
- **Idempotency keys / status lookup.** The adapter receives the server-derived `dispatchKey` and may pass it to a target that supports idempotency keys; no adapter in this repo does, and XO does not rely on it. Where the target offers authoritative status lookup, a human uses it as the "evidence examined" in reconciliation. Automated lookup is not implemented.
- **Cross-host atomicity.** `LocalFsBlobStore.putIfAbsent` is atomic across processes on **one filesystem** only (hard-link create). A multi-host deployment needs an `AtomicBlobStore` with linearizable conditional create (e.g. Postgres unique key). No such store exists in this repo yet; this is a deployment blocker for multi-worker production.
- No lease/lock: a crash cannot leave anything locked, but a hung adapter call keeps its key `dispatch_attempted` until a human reconciles.
- No retention/purge: evidence is never deleted by this code. Retention is operator-controlled and report-only (§10.4).
- Ledger is separate from the audit trail; audit events cover the reconciliation request, not each ledger entry.
- Wiring is host-programmatic: `server.ts` takes `externalTools` as an injected dependency. **No shipped entrypoint enables external tools** (`apps/api/src/index.ts` does not pass `externalTools`). §10.1 enforces durability at the construction boundaries that do exist.

## 4. Dispatch identity and duplicate prevention

Identity = `<procedureExecutionId>:<stepId>`, minted by the server. Same identity ⇒ never dispatched twice (success, failure, unknown alike). A new execution is a new identity and re-runs approval, authorization and input checks. Replaying an HTTP request does not dispatch (the identity already has evidence).

## 5. Reconciliation (delegated design decision of this slice)

These semantics are **this slice's design**, not a verified requirement: the governing texts (O-2, O-3/Review §5.3, N-3, E-1–E-9) are unavailable.

- Endpoint: `POST /workspaces/:ws/procedure-executions/:id/steps/:stepId/external-effect/reconcile`, body `{decision, reason, evidenceExamined?}` (closed schema; any actor/identity/dispatchKey/authority field ⇒ 400).
- Authorization: workspace ownership (uniform 404 otherwise); **authenticated human principal only** (service ⇒ 403, audited); **superseded in §10.2: now the dedicated `effect.reconcile` permission, not `procedure.approve`.** Actor identity comes from the authenticated principal.
- Audit: durable `procedure.attempted` precondition (if unconfirmed ⇒ 503, nothing reconciled); denials audited as `procedure.denied`. The ledger entry itself records actor, timestamp, reason, evidence, decision.
- Decisions: `confirmed_success` / `confirmed_failure_no_effect` (both require non-empty evidence examined; settle the key) and `unresolved` (recorded, settles nothing, key stays blocked). Unknown key ⇒ 404 (absence of evidence is not proof).
- Idempotent/concurrent-safe: identical repeat ⇒ `already_resolved`; contradicting a settled key ⇒ 409; concurrent callers race on compare-and-append, one `recorded`.
- **No redispatch from reconciliation.** Response always says `redispatchPermitted: false`. Even `confirmed_failure_no_effect` only unblocks the _capability_; the same key stays refused; a retry must be a new execution (new identity, new approval-freshness/authorization/input checks). Fresh human approval for that new attempt is now required (§10.3).
- Manual process when the target offers no authoritative evidence: record `unresolved` with the reason; the dispatch stays blocked indefinitely. There is no "force clear" path by design.

## 6. Crash windows (all tested against real files)

| Window                                             | Behaviour                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| Evidence write fails before dispatch               | adapter not called; step fails closed                                            |
| Crash/hang after write-ahead, before result        | key + capability blocked after restart; needs reconciliation                     |
| Adapter acted, reply lost (`outcome_unknown`)      | durable unknown; blocked across restarts                                         |
| Result write fails after adapter ran               | reported unknown; write-ahead entry keeps it blocked                             |
| Reconciliation lands while adapter still in flight | both entries kept; adapter result reported `outcome_unknown` (accounts conflict) |
| Corrupt/gapped evidence                            | dispatcher refuses; nothing dispatched                                           |
| Orphan `.tmp` from a crashed writer                | ignored                                                                          |

## 7. Tests (local only)

Environment: Node v22.22.0, npm 10.9.4, `npm ci --ignore-scripts`, `npx tsc -b tsconfig.json` exit 0.

| Command                                                                               | Result                                                                                               |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `cd packages/adapters && npm test`                                                    | 28 tests, 28 pass (10 pre-existing + 18 new durable-ledger); run 5×, stable                          |
| `cd packages/runtime && npm test`                                                     | 484 / 484 pass                                                                                       |
| `cd apps/api && npm test`                                                             | 422 / 422 pass (410 baseline + 12 new `external-effect-durable-m4.test.ts`); new file run 3×, stable |
| `cd apps/cli && npm test`                                                             | 287 / 287 pass                                                                                       |
| `npx eslint <changed paths> --max-warnings=0`; `npx prettier --check <changed paths>` | clean                                                                                                |

Baseline before any change: adapters 10/10, API 410/410. No skips anywhere. Not run: full-repo `npm test`/`lint` across every workspace, and any remote CI. A mutation check (disabling atomic `claim`) made the concurrent-workers test fail, then it was restored.

Coverage of the 21 required scenarios: 1–9 and 21 in `packages/adapters/test/durable-ledger.test.ts` and the API durable file; 10–13 and 19–20 by the pre-existing M4 suites (re-run green: zero adapter calls on invalid input, denied actor, stale approval/schema change, missing config, standard-binding conflict); 14–18 by reconciliation tests in both new files (success/failure/unresolved, unauthorized refused and audited, idempotent/concurrent).

## 8. Open items and blockers

Unavailable specs (not invented): O-2 (authoritative effect classification — the existing delegated design decision stands as a design decision only), O-3/Review §5.3 (state definitions; this slice uses only the names already in `contract.ts` and defines **no** transition table beyond "settled/unsettled"), N-3, E-1–E-9, O-4. No compliance with any of them is claimed.

Owner decisions needed: (a) whether `confirmed_failure_no_effect` should require a fresh human approval before a new attempt; (b) reconciler authority (currently `procedure.approve` + human) — a dedicated permission may be wanted; (c) evidence retention; (d) production ledger backend for multi-host.

Not implemented / out of scope: automated status lookup, idempotency-key propagation to real targets, durable workflow resume, scheduling, a CLI surface, any real adapter (WhatsApp is explicitly out), configuration for selecting the ledger at server start.

## 9. Recommendation

- **Test use (single process, reference adapters): safe.**
- **Staging with consequential adapters: not yet** — needs host wiring of `BlobDispatchLedger` (nothing does this today) and owner decisions (a)–(c).
- **Production: no.** Blocked by the single-filesystem atomicity limit, the missing specs above, no remote CI evidence for this slice, and M3 acceptance still outstanding.

## 10. Finalization slice (commit `063e8d9`): safety integration

All of §10 is this implementation's **design decisions**, not requirements recovered from O-2, O-3/Review §5.3, N-3, E-1–E-9 or O-4 (still unavailable; no compliance claimed). Implementation complete for this slice ≠ M4 acceptance ≠ production readiness.

### 10.1 Host wiring: durable ledger, in-memory only by explicit opt-in

- Real host path: **no production entrypoint enables external tools** (`apps/api/src/index.ts` passes no `externalTools`). Nothing was invented. Enforcement sits at the construction boundaries that exist:
  - `ExternalToolDispatcher` **throws at construction** unless `ledger.durability === 'durable'` or `unsafeAllowVolatileLedger: true` (tests/local only). `InMemoryDispatchLedger` declares `'volatile'`; an unlabelled custom ledger counts as volatile.
  - `createDurableExternalToolWiring({adapters, inputSchemas, evidenceStore})` (runtime) is the supported way to enable external tools: always `BlobDispatchLedger`; **no default store**, missing store ⇒ throws before any dispatch. No overload accepts an in-memory ledger.
  - `apps/api` `buildRouter` refuses `externalTools` whose ledger is not durable when `NODE_ENV=production` (`CONFIG_INVALID_VALUE`, startup aborted).
- Standard-binding conflicts, missing adapter/schema config and the absence of any AI/model fallback for `external_tool` steps are covered by the pre-existing M4 suites (re-run green).
- The evidence directory is now configurable (§11.3). The shipped entrypoint still enables no adapters.

### 10.2 Reconciliation authorization

- New permission **`effect.reconcile`** (new closed domain `effect`). The owner preferred `external_effect.reconcile`, but `PermissionId` grammar forbids underscores and the domain set is closed; `effect.reconcile` is the closest id that fits without loosening the grammar. Renaming needs an owner call.
- Reconciliation requires authenticated human principal **and** `effect.reconcile`. `procedure.approve` alone is refused (default-deny); `effect.reconcile` alone confers no approval authority. Service principals ⇒ 403. Denials audited as `procedure.denied`; the attempt is gated on a durable `procedure.attempted` audit event (unconfirmed ⇒ 503, nothing reconciled). `procedure.approve` is unchanged.
- Audit vs ledger: the **ledger** records the dispatch lifecycle and each reconciliation decision (actor, reason, evidence examined, time) but not the audit event id. The **audit trail** records the attempt/denial. They are **not correlated by id**; correlation today is by principal, workspace, procedure execution and step (route path), plus timestamps. There is no completion/success audit event type (the audit type list is a bounded owner-approved set; not widened).

### 10.3 Fresh approval after confirmed no-effect

- Rule: if the capability's most recent settled dispatch is `confirmed_failure_no_effect` (adapter-reported or human-reconciled), a new attempt needs a **procedure approval whose `approvedAt` is strictly later than that settlement**. Otherwise the dispatcher returns `fresh_approval_required` (nothing claimed or dispatched) and the step fails with `XO_EXTERNAL_EFFECT_FRESH_APPROVAL_REQUIRED`. Missing or unparsable timestamps block (fail closed). A later confirmed success supersedes it.
- New attempt = new execution ⇒ new dispatch key; its `dispatch_attempted` entry carries `follows: {dispatchKey, outcome: 'confirmed_failure_no_effect'}`. The old key stays settled and is never redispatched. No automatic retry.
- Approval digest: adapter id + input schema are bound (existing); a change makes the approval stale. **Input values and adapter configuration beyond id/schema are not part of the approval digest** (inputs are per-execution; only an input fingerprint is stored in evidence). The owner's "bind input and configuration" is therefore not met for those two; documented gap.
- Unknown outcomes: still block the key and the whole capability, even with a fresh approval. Only an authorized reconciliation that states evidence examined can settle them; `unresolved` settles nothing; a no-effect reconciliation without evidence is refused. The model distinguishes confirmed no-effect only through adapter-declared `confirmed_failure_no_effect` or an evidenced human decision; nothing is inferred.
- Limitation: freshness compares timestamps from the approval store and the ledger; correctness assumes both come from the same host clock (single-host).

### 10.4 Retention

- `assessRetention(ledger, capabilityIds, {retentionMs?}, now)` is **report-only**. No fixed period exists (nothing is a candidate unless the operator supplies `retentionMs`). Never a candidate: unsettled/unknown/`unresolved`/in-flight keys, keys younger than the period or with unknown age, keys referenced by a later attempt (`follows`), and the newest no-effect failure of a capability. The host must still confirm no active/resumable procedure and no audit/recovery need; the ledger cannot know. **Nothing deletes evidence**; the ledger has no delete operation. Not wired to configuration.

### 10.5 Persistence guarantees and what a future shared backend must provide

Unchanged: single-filesystem atomicity only (§3); not exactly-once; crash after the effect and before the record ⇒ blocked/unknown; reconciliation never dispatches. The persistence interface is `DispatchLedger` (+ `AtomicBlobStore.putIfAbsent`). A multi-host backend must provide: linearizable create-if-absent per dispatch key (exactly one winner); linearizable compare-and-append per key (contiguous seq); strongly consistent read-after-write of a key and of a capability's entries; durable acknowledgement before the adapter is called; immutable entries. No such backend, and no test of one, exists.

### 10.6 Tests run (local, after the final code commit)

| Command                                                                                             | Result                                                            |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `cd packages/adapters && npm test`                                                                  | 41 / 41 (incl. 5 fresh-approval, 4 retention, 4 durability-guard) |
| `cd packages/permissions && npm test`                                                               | 147 / 147                                                         |
| `cd packages/runtime && npm test`                                                                   | 487 / 487                                                         |
| `cd apps/api && npm test`                                                                           | 426 / 426                                                         |
| `cd apps/cli && npm test`                                                                           | 287 / 287                                                         |
| `npx tsc -b tsconfig.json`; eslint `--max-warnings=0` and `prettier --check` on changed `.ts` files | clean                                                             |

Existing tests changed: two adapter tests, one M4 reference-service test and the durable e2e test were updated to supply/perform the now-required fresh approval (previously a new execution proceeded with none). Not run: other workspaces' suites, full-repo lint, remote CI (never checked; no push). Required-test mapping: 1–3 `external-effect-host-m4` + `ledger-durability-guard`; 4–6 `external-effect-durable-m4` + permissions test; 7–9 `fresh-approval` + durable e2e; 10 `retention`; 11 all pre-existing M4 suites and the API/CLI/runtime totals above.

### 10.7 Remaining blockers

No shipped host/config path enabling external tools; no shared multi-host ledger backend; approval does not bind input values/extra config; reconcile not id-correlated with audit and no completion audit event; `effect.reconcile` naming vs requested `external_effect.reconcile`; retention is report-only; missing specs above; no remote CI evidence; M3 acceptance outstanding.

## 11. Closure slice (commit `172e8d6`): exact-action binding, audit linkage, freshness, configuration

Same caveats as §10: these are design decisions of this implementation, not recovered requirements (O-2, O-3/Review §5.3, N-3, E-1–E-9, O-4 remain unavailable). Implementation complete for this slice ≠ M4 acceptance ≠ production readiness.

### 11.1 What approval binds (actual semantics)

- **Bound into the approval digest** (per external step, `xo.external-step-state.v2` → registry snapshot digest → procedure approval binding): the contract/permission state, binding id, **adapter id, the input schema (canonical), and a digest of the adapter's `securityConfig`** (canonical JSON of every value the adapter declares, key-order independent). Any change to any of those makes the approval stale (`403`, nothing dispatched). Tested: changed endpoint, account, scope list, removed key, added key, changed schema ⇒ stale and zero adapter calls; the same values in a different key order ⇒ still approved and dispatches. The refusal does not echo config values.
- **`securityConfig` is an adapter-declared contract.** The binding covers only what the adapter lists there; an adapter with security-relevant configuration that omits it is NOT covered. It must be non-secret (represent credentials by an adapter-computed identifier such as a key id or hash); a config that cannot be canonicalized fails dispatcher construction. Absent = `{}` (the reference adapter and test adapters declare none). XO cannot discover undeclared config.
- **Input VALUES are NOT bound by the approval, and cannot be in the current model.** A procedure definition has no literal inputs: values arrive per execution (`inputBindings` from the start request or earlier step outputs), after approval. Binding approval to specific values requires a payload-approval flow (a human approving a concrete input digest for one execution), which does not exist and was not invented here. What IS bound per dispatch: the write-ahead evidence entry records `inputFingerprint` (SHA-256 of strict canonical input) and `actionDigest` (capability + adapter identity/config digest + input fingerprint), so what was dispatched is provable after the fact and a reconciling human can compare. Equivalent inputs (key order) give the same digests; any value change gives different ones. **Resolved by owner decision (2026-10-24): see §12 — host-declared approval modes and payload-level approval.**
- **Strict canonicalization** (`canonicalJson`): sorted keys; `undefined`, functions, symbols, bigint, non-finite numbers, Date/Map/class instances, sparse arrays, cycles and depth > 32 are refused (never collapsed to `null`). Input that cannot be canonicalized is refused as `invalid_request` before any claim or adapter call. Errors name the path/kind, never the value. Neither input nor config values are written to the ledger (tested by scanning the evidence files).

### 11.2 Ledger ↔ audit correlation and its limits

- Each **reconciliation ledger entry** records `reconciliation.auditCorrelationId` = the `correlationId` of the audit `procedure.attempted` (outcome `attempted`) event written as the durable precondition for that attempt. Each **dispatch** entry (`dispatch_attempted` and terminal) records `auditCorrelationId` = the run's correlation id, which tags that execution's `procedure.*` events. Format-validated (≤128 chars, audit id charset).
- **Completion audit:** the existing architecture supports it (`AuditService.finalize`; `procedure.attempted` with outcome `completed` under the same correlation id, metadata `decision`/`effectiveState`/`ledgerOutcome`/`stepId`; no free text, no input). No new audit event type was added. Step audit events (`procedure.step.completed` / `procedure.step.failed`) now carry `effectState` read back from the ledger (`confirmed_success`, `outcome_unknown`, `confirmed_failure_no_effect`, `dispatch_attempted`, or `evidence_unreadable`); absent for steps that did not dispatch externally.
- **Failure behaviour:** attempt event not durable ⇒ 503, nothing reconciled (unchanged). Completion event fails ⇒ the ledger entry stays (append-only, never rolled back) and the response reports `auditCompletion: "unconfirmed"`; the entry still names the attempt event, so it remains traceable. Tested.
- **No atomicity is claimed.** Ledger and audit are separate stores written in sequence: attempt (audit) → ledger entry → completion (audit). A crash between steps can leave an attempt event with no ledger entry, or a ledger entry with no completion event; both are detectable by correlation id. There is no cross-store transaction and none was built.
- The earlier §10.2 statement that reconciliation is "not correlated by id" is superseded by this section.

### 11.3 Durable evidence configuration

- `XO_EXTERNAL_EFFECTS_DIR` → `ApiConfig.externalEffectsDir` (`loadConfig`). **No default** (unset = not configured; control characters abort). `createConfiguredExternalToolWiring(config, {adapters, inputSchemas})` (exported from `@xo/api`) builds the durable wiring over `LocalFsBlobStore(dir)` and **throws if the directory is unset** — before anything can dispatch. The production guard (non-durable ledger refused when `NODE_ENV=production`) is unchanged.
- The shipped entrypoint (`apps/api/src/index.ts`) still supplies **no adapters**, so setting the variable alone enables nothing; no production entrypoint was invented. Supported scope: **one host, or several processes sharing one local filesystem** (the store's `putIfAbsent` is atomic per filesystem only). Not supported/evidenced: network filesystems, multiple hosts, any shared database. A future backend must meet §10.5.

### 11.4 Freshness semantics and clock assumptions

- The ledger stamps `recordedAt` and the procedure approval stamps `approvedAt`, both `Date.prototype.toISOString()` (UTC, ms) from the host clock. The rule now accepts **only** that exact form (`YYYY-MM-DDTHH:mm:ss.sssZ`, exact round trip); date-only, offsets, missing ms, impossible dates and non-strings are refused. An approval must be **strictly later** than the settlement; **neither** stamp may be later than the dispatcher's clock (a forged/skewed future stamp could otherwise make a stale approval look fresh forever); a no-effect settlement with an unparsable stamp is treated as newest and blocks; an unparsable success never supersedes. Every ambiguous case ⇒ `fresh_approval_required`, nothing dispatched. The dispatcher takes an injectable clock (tests).
- **Remaining assumptions:** approval store, ledger and dispatcher share one host clock (single host / one shared filesystem); a backwards clock jump is caught only when it makes a stamp appear in the future; same-millisecond approval and settlement are refused (strict `>`). Correct multi-host freshness needs a logical order (e.g. a ledger sequence recorded in the approval, or a store-issued monotonic token), which needs shared infrastructure that does not exist; not built.

### 11.5 Permission identifier

The permission grammar is `^[a-z][a-z0-9]*\.[a-z][a-z0-9]*(-[a-z0-9]+)*$` over a closed domain list: the domain segment cannot contain a hyphen or underscore, so `external-effect.reconcile` and `external_effect.reconcile` are **invalid**, and only registered domains pass. **`effect.reconcile` is retained** (the closest valid id; no taxonomy expansion beyond the single `effect` domain added earlier). Tested in `permission-id.test.ts`.

### 11.6 Tests run (local, after commit `172e8d6`)

| Command                                                                           | Result                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd packages/adapters && npm test`                                                | 50 / 50 (new `action-binding` 7, +2 freshness in `fresh-approval`)                                                                                                        |
| `cd packages/permissions && npm test`                                             | 147 / 147                                                                                                                                                                 |
| `cd packages/runtime && npm test`                                                 | 487 / 487                                                                                                                                                                 |
| `cd apps/api && npm test`                                                         | 434 / 434 (new: 2 config-binding + 1 equivalent-config in `external-tool-procedure-m4`, 3 audit-linkage in `external-effect-durable-m4`, 3 in `external-tools-config-m4`) |
| `npx tsc -b tsconfig.json`                                                        | exit 0                                                                                                                                                                    |
| `npx eslint <changed .ts> --max-warnings=0`; `npx prettier --check <changed .ts>` | clean                                                                                                                                                                     |

Not run: CLI suite (no CLI-facing contract changed), other workspaces, full-repo lint, any remote CI. One test in `external-effect-durable-m4` was adjusted (the attempt-event filter now also matches outcome `attempted`, because a completion event of the same type now exists); two harness clocks were set ahead so test approval stamps are not in the dispatcher's future.

### 11.7 Remaining blockers / outstanding acceptance

(Input-level pre-approval is addressed in §12.) `securityConfig` is adapter-declared; no cross-store atomicity between ledger and audit; multi-host backend and logical-clock freshness absent; entrypoint enables no adapters; retention report-only; missing specs above; no remote CI evidence; M3 acceptance outstanding. M4 acceptance has not been decided by the owner.

## 12. Approval modes and payload-level approval (commit `6cfd2ae`)

**Interim design decision of the owner (2026-10-24), not a claim that the unavailable O-2 effect-classification spec is satisfied.** When O-2 becomes available this design must be reconciled against it, not assumed to supersede or validate it. O-3/Review §5.3, N-3, E-1–E-9, O-4 also remain unavailable; no compliance is claimed.

### 12.1 Host-declared approval mode (policy source until O-2)

- Every configured external adapter must declare `approvalMode: 'definition' | 'payload'`. **No default**: a missing or invalid value makes `ExternalToolDispatcher` construction throw (so wiring construction fails before anything can dispatch). The host chooses the mode and is responsible for documenting its rationale where the adapter is configured; XO does not classify actions itself.
- **definition**: the existing definition-level approval (procedure, adapter id, input schema, `securityConfig`) suffices. Each dispatch's write-ahead evidence records `approvalMode: 'definition'`, i.e. that the host's policy explicitly permitted variable inputs under that approval.
- **payload**: dispatch needs a human's approval of the exact action for the specific execution and step (below). XO never downgrades `payload` to `definition`: a fresh procedure approval, a valid definition-level approval or any other credential does not substitute.
- The mode is part of the adapter-config digest (hence of the procedure approval digest and the action digest): switching an adapter either way makes earlier procedure approvals stale (tested: 403, nothing dispatched).
- A payload-mode adapter requires a `PayloadApprovalStore`; construction throws without one, and a non-durable store is refused unless the same explicit `unsafeAllowVolatileLedger` test opt-in is used. `createDurableExternalToolWiring` builds a `BlobPayloadApprovalStore` over the same durable evidence store (separate key prefix), so the supported factory is durable by construction.

### 12.2 Payload-level approval: what is bound and how it is enforced

- **What a grant binds** (immutable record): dispatch key (`<procedureExecutionId>:<stepId>`, i.e. execution + step + dispatch identity), capability, adapter id, the **action digest** (SHA-256 over strict canonical {capability, adapter id + `securityConfig` + approval mode, canonical input fingerprint}), the **action summary** the approver confirmed, approver (human id), grant time, and the audit correlation id. Input values are never stored in it.
- **Exact match:** dispatch recomputes the digest from the actual input and the actual adapter configuration; any difference in input or config (or key) ⇒ `payload_approval_required`, nothing claimed or dispatched, approval not consumed. Equivalent input (different key order) matches. Tested for changed values, missing/extra fields, type changes, changed adapter config, other dispatch key.
- **Single use, atomic:** consumption is `putIfAbsent` of a per-approval marker in the authoritative store (`BlobPayloadApprovalStore`), done by the dispatcher **before** the write-ahead claim. Tested: 12 independent store objects racing to consume one approval ⇒ exactly one winner; 6 concurrent dispatchers over one approval ⇒ one adapter call; 6 concurrent API continues ⇒ one dispatch. A spent approval authorizes nothing. If consumption succeeds but the claim then fails, the approval is spent (fail closed; a human must approve again).
- **Order of checks:** runtime authorization, approval freshness, schema validation, key/capability blocks (settled/unknown/in-flight evidence) all run **before** the payload approval is even looked at; so a payload approval can never unblock an unknown or settled outcome (tested; granting for a key that already has evidence is refused as `already_dispatched`).
- **Fresh approval after a confirmed no-effect failure:** for payload mode the fresh-approval comparison uses the **grant time** of the payload approval bound to that attempt; a grant that predates the settlement is stale (`payload_approval_required`, a newer approval is needed), one granted after satisfies the rule, and the new attempt's evidence records `follows` + `payloadApprovalId`. Same strict timestamp rules as §11.4.
- **Recorded for traceability:** the grant (approver, summary, digest, time, audit correlation id), the consumption marker (approval id → dispatch key, time), and the dispatch evidence entries (`approvalMode`, `payloadApprovalId`, `actionDigest`, `auditCorrelationId`). Audit events carry a 12-character digest **prefix** only (audit metadata rejects long opaque values), never input values.
- **Action summary:** produced by the host/adapter (`summarize?`) or, by default, a value-free generic string (capability, adapter, digest prefix). The approver must submit both the digest and the exact summary the server computed from the real input, so the approval cannot be obtained for a different action than the one shown. An adapter summary may legitimately contain business values the approver needs (an amount); it is stored in the approval record, never in audit/logs, and must not contain secrets.

### 12.3 Runtime flow and API

1. A payload-mode step reaches dispatch with no valid approval ⇒ the procedure execution **pauses** (`waiting_for_human`, step `waitingReason: 'payload_approval'`, audit `procedure.execution.waiting_for_human`), nothing claimed or dispatched. (The existing human-task `resume` route refuses such a wait.)
2. `GET .../procedure-executions/:id/steps/:stepId/payload-approval` (human + `effect.payload-approve`) shows the digest and summary computed from the step's real input, plus existing approvals and whether each was consumed. No input values are returned.
3. `POST .../payload-approval` `{inputDigest, actionSummary}` (closed body; human + `effect.payload-approve`; durable audit attempt first, completion via `finalize`): valid only while the step is waiting; digest or summary mismatch ⇒ 400, nothing granted; returns `201` with `auditCorrelationId` and `auditCompletion` (`recorded`/`unconfirmed`; the grant is already written and is not rolled back; no cross-store atomicity).
4. `POST .../payload-approval/continue` (requires `procedure.execute`, i.e. the initiator's own authority): reruns the **same step** with the same dispatch key through the normal runner (per-step authorization, registry/approval freshness, schema validation, ledger all run again); the dispatcher consumes the approval atomically. With no valid approval the step simply pauses again.

- **Permission `effect.payload-approve`** (distinct from `procedure.approve` and `effect.reconcile`; hyphen is valid in the action segment, unlike the owner's candidate `effect.payloadapprove`, which is also valid but less readable — this id was chosen). Human principals only: service principals are refused (403, audited) for both reading and granting. Holding it confers no `procedure.execute` (tested), and `procedure.approve` confers none of it (tested).
- Neither mode bypasses runtime authorization, schema validation, or the external-effect ledger (the approval only adds a precondition to dispatch).

### 12.4 Tests run (local, after commit `6cfd2ae`)

| Command                                                                                    | Result                                                                       |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `cd packages/adapters && npm test`                                                         | 60 / 60 (10 new in `payload-approval`)                                       |
| `cd packages/permissions && npm test`                                                      | 148 / 148                                                                    |
| `cd packages/runtime && npm test`                                                          | 487 / 487                                                                    |
| `cd packages/testing && npm test`                                                          | 3 / 3 (`ScriptedExternalAdapter` now declares `approvalMode`)                |
| `cd apps/api && npm test`                                                                  | 442 / 442 (7 new in `payload-approval-m4`, 1 new mode-switch staleness test) |
| `npx tsc -b tsconfig.json`; eslint `--max-warnings=0`; `prettier --check` on changed `.ts` | clean                                                                        |

Not run: CLI suite, other workspaces, full-repo lint, remote CI. Existing test adapters were updated to declare `approvalMode: 'definition'` (required field); `createReferenceAdapter` gained an optional mode parameter.

### 12.5 Limits and open items

- **Interim policy source:** the mode is a host declaration, not an assessment of the action; a host that declares `definition` for a consequential adapter gets definition-level behaviour. Reconcile with O-2 when available.
- A payload approval authorizes one dispatch key. It is bound to the input as stored on the paused step's capability record; the dispatched input is re-verified against the digest at dispatch, so a divergence blocks rather than dispatches.
- Consumption-before-claim means a crash or claim failure after consumption spends the approval (a new approval is needed); it never causes a second dispatch. The crash window after the effect but before the record remains an unknown outcome (§3).
- Single-filesystem atomicity only (applies to approval consumption too); freshness assumes one host clock (§11.4); the approver and initiator may be the same person (no separation-of-duties rule was requested or added); ledger/audit remain non-atomic (§11.2).
- Approval and continue do not use idempotency keys; a repeated continue is safe (it pauses again, or conflicts once the run has progressed).
- Not production-ready; M4 acceptance has not been decided by the owner.
