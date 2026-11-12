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

## Reopen if

A control in the list above cannot be expressed as policy without loss.
