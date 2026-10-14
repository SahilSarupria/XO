# Canonical audit contract (C0.3)

There is **one** authoritative audit architecture: `@xo/audit`. Environment Intelligence (EI) records through it and holds no log, hash chain, lock, scanner or lifecycle engine of its own.

```
EI operation ─► AuditRecorder (EI port) ─► CanonicalAuditRecorder ─► AuditSink ─► ChainedAuditStore ─► audit.chain.jsonl
platform API / CLI / runtime ───────────────────────────────────────► AuditSink ─► FileAuditStore    ─► audit.jsonl (unchained, existing)
```

## Who owns which guarantee

| Guarantee                                                                                                                                                      | Owner                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Closed draft validation, forbidden-key and secret-value filtering, trusted actor, store-assigned id/seq/time, branded durable receipts, single-use read grants | `@xo/audit` core                                                      |
| Idempotency (exact retry → original), **conflict** (same key, different content), lifecycle ordering (`AuditSemantics`)                                        | `@xo/audit` (shared by the chained store and the non-production sink) |
| Hash chain, verify-on-open/read, fail-closed append, poison-on-indeterminate, torn-tail recovery record, external `checkpoint()` comparison                    | `@xo/audit` `ChainedAuditStore`                                       |
| EI's closed request schema, mapping to a draft + the `x-ei-audit` extension, principal binding, EI receipt/error vocabulary                                    | EI (`audit-canonical.ts`)                                             |

## Event, receipt and result semantics

- `AuditSink.append(draft)` never throws. It returns `{ok:true, receipt, event, duplicate}` or `{ok:false, error, indeterminate}`.
- A durable receipt (`guarantee: 'fsync-file'`) means the record line was written **and** fsynced. `volatile-memory` receipts exist only for `NonProductionAuditSink`.
- `indeterminate: true` means the write may or may not have landed. The caller must not treat it as accepted and must not assume it failed.
- `duplicate: true` means an exact retry of an already-accepted event: nothing was written; `event`/`receipt` are the original's.
- Same idempotency key + different content → `AUDIT_CONFLICT`, nothing written. (Before C0.3 the platform returned the earlier event as a success.)
- Lifecycle (`lifecycle: {operationId, phase}`): a terminal needs an accepted attempt; one terminal per operation; no attempt after a terminal → `AUDIT_ORDER_VIOLATION` / `AUDIT_CONFLICT`. **An unchained store refuses lifecycle drafts** rather than silently dropping the guarantee.
- **Volatile extension fields** (schema-declared, top level only) are validated and persisted but excluded from event identity, so a retry rebuilt after a restart with a later clock reading is a duplicate and the original value is kept.

## Closed, bounded extensions

A domain registers a schema per namespace (`x-<org>-<name>`). Every leaf is a typed field (`id`, `version`, `enum`, `count`, `bool`, `isoTime`, anchored `opaque`, or a bounded `list`/`object` of those). Unknown members, unregistered namespaces, free-text leaves, oversize or over-deep values are rejected. The **global** secret filter still applies: field names are checked against the forbidden fragments, `id`/`version` strings against the secret-value patterns (bearer, JWT, private key, provider key, ≥40-char opaque blob). The only exemption is `opaque`, which must match an explicit anchored pattern (EI uses `sha256:<64 hex>` for `keysDigest`).

## Failure semantics

| Condition                                                          | Result                                                                                                                        | Caller                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Exact retry                                                        | ok, original receipt, `duplicate:true`                                                                                        | proceed                                 |
| Same key, different content                                        | `AUDIT_CONFLICT` (non-retryable)                                                                                              | fail closed                             |
| Order violation                                                    | `AUDIT_ORDER_VIOLATION`                                                                                                       | fail closed                             |
| Invalid/unknown field, secret-shaped value, unregistered namespace | `AUDIT_EVENT_INVALID`, nothing written                                                                                        | fail closed                             |
| Write/fsync failure                                                | `AUDIT_UNAVAILABLE`, `indeterminate:true`; instance poisoned (no later append)                                                | fail closed                             |
| Reopen after an indeterminate failure                              | whole file verified and **fsynced**; a retry with the same key returns the original if the line landed, otherwise writes once | reconcile by retrying with the same key |
| Torn (unterminated) tail                                           | cut back; a `recovery` record is appended to the chain                                                                        | —                                       |
| File grown/shrunk behind a live writer                             | `AUDIT_CORRUPT`; appends refused                                                                                              | fail closed                             |
| Any integrity failure on open/read/verify                          | `AUDIT_CORRUPT`; nothing unverified is returned; appends refused                                                              | fail closed                             |
| Integrity-mode/key mismatch                                        | `AUDIT_CONFIG_INVALID` (configuration, not tampering)                                                                         | refuse to start                         |
| Second writer                                                      | `AUDIT_LOCKED`                                                                                                                | retry later / fail closed               |
| Storage unavailable                                                | `AUDIT_UNAVAILABLE`                                                                                                           | fail closed                             |

EI keeps its own caller-side fail-closed rules: no recorder → protected read refused; rejected attempt → no read; failed completion → quarantine, never reported completed; denial records stay best-effort.

## Security boundaries

- **Principal.** `AuditRecorder.record(event, trust)` requires `trust.principal`, the branded `AuthenticatedPrincipal` the authentication boundary established. The adapter checks `isAuthenticatedPrincipal`, compares kind/id/orgId to the request's snapshot, and only then mints the audit actor from the **trusted** principal. A mismatching snapshot, a structural copy, or a missing context records nothing. The snapshot is attribution, never proof.
- **Reads.** Live reads and verification go through `AuditAccessController` grants (`ChainedAuditStore.read/verify(grant)`); grants are single use and short lived. EI's unrestricted `readAuditLog` was **removed**. `verifyClosedChainedLog` / `readClosedChainedLog` (and EI's `verifyAuditLog`) are operator-local operations on a **closed** file: filesystem permissions are the authorization and they refuse a directory held by a live writer.
- **Content-free.** EI's closed schema runs first, then the platform validator; persisted events are re-validated through the same schema on every open/read/verify.

## Retention

The chained store has no purge, delete or compaction API (`retainUntil` is the indefinite sentinel). Retention rebasing / purge markers are **not** implemented. The unchained `FileAuditStore` keeps its existing retention/purge behavior for platform events.

## Limitations (read before relying on this)

- The chain is tamper-**evident**, not tamper-proof. An attacker who can rewrite the **entire** local file can recompute an unkeyed chain; and, whether keyed or not, can **delete the newest records** and the remaining prefix still verifies. A keyed (HMAC) chain stops forgery by anyone without the key, not tail deletion. Detecting tail deletion needs an externally stored head (`checkpoint()` → `expectedHead`); the comparison exists, **independent anchoring does not**. Tests assert these limits.
- A live writer does not re-verify history on every append. Same-size in-place edits are caught on the next open/read/verify; size changes are caught on the next append.
- Not defended: a compromised host/process, a filesystem that lies about fsync, network filesystems, multiple hosts. One writer per directory.
- A pre-C0.3 EI `audit.log` is **not migrated**; opening a directory containing one is refused so two histories cannot coexist. No production code wrote one.
- Platform events written by `FileAuditStore` remain unchained (existing behavior). Moving API/CLI/runtime audit onto the chained store is not part of C0.3.
- EI ids must satisfy the platform filters (≤200 chars, no secret-shaped values); an unrepresentable id is refused, not truncated.
