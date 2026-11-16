# 0011: One workflow authority, one engine: Workflow IR + `@xo/workflow-runtime` behind the API (D-B)

## Status

Accepted under owner delegation, 2026-11-13 (UW-0). Signed off 2026-11-13 by Claude under the owner's explicit delegation of sign-off authority (owner instruction of 2026-11-13); this is a delegated sign-off, not an independent review. Implemented by UW-7.

**Supersedes in part ADR 0009** ("Workflows: one execution authority"): the single execution authority is kept; the statement that
`@xo/workflow-ir` and `@xo/workflow-runtime` stay CLI-only and must not be imported by `apps/api` is replaced by this ADR.

## Context

`main` has five execution paths (`docs/baseline/UW0_BASELINE.md` §7 row 22): `@xo/runtime`'s `WorkflowExecutor`; the API's P0.8
runner, which runs that executor in segments because it has no pause primitive; P1.1 procedures, lowered to `@xo/runtime` graphs;
`@xo/workflow-runtime` (CLI `xo flow`, `xo serve`, SDK); and `@xo/automation`, which runs its own handlers.

The UW-0 conformance spike ran a certificate-style batch through the real `@xo/workflow-runtime` (§8 of the baseline):

- per-item isolation: pass (a rejected item fails alone; the others complete once);
- durable intent before effect: pass (a `call_intent` is on disk before every destination call);
- crash at every journal append, before and after durability, then resume: 108 crash points, **no duplicate effect**; on a destination
  with no idempotency support an unknown outcome escalates instead of re-sending;
- defects: a crash before the first durable entry orphans the run id; a batch with one failed item reports the parent as `failed`;
  cancellation is declared in the IR but not implemented; decisions are bound to run and step, not to the action's content.

`@xo/runtime`'s engine has none of: a pause primitive, `forEach`, a journal, intent-before-effect, compensation, timers, event waits,
leases. Building them there would duplicate `@xo/workflow-runtime`.

Frozen-scope check (risk RK-23, UW-0's first task). The frozen master roadmap is P0.9A/B/C → P0.9 Beta → P1.0 → P1.1 → P1.2 →
Multi-XO Foundation → P1.5 → P1.7 → P2 → P3, and the separately frozen runtime roadmap is R1 authoritative execution metadata /
strategy decision point, R2 input contracts and schema validation, R3 confidence and authorization gating, R4 generalized
execution-strategy router, R5 hybrid execution, R6 production execution semantics (structured errors, execution ids and tracing,
timeouts and cancellation, retry and idempotency, replay, simulation, capability-collision handling) (owner's master context, §12.2
and §15). Neither names an engine. P1.1's scope is procedures as built (M1–M6), kept unchanged behind a port. R1–R3 stay in
`@xo/runtime`, which becomes the capability port; R4–R6 are delivered through this engine without reordering them: the engine
already implements much of R6 (durable execution ids, intent/outcome journal, idempotency, replay, dry-run/shadow simulation), so the
choice serves the frozen runtime roadmap rather than expanding it. The owner's Revision 4 instruction states: "The workflow engine
may replace the P1.1 one if it is better." This ADR records that replacement. No milestone name, order or acceptance criterion
changes.

## Decision

1. **One authority (kept from ADR 0009).** Every start, resume, decision and cancel goes through the API's workflow service:
   authorization (ADR 0010), the idempotency gate, audit, the package trust policy, instance and workflow pause, and caps. Triggers
   (ADR 0025), chat, MCP, Studio and the CLI against an instance all call it. Nothing else starts a run.
2. **One definition, one engine.** Workflow IR 1.0 (`@xo/workflow-ir`) is the canonical workflow definition, and
   `@xo/workflow-runtime` is the canonical executor inside that authority.
3. **Ports** (each fail-closed when absent):
   - **Effects:** write operations dispatch through `@xo/adapters` (ADR 0015), so the six-state effect ledger, reconciliation and
     payload approval apply. One table maps journal entries (`call_intent`, `call_outcome`, ambiguity) to adapter states.
   - **Capabilities:** a step that runs a compiled XO capability executes through `@xo/runtime`'s `RuntimeCapabilityExecutor`,
     keeping R1–R6 behaviour. `@xo/runtime` becomes the capability adapter, not a workflow engine.
   - **Approvals:** `approve` steps use the one approval primitive (ADR 0014). `workflow-runtime`'s local Ed25519 decisions remain for
     offline CLI use and grant no authority inside an instance.
   - **Storage and leases:** `RunStore` and leases sit behind interfaces in the instance data directory (ADR 0023), one runner process
     per instance.
4. **Migration without a flag day.** The P0.8 runner and P1.1 procedures stay as built behind a port, and their tests are preserved
   by name (`docs/baseline/tests-26f0052.tsv`). Capability workflows (`CandidateWorkflow`) and procedures gain a lowering to Workflow
   IR; each path moves once parity tests pass. Retiring the segmented runner is a separate owner-approved step, not part of UW-7.
5. **UW-7 fixes the spike's defects first:** orphaned run ids (a run directory with no durable first entry must be recoverable by a
   start with the same id); a partial-completion state for batches; cancellation (ADR 0024). Content-bound approval is UW-8.

## Consequences

- The certificate vertical's batch, recovery and reconcile needs are met by code that already exists and passed the spike.
- `apps/api` gains a dependency on `@xo/workflow-ir` and `@xo/workflow-runtime`.
- `@xo/automation`'s own execution path is retired by ADR 0025.

## Reopen if

A conformance property fails in UW-7 and cannot be fixed inside `@xo/workflow-runtime` without rewriting it.
