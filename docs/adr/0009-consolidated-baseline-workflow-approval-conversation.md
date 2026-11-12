# 0009: Consolidated baseline — one execution authority, one approval contract, two purpose-scoped conversation stores

## Status

Accepted (owner delegated the decision, consolidation of all branches into `main`).

## Context

Merging every active line of work exposed three overlaps:

1. **Three workflow models.** `@xo/runtime` (execution engine used by the API and the API workflow runner), and the newer
   `@xo/workflow-ir` + `@xo/workflow-runtime` (definition, journal, approvals, connectors) which today are consumed **only** by the
   CLI `xo flow` surface (`apps/cli/src/commands/flow/*`). `apps/api` and `apps/studio` do not depend on them.
2. **Three approval mechanisms.** (a) the P1.0 material-state-bound capability approval (`verifyApproval`,
   `deriveCapabilityApprovalState`, `FsApprovalStore`), (b) the P1.1 payload-level approval for one exact external effect
   (`effect.payload-approve`), (c) `@xo/workflow-runtime`'s own `approvals.ts` for the flow journal.
3. **Two conversation stores.** `cht_` threads (`apps/api/src/chat/chat-store.ts`, the authoring assistant in Studio) and `cnv_`
   conversations (`apps/api/src/intelligence/conversation-store.ts`, the customer ASK/DECIDE/DO/LEARN chat, ADR 0008).

## Decision

### Workflows: one execution authority

The **API workflow runner (`apps/api/src/workflows/workflow-runner.ts`) via `startWorkflowAudited`, on `@xo/runtime`, is the only
component that executes workflows for a workspace.** Every start path — HTTP, draft launch, webhook, scheduler (service principal
`trigger-schedule`), controls (pause/limits/shadow) — goes through it, so permission checks, the idempotency gate, durable audit and
the package trust policy cannot be bypassed.
`@xo/workflow-ir` and `@xo/workflow-runtime` are **definition, journal and local-authoring layers**, not a second production engine.
They stay CLI-only until a workflow definition is compiled into a runner request; they must not be imported by `apps/api`/`apps/studio`
to run anything. Future convergence is by having the runner consume `workflow-ir` definitions, not by running two engines.

### Approvals: one contract, two scopes

There is one approval contract: **an approval is bound to the material state it approves and is re-verified at use** (`verifyApproval`;
legacy, stale or foreign approvals fail closed). It has two scopes, deliberately distinct authorities:
capability/procedure approval (`procedure.approve`, bound to the derived capability state) and payload approval for one external
effect (`effect.payload-approve`, bound to the canonical input digest). `@xo/workflow-runtime/approvals` is a CLI-local journal
convenience and grants no authority in the API; it must not be accepted as evidence of approval by the runner.

### Conversations: two stores, one primitive, no merge

`cht_` (authoring assistant: operator-facing, drafts, tool use on workspace content) and `cnv_` (customer intelligence: end-customer
facing, grounded and cited, learn-queue feedback) serve different audiences, retention and review rules, so their records stay
separate and their id prefixes are not interchangeable. Shared behaviour lives in `@xo/ai-core` (`conversation.ts`, model selection,
provider layer); neither store may read the other's records. Merging them would blur an operator/customer trust boundary for no gain.

## Consequences

- Consolidation keeps main's fail-closed behaviour wherever lines disagreed (e.g. Gemini safety blocks are a typed `content_blocked`
  error everywhere, not a successful empty `content_filter` result).
- Package trust policy is required at startup (`XO_PACKAGE_TRUST_POLICY`, or explicit `XO_TRUST_MODE=development` → status `degraded`).
- Scheduled runs use a deny-by-default service principal: steps that declare permissions are refused until an operator grants them.
- Follow-ups: have the runner consume `workflow-ir` definitions; remove the CLI-local approvals once the CLI uses the API contract.
