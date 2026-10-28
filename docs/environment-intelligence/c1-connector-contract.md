# C1 — Universal connector contract

Status: implemented on `feat/c0.3-audit-unification` (uncommitted at time of writing). Acceptance is **not** claimed here; see the closeout evidence in the C1 report.

C1 makes the connector contract reusable and framework-verified. It deliberately does **not** add credential management, content release into compiler ingestion, remote/hybrid agents, persisted sync cursors, or disconnect/cleanup lifecycles.

## Owner decisions (recorded)

| Id    | Decision                                                                                                      | Effect in code                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| D1    | `incremental_sync`: contract + audit operation + mock only; filesystem stays unsupported; no persisted cursor | optional `Connector.incrementalSync`, `syncSource`, `SyncRequest/SyncOutcome/SyncCursor`, `AuditOperation` gains `incremental_sync` |
| D2    | `health`: contract + mock only                                                                                | optional `Connector.health`, `checkSourceHealth`, `HealthRequest/HealthReport`, `AuditOperation` gains `health`                     |
| D3    | Only `operator_scope_grant` and `none` work; others fail closed at registration                               | `SUPPORTED_AUTH_METHODS`; registration rejects other auth methods and any `secret` config field                                     |
| D4    | No content release into compiler ingestion                                                                    | unchanged: acquisition still returns digests and bounded tokens only                                                                |
| D5    | Unify existing authorization-revocation and evidence revoke/purge at contract level; no disconnect/cleanup    | a revoked source is refused by `acquire`, `sync` and `health` before any connector is reached (`resolveProtectedSource`)            |
| D6(A) | Framework-level tracking and verification                                                                     | `connector-enforcement.ts`: `TrackingAuthorization`, `TrackingAuditRecorder`, `runEnforced`                                         |

## What the framework now guarantees for every connector

Registration (`ConnectorRegistry.register`, fail closed; throws `ConnectorRegistrationError` with fixed problem codes):

- each of the six operations is declared `supported` or `unsupported`;
- `supported` ⇒ the method exists and a valid permission id is declared; an `unsupported` **optional** operation (`incremental_sync`, `health`) must have no method;
- only `SUPPORTED_AUTH_METHODS`; no secret config field; `sideEffects: 'none'`; at least one source type.

Per call (`runEnforced`), the connector receives a context whose `authorization` and `audit` are tracking wrappers. An `ok` result is accepted only if the framework observed:

1. at least one authorization request, and **every** request made during the call was for the declared connector, operation and permission, as the authenticated principal, and was **honoured** by `requireAuthorization` (recorded in a module-private registry, never read from a decision field). Listing permission therefore cannot stand in for read;
2. for `discover`, `acquire_content`, `incremental_sync`: an accepted write-ahead attempt followed by an accepted `completed`/`cancelled` terminal record, same operation id, naming the expected source and permission;
3. returned evidence names the expected source, the invoked connector and (when present) the authenticated principal. Connector-supplied identity is never honoured.

On failure the result is withheld with a typed error (`EI_AUTHORIZATION_UNVERIFIED`, `EI_AUDIT_UNAVAILABLE`, or `EI_MALFORMED_INPUT` for identity mismatch) and source state is **not** advanced (`authorization_granted`/`connection_validated` are applied only after verification). Evidence the connector's own completion step already released is **quarantined** via the existing ledger / C0.4 `state.quarantine` APIs, so rejected evidence is never left eligible.

Audit: `discover`, `acquire_content`, `incremental_sync` have attempt + terminal records; `detect`, `validate_connection`, `health` keep denial-only records. Same-operation-id retries are idempotent (the C0.3/C0.4 recorder behaviour, now covered by a test).

## Interim judgements (flagged for review)

- `health` and `incremental_sync` require an authorized **and validated** source, like acquisition. A health probe of a failed connection is therefore refused in C1.
- `detect` is now declared in the filesystem descriptor's `requiredPermissions` (`filesystem.list`, what it already asked for); needed so detect can be verified. This adds one entry to `ConnectionPlan.pendingActions`.
- The mock connector and contract kit live in `test/support/` and are **not** exported from the package.

## Limitations (unchanged or newly noted)

- Verification is an in-process guarantee against a connector that is wrong or careless, not a sandbox against code that imports internal modules.
- Containment quarantines evidence in the ledger/journal; it does not append an extra audit record for the rejected operation.
- Carried forward from C0.4: tamper-evident only, no external anchoring, single host, no atomicity across audit chain and journal, EI not composed into any application.

## Tests

`connector-contract` (same suite, filesystem + mock), `connector-enforcement` (non-conforming mocks), `connector-registration`, `connector-sync-health`, `connector-audit-parity`. Any new EI test file must be added to the explicit list in `packages/environment-intelligence/package.json`.
