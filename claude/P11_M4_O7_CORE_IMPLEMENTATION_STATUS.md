# P1.1 M4 — external_tool execution: implementation status (durable evidence + reconciliation slice)

Date: 2026-10-23. Branch `p11/m4-external-tool`. Base head at start of this slice: `15cb969` (verified by clone). PR #7 is reported open/draft/unmerged — **not verifiable from this environment** (no PR/CI API access was used). Nothing was pushed, merged or opened by this slice.

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
- No retention/purge: evidence is never deleted by this code. Retention policy is undefined (no source spec).
- Ledger is separate from the audit trail; audit events cover the reconciliation request, not each ledger entry.
- Wiring is still host-programmatic: `server.ts` takes `externalTools` as an injected dependency. **Nothing in the repo constructs a `BlobDispatchLedger` for a real server**; a host must do so (and must not use `InMemoryDispatchLedger` for consequential adapters). No config/env path was added.

## 4. Dispatch identity and duplicate prevention

Identity = `<procedureExecutionId>:<stepId>`, minted by the server. Same identity ⇒ never dispatched twice (success, failure, unknown alike). A new execution is a new identity and re-runs approval, authorization and input checks. Replaying an HTTP request does not dispatch (the identity already has evidence).

## 5. Reconciliation (delegated design decision of this slice)

These semantics are **this slice's design**, not a verified requirement: the governing texts (O-2, O-3/Review §5.3, N-3, E-1–E-9) are unavailable.

- Endpoint: `POST /workspaces/:ws/procedure-executions/:id/steps/:stepId/external-effect/reconcile`, body `{decision, reason, evidenceExamined?}` (closed schema; any actor/identity/dispatchKey/authority field ⇒ 400).
- Authorization: workspace ownership (uniform 404 otherwise); **authenticated human principal only** (service ⇒ 403, audited); `procedure.approve` permission (default deny, no new permission invented). Actor identity comes from the authenticated principal.
- Audit: durable `procedure.attempted` precondition (if unconfirmed ⇒ 503, nothing reconciled); denials audited as `procedure.denied`. The ledger entry itself records actor, timestamp, reason, evidence, decision.
- Decisions: `confirmed_success` / `confirmed_failure_no_effect` (both require non-empty evidence examined; settle the key) and `unresolved` (recorded, settles nothing, key stays blocked). Unknown key ⇒ 404 (absence of evidence is not proof).
- Idempotent/concurrent-safe: identical repeat ⇒ `already_resolved`; contradicting a settled key ⇒ 409; concurrent callers race on compare-and-append, one `recorded`.
- **No redispatch from reconciliation.** Response always says `redispatchPermitted: false`. Even `confirmed_failure_no_effect` only unblocks the _capability_; the same key stays refused; a retry must be a new execution (new identity, new approval-freshness/authorization/input checks). Whether a confirmed-no-effect outcome should instead require a _fresh human approval_ is an owner decision (see §8).
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
