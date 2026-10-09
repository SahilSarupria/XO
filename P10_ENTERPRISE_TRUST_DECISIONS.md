# P1.0 — Enterprise Trust: Decision Record

Authoritative record. Status of each entry is stated explicitly. This file does not create a roadmap phase and does not modify the frozen master roadmap (P0.9A/B/C closed → P1.0 → P1.1 → P1.2 → Multi-XO foundation → P1.5 → P1.7 → P2 → P3).

## A. APPROVED decisions (by the user, recorded at P1.0 M1 start)

| # | Decision | Status |
|---|---|---|
| D1 | **Deployment model:** single-tenant, one business per deployment initially. Workspace isolation is preserved. Interfaces stay extensible for future multi-organization deployments. | APPROVED |
| D2 | **Principal model:** minimal authenticated human / service principal with a stable id and optional `orgId`. Package and capability identities remain separate from the initiating principal. | APPROVED |
| D3 | **AI execution exposure:** AI execution remains disabled until its path enforces effective authorization. It is not re-enabled by M1. | APPROVED |

## B. Implementation details established by inspecting the repository (NOT user decisions)

These were chosen by the implementer from the code as it stands; they are reviewable and reversible without changing A.

| # | Detail | Basis |
|---|---|---|
| I1 | The `Principal` contract lives in `@xo/permissions` (`src/principal.ts`): `{ kind: 'human'\|'service', id, orgId? }`. | That package already owns "who/what is asking" vocabulary and has no runtime dependency; `apps/api` and `apps/cli` already depend on it. |
| I2 | Shape is validated strictly: id/orgId match `^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$`; unknown fields are rejected. | Keeps ids log-safe and path-safe; prevents authority-like extras (`roles`, …) riding on a principal. |
| I3 | "Authenticated" is a distinct, runtime-checkable type (`AuthenticatedPrincipal`) mintable only by `establishAuthenticatedPrincipal`. The only call site in M1 is API-key authentication (`apps/api/src/http/auth.ts`). Persisted snapshots are plain `Principal`s and are not authenticated. | Separates authenticated identity from attribution. In-process guarantee only (see report limitations). |
| I4 | API keys map to a principal via the **existing** server-side `ApiKeyRecord`: `identityId` is the principal id; new fields `principalKind` and optional `orgId` are written only by operator tooling (`scripts/manage-keys.ts issue … --kind`). | Extends the existing hashed-key store; no new identity subsystem. |
| I5 | A key record with no/invalid principal binding **does not authenticate** (401). No default kind. Keys issued before M1 must be re-issued with `--kind`. | "No fake default principals"; avoids silently granting an attributed identity. Compatibility cost is accepted and documented (`apps/api/README.md` "Principal and key binding (P1.0 M1)"; OpenAPI `securitySchemes`). Consistent with D2 and the fail-closed identity model: unbound keys are not silently restored, no default principal is invented, no implicit permission is granted. |
| I6 | The initiating principal is recorded as an immutable `initiator` snapshot on execution and workflow-execution records; the HITL resolver is recorded separately as `humanTask.resolver`. `identityId` (workspace-ownership identity) is unchanged and equals `initiator.id`. | Resume/resolve must not replace the initiator. |
| I7 | AI execution is disabled by a code constant (`AI_EXECUTION_ENABLED = false`) in `apps/api` `/runtime/execute` (501) and in the CLI `runCommand` AI branch; both refuse before any provider is resolved. Not configurable by flag/env/header. | Both paths were found exposed without effective authorization (audit G2). |
| I8 | The CLI gains **no** principal in M1: it has no authentication boundary, and env vars/flags/`--grant` are not identity. | See D2 / "no unsafe fallback". |

## C. Explicitly NOT decided here

Role/permission model, org membership, SSO/IdP, key rotation/expiry/scopes, authorization gate semantics (M2), approval binding (M3), audit ledger (M4), package trust (M5), idempotency (M6), endpoint hardening (M7).

## D. Proposed for review (NOT implemented, NOT approved)

**Key-migration helper.** An operator command such as `manage-keys.ts bind <identityId> --kind human|service [--org <orgId>]` that attaches a principal binding to an *existing* unbound key record so callers need not receive new keys. Open questions for review: (a) it asserts a kind for a credential whose holder the tool cannot verify (the operator is vouching); (b) it should require an explicit per-identity confirmation and refuse to touch revoked keys; (c) whether re-issuing (current documented path) is preferable because it forces key rotation. Until approved, the only supported path is revoke-then-reissue with an explicit `--kind`.
