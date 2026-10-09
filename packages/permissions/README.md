# @xo/permissions

The canonical security/policy layer between an XO package's declared
capabilities and actual runtime execution:

```text
XO Package / Manifest
        │
        ▼
Declared Capabilities
        │
        ▼
Required Permissions          ← CapabilityPermissionRegistry / manifest.ts
        │
        ▼
Permission Manager            ← manager.ts
        │
        ├── Policy            ← policy.ts
        ├── Consent           ← consent.ts
        ├── Scope             ← scope.ts
        └── Permission State  ← store.ts
        │
        ▼
Permission Decision           ← decision.ts
        │
        ▼
Runtime                       ← @xo/runtime's PermissionGate seam
```

Framework-independent: no React, Tauri, Node-, browser-, or OS-specific
APIs, no Studio or Marketplace code. It's a small, in-memory-by-default
kernel that `@xo/runtime`, a CLI, Studio, a registry, a sandbox, or any
server-side service can depend on and drive.

## Why it exists

A package's manifest can declare capabilities that need real-world access —
reading a file, calling an external API, spending an AI provider's tokens.
Something has to decide, deterministically and auditably, whether a given
package gets to do a given thing right now, and that decision has to be
made the same way regardless of which host (Runtime executing a capability,
a CLI granting an override, Studio showing a consent dialog) is asking. This
package is that single source of truth — Runtime, Sandbox, Studio, the
Registry, and the Marketplace all consume it rather than each rolling their
own policy logic.

## Permission model

A **permission** is a strongly typed `PermissionId` (`permission-id.ts`) —
`"domain.action"`, e.g. `"filesystem.read"`, `"ai.external-provider"`. The
domain is one of a closed set (`domain.ts`):
`filesystem · network · process · environment · secrets · clipboard · device
· ai · data · package · runtime`. The action isn't closed — a new
`filesystem.*` operation doesn't require a code change here — but the
domain is, so a manifest can't invent a namespace out of thin air. The
canonical example ids from the spec are pre-defined and exported as
`Permissions.filesystem.read`, `Permissions.ai.externalProvider`, etc.

## Scope model

A `PermissionScope` (`scope.ts`) narrows a permission to `global`,
`resource`, `path`, `host`, `package`, or `capability`. `scopeContains`
decides whether a granted scope authorizes a requested one:

- `global` authorizes anything; a non-global grant never authorizes an
  unscoped request (no accidental wildcard escalation).
- `path` is segment-boundary aware: `/workspace/project` authorizes
  `/workspace/project/src/index.ts` but **not** `/workspace/project-secret`.
- `host` supports exact match or a `"*.suffix"` wildcard subdomain.
- `resource` / `package` / `capability` require exact match — no partial
  matching, since there's no well-defined "sub-resource" notion for these.

## Policy evaluation

`RuleBasedPolicy` (`policy.ts`) is a flat, ordered list of `PolicyRule`s
(`ALLOW`/`DENY`/`PROMPT`, matched on permission/domain/scope/package/
capability/environment) plus a `defaultEffect` (default `DENY`).

**Precedence**, read this before writing rules:

1. **Most specific matching rule wins.** Specificity is computed from how
   many dimensions a rule pins down (exact permission beats domain-only;
   package/capability pinned beats not; narrower scope beats broader).
2. **Among rules tied on specificity, `DENY` beats `ALLOW` beats `PROMPT`.**
   The fail-safe tiebreak.
3. **No matching rule** → the policy's `defaultEffect` (`DENY` by default).

This deliberately differs from the spec's own literal example precedence
order ("explicit deny > explicit scoped allow > broader allow > default >
prompt"), which is self-contradictory against the spec's own worked
example (a scoped allow overriding a *broader* global deny is impossible
if "explicit deny" always wins outright). "Most specific rule wins, ties
go to deny" is what real ACL/firewall engines do, resolves the
contradiction, and makes the worked example actually work — see
`policy.ts`'s doc comment for the full reasoning.

`evaluate()` is synchronous and pure: same request + same rule set always
produces the same verdict.

## Consent

`PermissionConsentProvider` (`consent.ts`) is the seam a host implements
for an actual consent UI. This package never implements one. With no
provider configured, a `prompt` decision from `PermissionManager.request()`
stays unresolved — it never silently collapses to `allow`.

**Consent can only narrow a requested scope, never widen it — this is
enforced, not just documented.** `PermissionManager.request()` validates
`consent.scope ⊆ requested scope` (via `scope.ts`'s `scopeWithinRequest`,
built on the same `scopeContains` the rest of this package uses — no
second scope-comparison system) before ever creating a grant. A consent
response that attempts to widen the scope, or whose `scope` is
structurally malformed (`isPermissionScope` fails), is rejected outright:
the resulting decision is `deny` (`policyId: 'system.fail-closed'`), and
no grant — narrowed or otherwise — is ever persisted for it. An unscoped
(`global`) request accepts any consent-narrowed scope, since there's
nothing narrower than "everywhere" to violate.

## Persistence

`PermissionStore` (`store.ts`) persists **only `allow` grants** — there is
no persisted "deny grant". Deny is always derived from the policy engine
(see "Stored grant vs. policy precedence" below); revocation only ever
needs to *remove* an allow grant. `InMemoryPermissionStore` is included
for tests and for hosts that only need `once`/`session` lifetimes; a real
deployment supplies its own backend (SQLite, an OS credential store,
encrypted cloud storage) implementing the same interface — the engine
never changes either way.

- **`once`** — never persisted; non-persistence *is* the consumption
  mechanism.
- **`session`** — persisted, cleared by `PermissionManager.endSession()`.
- **`persistent`** — persisted, survives restarts if the store does,
  until explicitly revoked.

## Stored grant vs. policy precedence

A stored `allow` grant and the policy engine are two independent sources
of authorization, and they can disagree. The precedence is:

1. **An explicit, matching policy `DENY` rule always overrides a stored
   grant.** This is what makes emergency revocation through policy
   possible — a host can add one `DENY` rule and immediately override
   every existing grant for that permission/scope/package, without
   walking the store and deleting each grant individually. "Explicit"
   matters here: this is the policy engine actually matching a `DENY`
   rule, never the *default-deny fallback* that applies when nothing
   matches. The fallback must not override a grant, or grants would be
   pointless — a grant exists precisely for permissions no policy rule
   covers.
2. **Otherwise, a matching stored grant wins.** This covers the normal
   case (most permissions have no explicit policy opinion at all, and a
   persisted grant is exactly what's supposed to authorize them), a
   policy `ALLOW` that agrees with the grant, and a policy `NO_MATCH`
   that leaves the grant as the sole authority — all three collapse to
   the same `allow` outcome.
3. **No matching grant** falls through to the policy verdict exactly as
   it would with no grant involved at all (`ALLOW`/`PROMPT`/default-`DENY`).

Both halves of this — `RuleBasedPolicy.evaluate`'s own rule-specificity
resolution, and this grant-vs-verdict combination — are pure functions of
(request, policy state, store state); none of it depends on insertion
order, into either the policy's rule list or the store.

## Revocation

`PermissionManager.revoke()` supports revoking a single permission, a
scoped grant, everything tied to a capability, everything for a package,
or everything system-wide. Revocation takes effect immediately for future
`check()`/`request()` calls. It cannot and does not undo an operation that
already ran using a since-revoked grant — this package has no way to know
what that operation did.

## Capability → permission mapping

Two composable sources feed a capability's required permissions, and
`@xo/runtime`'s `PermissionGate` (see below) merges both automatically:

1. **The manifest** (primary, automatic). `manifest.ts`'s
   `resolveManifestCapabilityPermissions` groups every manifest permission
   declaration that names a `capabilityId` into a per-capability
   requirement list — see "Manifest integration" below. Nothing needs to
   be registered anywhere for this to take effect; the manifest *is* the
   registration.
2. **`CapabilityPermissionRegistry`** (`capability-mapping.ts`,
   supplementary). For capabilities that aren't backed by a manifest at
   all — e.g. a built-in Runtime capability. Lets such a capability
   register the permissions it needs without touching the policy engine.

## Manifest integration

`@xo/types`' `XoManifest` gained two new, optional, backward-compatible
fields on each permission declaration:

```json
{
  "permissions": [
    { "permission": "filesystem.read", "scope": "/workspace", "capabilityId": "financial.document.read" },
    { "permission": "network.connect", "scope": "api.example.com" }
  ]
}
```

Absent `permissions` means zero permission requirements — under this
package's default-deny model, that's "requests nothing", never "may do
anything". A manifest's scope is a plain string with no explicit kind;
`manifest.ts` resolves the scope's kind from the permission's *domain*
(`filesystem.*` → `path`, `network.*` → `host`, everything else →
`resource`) — a documented heuristic, not a general scope grammar. A
permission needing a different scope shape should be requested
programmatically via `request.ts` instead.

**`capabilityId` is what makes a declaration enforced, not just
informational.** A declaration naming a `capabilityId` (matching one of
the manifest's own `capabilities[].id`) is picked up automatically by
`@xo/runtime`'s `PermissionGate` and enforced against that capability —
see "Runtime integration" below. A declaration with no `capabilityId` is
package-level metadata only ("this package may need X somewhere") and is
never attributed to, or enforced against, any specific capability.
Deliberately conservative: adding this optional field can never silently
start denying a capability that was previously unrestricted, and a
capability with no `capabilityId`-matched declaration at all is
permissionless *by design*, not by omission (see "Fail-closed on missing
requirements" below for the distinction that matters).

`@xo/runtime`'s `PackageLoader.mount` refuses to mount a package whose
manifest has a malformed permission declaration (reusing
`resolveManifestCapabilityPermissions` — no duplicated parsing logic) —
fail fast, before the package can ever be selected for execution.

## Runtime integration

`@xo/runtime` gained a `PermissionGate` port
(`permissions/permission-gate.interface.ts`) that `ExecutionPipeline`
calls right after resolving the mounted package for a planned capability,
before any retrieval/prompt work — the same seam `SafetyPipeline` uses.
The default, `allowAllPermissionGate`, is a no-op: **every existing
`ExecutionPipeline`/`ExecutionEngine` behavior is unchanged** unless a
host explicitly wires in a real gate via `ExecutionPipelineOptions.permissionGate`
/ `ExecutionEngineOptions.permissionGate`.

**Both the primary and every auxiliary capability pass through this same
gate.** `request.auxiliaryCapabilityIds`' data is retrieved and merged
into context alongside the primary capability's own — without a check
there, an auxiliary id would be a live bypass: a capability whose own
permission check would fail could still have its data pulled in as an
"auxiliary" of some *other*, permitted request. There is no path through
`ExecutionPipeline` that reaches component retrieval or the AI provider
without a gate check first, primary or auxiliary alike; an auxiliary
denial fails the whole request rather than silently dropping that one
source.

`@xo/runtime`'s `permission-manager-gate.ts` is the one file in that
package that imports `@xo/permissions` — it adapts a real
`PermissionManager` into a `PermissionGate`, resolving each capability's
requirements straight from the mounted package's manifest on every check
(see "Capability → permission mapping" above):

```ts
import { InMemoryPermissionStore, PermissionManager, Permissions, RuleBasedPolicy } from '@xo/permissions';
import { createPermissionManagerGate } from '@xo/runtime';

// The manifest declares:
//   { "permission": "filesystem.read", "scope": "/workspace", "capabilityId": "financial.document.read" }
// — no separate registration call needed for this to be enforced.

const manager = new PermissionManager({ policy: new RuleBasedPolicy([]), store: new InMemoryPermissionStore() });
const gate = createPermissionManagerGate({ manager }); // registry: is optional, for non-manifest capabilities

const engine = new ExecutionEngine(getContext, installer, provider, { permissionGate: gate });
```

A denied permission surfaces as a `RuntimeError` with code
`XO_RUNTIME_PERMISSION_DENIED` (added to `@xo/errors`), before the AI
provider is ever called. The gate calls `manager.check()`, never
`manager.request()` — it never triggers a consent prompt mid-execution; a
host wanting prompt-driven execution should resolve `prompt` decisions via
`request()` earlier, e.g. during planning.

**Production wiring.** `apps/cli`'s `xo runtime run` command — the one
real, non-test, non-playground `ExecutionEngine` construction site in
this repository — wires a real `PermissionManager` (strict default-deny
policy, a fresh process-local `InMemoryPermissionStore`) into its
`ExecutionEngine` rather than relying on the default allow-all gate. A
package that declares no permissions is completely unaffected; a package
that does is enforced with no CLI flags, UI, or manual registration
involved. There is deliberately no `--allow`/`--grant` flag yet — a
durable, cross-invocation grant store and any CLI UI for managing grants
are a later stage (see "What this package deliberately does not do").

## Fail-closed on missing requirements

There is a real distinction between "this capability is permissionless"
and "this capability is privileged but its requirements were never
registered" — and this architecture closes that gap structurally, not by
convention: because a capability's requirements are resolved fresh from
its manifest on every check (never from a registry a host has to
remember to populate), there is no separate "registration" step to
forget in the first place. A capability's permission requirements and
their enforcement are the same act — writing the `capabilityId`-tagged
declaration into the manifest. The only way a privileged capability's
declaration doesn't reach enforcement is if it's malformed, and that's
handled explicitly: `resolveManifestCapabilityPermissions` reports a
parse error, `PackageLoader.mount` refuses to mount the package at all,
and — as defense in depth, for a manifest that reached the gate some
other way (e.g. a hand-built test fixture) — `createPermissionManagerGate`
also denies the capability outright rather than silently treating a
malformed declaration as "no requirements".

## Security guarantees

- **Default deny** — an unmatched request denies; a malformed permission id
  fails closed (`system.fail-closed`), never throws.
- **No wildcard escalation** — `scopeContains` never lets a scoped grant
  authorize a broader or differently-kinded request; the same guarantee
  extends to consent (`scopeWithinRequest`, see "Consent" above).
- **Explicit scope matching** — segment-boundary-aware for paths, exact
  for resource/package/capability, suffix-anchored for wildcard hosts.
- **No permission string spoofing** — `PermissionId` validates format and
  domain membership; `isPermissionScope` validates scope shape at runtime
  for values that didn't go through the type checker (e.g. an external
  consent provider); nothing free-form reaches the policy engine.
- **Deterministic evaluation** — `RuleBasedPolicy.evaluate` is pure, and
  the grant-vs-policy combination in `PermissionManager` doesn't depend
  on insertion order either.
- **Fail closed** — store failures, malformed requests, malformed consent
  scopes, and malformed manifest permission declarations all deny, never
  throw to the caller and never silently downgrade to "no requirements".
- **No implicit trust** — a package gets nothing merely by being
  installed/mounted; every check goes through policy + stored grants.
  Auxiliary capabilities get no special treatment — see "Runtime
  integration" above.
- **No UI coupling** — consent is a caller-supplied interface, never
  implemented here.

## Testing

92 tests in `@xo/permissions` across `permission-id`, `scope`, `policy`,
`manager`, `store`, `capability-mapping`, and `manifest` — including
dedicated suites for consent scope escalation and stored-grant-vs-policy
precedence. Plus, in `@xo/runtime`: 5 tests in `permission-gate.test.ts`
(the gate wired into `ExecutionEngine` in isolation), 15 tests in
`permission-integration.test.ts` (manifest → mount → gate → manager →
decision → execution, including every case from this stage's spec:
no-grant, valid grant, scope mismatch, revoke, consent narrowing, consent
widening rejection, and policy-overrides-grant), and 2 tests in
`apps/cli`'s `run.test.ts` proving the production CLI wiring enforces a
real denial and stays backward compatible for permissionless packages.
Run:

```bash
npm run test --workspace=@xo/permissions
npm run test --workspace=@xo/runtime
npm run test --workspace=@xo/cli
```

## What this package deliberately does not do

OS-level sandboxing, Studio/CLI UI, authentication, registry
infrastructure, a full logging platform, a durable (SQLite or otherwise)
`PermissionStore` backend, or a second policy/permission model layered on
top of an existing one. Those are for Runtime, Sandbox, Studio, the CLI,
and the Marketplace.
