# 0010: One authorization point for every path (D-A)

## Status

Accepted under owner delegation, 2026-11-13 (UW-0). Signed off 2026-11-13 by Claude under the owner's explicit delegation of sign-off authority (owner instruction of 2026-11-13); this is a delegated sign-off, not an independent review. Implemented by UW-1.

The owner delegated architecture decisions provided the result is production quality and moves XO toward the vision (Workstream
Plan Revision 4, §0; owner instruction of 2026-11-13). Evidence: `docs/baseline/UW0_BASELINE.md` §7 row 28 and §8 (D-A spike).

## Context

`apps/api` runs two authorization systems side by side:

1. A **workspace role table** (`apps/api/src/workspace/permissions.ts`): roles `admin`, `publisher`, `reviewer`, `viewer` over six
   permissions (`read`, `author`, `publish`, `review`, `audit`, `manage`). It guards every route group except procedures: sources,
   compilation and capability approval, executions, human tasks, packages, registry, library, test cases, chat, inbox, workflows,
   workflow controls, settings and workspace administration.
2. **`@xo/permissions` `PermissionManager`** with `RuleBasedPolicy([])` (deny unless a policy is configured). It guards procedures
   (P1.1), the workflow runner's per-step capability checks and the scheduler's service principal.

The permission store is `InMemoryPermissionStore` only. API keys can be revoked (`revokedAt`) but never expire. Chat actions and AI
execution do not pass through either system as a single decision point. `PermissionManager` rules match on permission, domain,
scope, package, capability, environment, principal id and principal kind, but not on a role, and it has no domain for sources,
workflows, knowledge, chat or workspace administration. `SPECIFICATION.md` §10 names the enterprise role set publisher / reviewer /
installer / auditor; `@xo/workflow-runtime` uses the same four names for reviewers.

## Decision

1. **One decision point.** Every operation on every path (HTTP routes, the chat control API, procedures, the workflow service,
   triggers, MCP, AI execution) is authorized by one `authorize(principal, permission, target)` call backed by `PermissionManager`.
   Only `allow` allows; `prompt`, `NO_MATCH`, any other result and any exception deny, and every denial is audited with the attempted
   action (the procedure routes already behave this way).
2. **Roles become policy data.** The workspace role table becomes the default policy: each role is a named bundle of permission ids.
   `@xo/permissions` is extended additively: new domains `workspace`, `source`, `knowledge`, `workflow`, `approval`, `chat` and
   `connection` with their permission ids; a `roles` field on the principal snapshot (scoped to the instance and workspace); and a
   `principalRole` match dimension. The four existing role names stay (they are in the Studio contract and OpenAPI enum).
3. **Identity stays outside policy.** Membership resolution (a non-member gets 404, so a workspace's existence is not disclosed) runs
   before authorization, and "the owner is always `admin`" is a membership invariant, not a policy rule that can be edited away.
4. **Persistence.** A persistent `PermissionStore` implementation lives in the instance data directory (ADRs 0016, 0017, 0023).
5. **Credentials.** API keys gain expiry and rotation alongside the existing revocation; the hashed, scoped, expiring, revocable and
   rotatable token design from `xo serve` is the model. Step-up re-authentication is required for approvals (ADR 0014).
6. **Service principals** are deny-by-default and can never approve an effect (ADR 0014).

## Controls that must survive (UW-1 equivalence tests)

UW-1 must show, with a 4-roles × every-route test matrix, that the policy gives exactly today's answers, and must keep: 404 before
403 for non-members; owner always `admin`; denial audit events with the attempted action; "run a test case" allowed to `author` or
`review`; procedure checks running before any body is read; `prompt` treated as deny; a failing policy engine treated as deny.

## Consequences

- Chat and AI execution can only act through permissions they are granted, which closes the "chat is an unauthorized-execution
  vector" risk for UW-12.
- The P1.0/P1.1 permission ids keep their names and meaning; the change is additive.
- Until UW-1 lands, the two systems remain and this ADR describes the target.

## Implementation (UW-1a, 2026-11-13)

- `@xo/permissions`: new `workspace` domain with six ids that mirror the role table exactly (`workspace.read|author|publish|review|
audit|manage`); a `role` match dimension (matched against the server-supplied `context.role`); `DomainCeilingPolicy`, which caps
  one domain by a ceiling policy, lets the operator policy narrow it with an explicit `DENY`, and returns an explicit `DENY` (never
  `NO_MATCH`) outside the ceiling so neither a stored grant nor an operator `ALLOW` can widen it.
- `apps/api`: one `PermissionManager` per server (`createAuthorizationPolicy`), attached to every request. `requirePermission` asks it;
  `requireOwnedWorkspace` asks it for `read` after the membership check, so an operator suspension reaches every workspace route
  including reads. Denials stay 403, are audited as `access.denied`, and now say whether the role or the instance policy refused
  (`deniedBy`).
- Finer-grained ids (`source.*`, `workflow.*`, `chat.*`, `connection.*`) are added additively by the workstreams that own those
  surfaces; a role's default bundle must keep reproducing the coarse answer.
- Behaviour change, deliberate: an operator `DENY` rule now applies to workspace operations too. One test fixture that used an
  unscoped `DENY` to simulate withdrawing a single capability grant was scoped to that grant (assertions unchanged).
- Proof: `apps/api/test/single-authorization-point.test.ts` (4 × 6 equivalence matrix, allow-all cannot widen, suspension narrows,
  fail closed, end-to-end routes) and `packages/permissions/test/ceiling.test.ts`.

## Implementation (UW-1b, 2026-11-13)

- **Persisted operator policy** (the "persistent store" of point 4): `<WORKSPACE_DATA_DIR>/_instance/policy.json`, strict schema
  (`ALLOW`/`DENY` only, six match keys, every value validated, no unscoped rule), written atomically with a revision check by
  `apps/api/scripts/manage-policy.ts`, loaded at start-up and re-read every 10 s. A broken file suspends every operator `ALLOW` (fail
  closed) without touching workspace roles; an `ALLOW` that would reach workspace operations is rejected (roles decide those; the file
  may only `DENY` them, to suspend someone). It combines with a code-supplied policy by deny-overrides (`DenyOverridesPolicy`). This is
  the first way to grant procedure, effect or audit permissions in a shipped instance without changing code.
- **Package-scoped grant persistence** (`PermissionStore`) is not wired: no API path creates such grants today (they belong to the
  runtime/CLI consent flow). It stays in-memory in the API until a workstream adds a grant-creating path.
- **API keys** (point 5): every newly issued key carries `expiresAt` (default 90 days, 1–3650); keys issued earlier are bounded by
  `XO_API_KEY_MAX_AGE_DAYS` (default 365) from `createdAt`; an expired key is refused with `401 XO_AUTH_KEY_EXPIRED`. `manage-keys.ts
rotate` issues the new key first and then revokes the identity's other keys, so a failure never locks the identity out.

## Implementation (UW-1c to UW-1f, 2026-11-13)

- **One object for every path.** `apps/api/src/auth/authorization-point.ts` builds the single `PermissionManager` (role ceiling +
  persisted operator policy + any code policy, deny-overrides). HTTP routes, chat, AI conversations, procedures and the audit access
  controller use it per request; the scheduler now receives the same object from the composition root (`index.ts`). Before this, the
  scheduler ran with its own `RuleBasedPolicy([])`, so operator grants and suspensions did not reach scheduled runs. Proof:
  `apps/api/test/single-authorization-point.test.ts` (22 path groups, including chat, `intelligence/conversations` and procedures, all
  403 for a suspended owner and reachable otherwise) and `apps/api/test/authorization-point.test.ts`. The registry read routes
  validated input before authorizing; they now authorize first, as the rest of the API does.
- **Step-up re-authentication (point 5).** Approving a capability, resolving a human task, approving a procedure or an external
  payload, signing off a workflow, and adding, re-roling or removing a member need a sign-in from the last
  `XO_API_STEP_UP_MAX_AGE_MINUTES` (default 15; 0 = off). "Sign-in" is the session family's creation time (refresh rotation does not
  reset it) or the OIDC token's `auth_time` (absent = not recent). A refusal is `401 XO_AUTH_STEP_UP_REQUIRED` and an `access.denied`
  audit entry with `deniedBy: 'step_up'`; Studio tells the person to sign in again. API keys are not interactive, so step-up does not
  apply to them; whether a service principal may approve effectful work at all is the separate rule in plan B.9 (UW-7).
- **Deterministic hashing and verify-on-load.** XOIR content hashes no longer include `createdAt` and are computed over the stored JSON
  form, so identical sources compile to identical graph hashes and a node hashes the same before and after storage. Every load of a
  stored or client-supplied graph in the API verifies node and edge hashes (`XO_SERIALIZATION_INTEGRITY_FAILED`, 422, or a refused
  approval/execution); graphs sealed by the two earlier schemes still verify (`packages/xoir/README.md` §13). The policy compile path
  no longer fabricates provenance: an unfound sentence is marked `unresolved:` with confidence 0.
- **Audit anchoring and purge.** Workspace audit logs anchor every chain head externally (`XO_AUDIT_ANCHOR_DIR`) and support an
  operator retention purge that is itself a recorded, verified event (`docs/audit-operations.md`).
- **Trust boundary.** `specs/security/TRUST_BOUNDARY.md` (T1–T6, every model path) with the injection corpus
  `specs/security/injection-corpus.json` and structural checks in the packages that own each path.

## Reopen if

A control in the list above cannot be expressed as policy without loss.
