# XO Environment Intelligence — Architecture (Workstream 3, Milestone 1: Environment Discovery Foundation)

Status: **milestone proposal + bounded implementation**. Roadmap and runtime stages are frozen; this adds no numbered phase and changes no compiler, XOIR, runtime, permission, identity or benchmark semantics. Code: `packages/environment-intelligence/` (isolated, no edits to shared source).

Legend used throughout: **[implemented]** code + tests in this package · **[contract]** typed contract only, no behaviour · **[proposal]** documented, not built · **[fixture]** synthetic data, never customer data.

## 1. Repo audit — what already exists

| Capability                                                                                         | State                                                     | Notes                                                                                 |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| XOIR, compiler, runtime, evidence strength vocabulary (`EvidenceStrength`)                         | implemented, verified upstream (baseline 3188/3191 tests) | Reused as _vocabulary only_; this package never writes XOIR.                          |
| P1.0 `Principal`, `PermissionScope` (path scope), `domain.action` permissions                      | implemented upstream                                      | Reused as vocabulary; **not wired** (see §8).                                         |
| Knowledge graph / capability graph                                                                 | implemented upstream for compiled workflows               | Not a discovery store. Environment model stays separate; link-out is a proposal (§4). |
| Environment discovery of unknown organizations (connectors, inventory, provenance of observations) | **not present**                                           | This milestone.                                                                       |
| Real authorization gate for discovery                                                              | **not present** (P1.0 M2 dependency)                      | Fail-closed port + dev-only stub here.                                                |
| Audit log, retention/purge                                                                         | not present for discovery (P1.0 M4 / retention)           | Hooks only: `purgeRequired`, provenance records.                                      |

Reuse vs extend vs new: reuse conventions (Result, branded ids, injected clock/authorization, `@xo/testing`); extend nothing; **new isolated package** so Workstream 3 and P1.0/Studio can't conflict.

## 2. Layering (one-way dependencies)

1. Contracts: `ids`, `errors`, `epistemic`, `authorization`, `evidence`, `connector` **[implemented]**
2. State: `source-state` (axes + guarded transitions), `inventory` **[implemented]**
3. Orchestration: `registry` (planning), `orchestrator` (detect → validate → authorize → discover → acquire) **[implemented]**
4. Adapter: `filesystem/*` — the only real adapter **[implemented]**
5. Representation: `environment-model`, `explain` **[implemented]**
6. Process discovery: `process-discovery` — candidate hypotheses only **[implemented, heuristic]**
7. Opportunity: `opportunity` — type contract, `executable: false` **[contract]**

## 3. Discovery vs acquisition

- **Discovery** = what exists (metadata, names, sizes, mtimes) — permission `filesystem.list`.
- **Acquisition** = bounded content reading — separate permission `filesystem.read`, only after authorization granted AND connection validated (guarded transition; otherwise `EI_INVALID_TRANSITION`).
- Discovery never confers execution permission. Connectors declare `sideEffects: 'none'` (literal type).

Source lifecycle is separate axes (detection, support, connection, authorization, validation, acquisition) with a _derived_ summary: detected, supported, connection required, authorization required, connected+validated, acquisition successful (or partial), unsupported/inaccessible, failed/unavailable. The summary is a view, not truth. Revocation sets `purgeRequired`.

## 4. Relationship to XOIR / knowledge graph / capability graph

The environment model (`ei.environment-model/v0`) is a separate, unvalidated hypothesis layer. `xoirLinks` is typed `never[]` — nothing links into XOIR. **[proposal]** A later projection could map validated, human-approved entities into the knowledge graph, and resolved processes to capability-graph requirements. Process steps' `requiredCapabilities` are deliberately unresolved.

## 5. Connector / agent architecture

`Connector<TScope>` = `detectSource`, `validateConnection`, `discover`, `acquireContent`; descriptor lists supported operations (`incremental_sync`, `health` declared, unsupported here). Source types are an open set (`x-<org>-<name>`). **[proposal]** Hybrid deployment: connectors run beside the data (customer-side agent/SDK) and ship only evidence records; the contract is serializable and transport-neutral. No agent, daemon or network code exists in this milestone.

## 6. Evidence and provenance

Every observation is an `Evidence` with `ProvenanceRecord`: source id, connector id+version, **relative** locator, observedAt (injected clock), access {operation, permission, authority, decisionReason, principal?}, transformation chain. Raw content is **never stored** — only a SHA-256 over the whole file (when fully read), byte counts, truncation flags and bounded identifier tokens. Ids are sha256-derived and stable, so repeat syncs de-duplicate; the inventory records `scanCount` and `changedSinceLastScan` via a scan fingerprint.

Epistemic statuses (no numeric confidence): `directly_observed`, `corroborated_inference`, `candidate_hypothesis`, plus unknowns. `ValidationState` is only `not_validated`. Corroboration rule: ≥2 independent evidence kinds, each tying **both** endpoints (e.g. identifier in filename _and_ in content in both files). Relationships: `same_content` (equal whole-file digests) and `shares_identifier` (every pair judged independently). Every relationship lists alternative explanations and requires human review.

## 7. Process discovery

Heuristic: ≥3 resources sharing an identifier, ordered by mtime. Output is always `candidate_hypothesis`, `not_validated`, `humanReviewRequired`, step relationship `observed_sequence_only`; order is "established" only when timestamps are distinct. Missing evidence and alternative explanations are listed. Real process mining (event logs, app telemetry) is future work.

## 8. Security and P1.0 dependencies

Filesystem adapter limits **[implemented, tested]**: explicit root (rejects relative, NUL, `/`, home dir, non-directories); realpath containment; acquisition rejects symlinks in every path component before opening; `..`/absolute/backslash locators rejected; name sanitization; sensitive names (`.env`, keys, credentials patterns) and VCS/dependency dirs excluded — counted, not listed; bounded depth/entries/bytes/files/time; AbortSignal cancellation; deterministic ordering; structured errors (`EI_*`) with `internalError` never leaking raw messages. Concurrent directory mutation can still race path checks and reads (TOCTOU); this local-filesystem prototype is not a defense against a hostile process with write access inside the approved root. File content is treated as untrusted data: it is hashed and tokenized, never interpreted or fed to a model in this milestone.

Authorization: `FailClosedAuthorization` is the default (denies, authority `none`). `DevelopmentOperatorAuthorization` is a **dev-only** path-subtree allow-list that stamps `authority: development_unverified` into provenance and into model notices. It is not a parallel authorization system; it exists so the port can be exercised until P1.0 lands.

P1.0 dependencies (not built here): **M2 authorization gate** implementing `AuthorizationPort`; **M4 audit** consuming provenance access records; retention/purge honouring `purgeRequired`; a connector-shaped requester `Principal`; mapping `filesystem.list` / `filesystem.read` into the permission vocabulary **[proposal]**.

### 8.1 M2.1 — Authorization boundary **[implemented, tested]**

Detection, validation, discovery and authorization stay separate operations; a detected, declared or listed source is only a _candidate_ and never confers access to its contents (`filesystem.list` authorization recorded on the inventory does not stand in for the `filesystem.read` decision, which is requested again per operation).

The single enforcement point (`requireAuthorization`) applies, in order: (1) **identity** — the caller must be the exact `AuthenticatedPrincipal` minted by `@xo/permissions`; plain, copied, deserialized, environment-derived or discovery-derived principals fail with `EI_UNAUTHENTICATED` before the port, inventory or filesystem is touched; (2) **request shape** — malformed permission ids and ambiguous/global/non-path scopes are refused; (3) **decision** — only a decision minted by a trusted constructor is honoured; deny, prompt, malformed, forged, cloned or throwing/unavailable ports fail closed; (4) **binding** — a minted decision is bound to the request it answered (principal, connector, operation, permission, scope), is single-use, and its granted scope must contain the requested scope.

Limits: the guarantees are in-process (as with the P1.0 M1 principal marker). On `main`, `PermissionManager` policy still matches the requester package label, not the principal, so the principal is a precondition and provenance input, not a policy dimension; binding principal to requester remains the open P1.0 contract. The public `mintDevelopmentDecision` stays unbound and reusable for compatibility (development authority only).

### 8.2 M2.2 — Audit semantics and fail-closed evidence lifecycle **[implemented, tested]**

Protected evidence operations (`discover`, `acquire_content`, `revoke_evidence`, `purge_evidence`) follow `authorize → ATTEMPT accepted → read → COMPLETION accepted → release`. The audit port (`AuditRecorder.record`) is the only dependency; "accepted" means `record()` resolved with a receipt naming that exact event. A rejection, throw, timeout, malformed receipt or mismatched receipt is _not accepted_.

- **Write-ahead:** no read or listing happens until the attempt is accepted; with no recorder configured the operation is refused (`EI_AUDIT_UNAVAILABLE`). There is no no-op default.
- **Completion and quarantine:** the outcome (`completed`/`failed`/`cancelled`) is recorded after the work, retried under the same idempotency key, and not tied to the caller's abort signal. If evidence was acquired but the completion is not accepted, it is withheld (`EI_EVIDENCE_QUARANTINED`; the ledger keeps opaque ids only, never payloads) and a `quarantined` record is attempted. A success is never reported without its completion record.
- **Outcomes:** `attempted`, `denied`, `failed`, `cancelled`, `completed`, `quarantined`, `revoked`, `purged`, each valid only in its phase (`attempt` / `terminal` / `standalone`). Denials of authenticated callers are audited; unauthenticated callers are not (no verified identity to attribute).
- **Data minimization:** the event schema is closed and content-free (ids from a slash-free alphabet, scope and key digests, error _codes_, counts). Unknown fields are rejected, so content, secrets and paths cannot be recorded.
- **Revocation/purge:** authenticated, authorized (provisionally `data.write`/`data.delete`), write-ahead audited. Revoking makes evidence ineligible before any holder is asked to delete; audit history is never erased. `EvidenceLedger` + `buildEnvironmentModel({ eligibility })` keep revoked/purged/quarantined/unreleased evidence out of model input.
- **Async:** every audit write is awaited in sequence; nothing is detached. A late acceptance after a timeout cannot release evidence.

Limits: `detect` and `validate_connection` are metadata-only existence probes and are not write-ahead audited (their denials are). The ledger is in-memory; a restart loses eligibility state (P1.0 M4 persists the audit, not the ledger). A revoked source must be re-authorized before it can be read again.

### 8.3 P1.0 M4 — Durable audit persistence **[implemented, tested]**

**C0.3 update:** EI no longer owns a log. `FileAuditLog` is a deprecated facade over the canonical `@xo/audit` `ChainedAuditStore` (via `CanonicalAuditRecorder`); the file is `audit.chain.jsonl`, writes require the authenticated principal (`record(event, trust)`), and there is no unauthenticated read. See `docs/audit-canonical-contract.md`. The bullets below describe the guarantees, now provided by the canonical store; sequence numbers are event sequences (no header offset), and `verifyAuditLog` returns an error (not a report with `ok:false`) on any integrity failure.

Original M4 design note: `FileAuditLog` implemented the M2.2 `AuditRecorder` behind the same interface. No existing repository store fit (the repo's persistence is JSON-file-per-record with atomic rename, no append-only log, no fsync discipline, no database dependency), so this is the smallest durable backend: one append-only JSON Lines file, one writer, `node:fs` and `node:crypto` only, no new dependencies.

- **Durability:** a record is acknowledged only after its complete line was written and `fsync` returned. A failed or short write, or a failed fsync, is _not accepted_ and poisons the instance until reopen. Events survive restart (tested with a clean reopen and a real `SIGKILL` of a writer).
- **Identity and order:** `eventId`, strictly +1 `sequence`, `recordedAt`, event type/outcome; principal snapshot, permission decision metadata, requested/granted scope references, counts and evidence ids per M2.2's closed schema, re-validated by the backend.
- **Integrity:** each record commits to the previous record's hash (SHA-256, or HMAC-SHA-256 with an integrity key). `verifyAuditLog` and `open` detect modification, deletion, reordering and corruption of non-tail records, and `open` refuses to append to a log that fails verification.
- **What this does NOT guarantee (not tamper-proof):** without a key, anyone who can rewrite the file can recompute the chain; with a key, the key holder can. Dropping the newest records at a record boundary is undetectable from the file alone and is detected only against an external checkpoint (`checkpoint()` / `expectedHead`). A compromised host or a filesystem that lies about fsync defeats it. These limits are asserted in tests, not just stated.
- **Recovery and idempotency:** an incomplete final line (never acknowledged) is truncated on open and noted by a `recovery` record; any complete line that fails verification is `AUDIT_CORRUPT` and is never auto-repaired. Retries with the same idempotency key return the original receipt (timestamps are ignored in the comparison, so a later retry still matches); the same key with different content is `AUDIT_CONFLICT`; a terminal event requires an accepted attempt and an operation has one terminal event. An attempt with no terminal event is reported by `openAttempts()` / `verifyAuditLog`.
- **Concurrency:** one writer owns the log via an exclusive lock file (pid + host). Appends are serialized, so the chain is linear. A second opener gets `AUDIT_LOCKED`; a lock left by a dead process on the same host is taken over; any other lock is never stolen. Multi-host/network-filesystem writers are unsupported.
- **Retention:** the log has no delete, compaction or age-based expiry; history is retained indefinitely, so audit retention is at least as long as any evidence retention. `assertRetentionAligned` and the `evidenceRetentionMs` option reject a finite audit retention shorter than evidence retention.
- **Errors:** structured `AuditError` (code, retryable, errno), never a path, payload or message text. There is no fallback to a no-op or in-memory recorder; `InMemoryAuditRecorder` is test/demo only and never a default.

Deferred: segment rotation and checkpointed startup (the whole log is read at open, bounded by `maxLogBytes`), key rotation, persistence of the `EvidenceLedger`, and signed checkpoints/external anchoring (only the hook exists).

## 9. Milestone vs future work

In: contracts, inventory/state machine, one local filesystem adapter, evidence model, environment model with relationships, candidate processes, explainer, tests, demo. Out: any remote/SaaS connector, credentials handling, incremental sync/health, LLM interpretation, XOIR projection, opportunity scoring, persistence, UI.

C1 (connector contract, framework-verified authorization/audit, optional sync/health contracts): see `c1-connector-contract.md`.

## 10. Owned files

`packages/environment-intelligence/**`, `docs/environment-intelligence/**`. Additive shared edits: one project reference in root `tsconfig.json`; `package-lock.json` (workspace entry — regenerate on merge conflict).

## 11. Fixtures

`fixtures/invoices/` is **synthetic** and labeled so; the demo's second run marks its model `test_fixture` and the explainer prints a TEST FIXTURE banner.
