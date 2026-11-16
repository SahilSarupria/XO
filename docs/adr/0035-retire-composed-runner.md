# 0035: Retire the composed-workflow runner wherever certificates are required, and drain it elsewhere

## Status

Accepted under owner delegation, 2026-11-16. The owner delegated this decision explicitly on 2026-11-16 ("make the decision and the
appropriate changes"). This settles ADR 0011 decision 4: "retiring the segmented runner is a separate owner-approved step". Signed
off by Claude under that delegation. This is a delegated sign-off, not an independent review.

## Context

There are two engines for compiled workflows:

- **The composed runner** (P0.8, `apps/api/src/workflows/workflow-runner.ts`) runs a candidate workflow's steps through `@xo/runtime`
  in segments.
- **The Workflow IR runtime** (`@xo/workflow-runtime`) is the canonical engine (ADR 0011). It has journal, intent-before-effect,
  cancellation and effect states (ADR 0033).

Since UW-7, every certified definition has a construct that only the IR runtime runs: a not-done escalation after each person's
task. So in practice certified starts already went to the IR runtime. Auditing the composed side before deciding found a defect:

- **The defect: triggers bypassed the certificate requirement.** Only `POST …/workflows/{id}/executions` checked the readiness
  certificate. The scheduler, the webhook route and the Studio draft launcher all call `startWorkflowAudited` directly. In a
  workspace that requires certificates (the production default), a schedule or a webhook could still start an uncertified workflow
  on the composed runner.
- **The composed runner still supports features nothing else has yet:** practice (shadow) runs with reviewer judgements, the
  go-live checklist, the Studio executions screen, and 45 API test files.

## Decision

1. **Wherever certificates are required, the composed runner is retired.**
   - "Required" means the instance policy `XO_READINESS_CERTIFICATE=required` (the production default) or the workspace's
     `trust.requireReadinessCertificate`.
   - The single composed start path (`startWorkflowAudited`) refuses every new start with `409 XO_WORKFLOW_REQUIRES_IR_RUNTIME`
     (`context.reason: composed_runner_retired`). The refusal is audited as `readiness.start.refused`.
   - This covers HTTP, schedules, webhooks and drafts. It closes the trigger bypass at the one place every start goes through.
2. **A certificate always means the canonical engine.**
   - A verified certificate presented to the composed start is always sent to `POST …/generated-workflows/{definitionId}/runs`.
     Before, it was sent there only for IR-only constructs.
   - One certificate has one meaning and one engine.
3. **Triggers run certified workflows on the canonical engine.** A webhook or a schedule that names a certificate runs the
   certified definition through `startGeneratedRun`, the same function the generated-workflow and Workflow-entity routes use. So:
   - the certificate is verified again at every start and every slot (a stale one is refused, with the reason recorded);
   - the workspace pause applies;
   - connector calls are re-authorized against the starter when they happen (ADR 0031);
   - the workflow's own controls apply (trigger on, live, not paused, daily limit).

   Rules specific to triggers:
   - **Who the run starts as.** A scheduled run starts as the person who set the schedule, not as a service identity. A person's
     authority can be revoked; a schedule's should be revocable too.
   - **One slot, one run.** A slot is an idempotency key, so two instances firing the same slot start one run.
   - **No practice runs for certified triggers.** Practice mode is a composed-runner feature, and a certified trigger refuses it
     rather than running for real.
   - **No uncertified schedule.** In a workspace that requires certificates, a schedule without a certificate is refused when it is
     set.

4. **Drain, don't delete.**
   - Executions that already exist can still be read, decided and resumed until they finish.
   - Uncertified starts remain only in development workspaces, and the route is marked deprecated.
   - The composed runner's code is removed when the Studio executions and practice screens move to the Workflow entity (UW-12b).
     Development workspaces then generate and certify workflows as production does, locally and automatically, as Studio already
     does.
5. **Out of scope.** P1.1 procedures are a separate engine, and ADR 0024's pin on them stays until they move.

## Consequences

- **Production runs one engine** for every start, manual or triggered.
- **Behaviour change (production):** schedules and webhooks set up without a certificate no longer start runs. Schedules record
  `skipped: …` with the reason; webhooks get a 409. Fix: issue a certificate and set it on the trigger.
- **Behaviour change (development, `optional` policy):** a certified approve/decide-only workflow presented to the composed start now
  goes to the IR runtime. Studio already follows that response.
- **Daily limits count composed runs only.** Counting IR runs is a follow-up.

## Reopen if

- A production workspace needs practice runs for a certified workflow. In that case, build shadow mode into the IR runtime; do not
  reopen the composed runner.
