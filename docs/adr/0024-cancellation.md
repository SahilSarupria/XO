# 0024: Cancellation of runs and batches (D-O); replaces the P1.1 "no cancel route" pin

## Status

Accepted, owner-approved in Revision 4 ("Cancellation is required"), recorded 2026-11-13 (UW-0). Signed off 2026-11-13 by Claude
under the owner's explicit delegation of sign-off authority; this is a delegated sign-off, not an independent review. Implemented by
UW-7.

This is a **deliberate, owner-approved replacement** of frozen P1.1 behaviour, the only kind of change the plan's common Definition of
Done allows to a frozen milestone. It is **within** the frozen runtime roadmap: R6 (production execution semantics) names "timeouts
and cancellation" explicitly (owner's master context §12.2), so this does not expand or reorder that roadmap.

## Context

P1.1 M3 pinned the absence of cancel and retry routes and recorded "timeout does not cancel in-flight work" as an accepted limitation.
Two tests pin it today:

- `apps/api/test/procedure-execution.test.ts` — "OpenAPI documents the M3 routes; no cancel or retry route exists";
- `apps/api/test/procedure-closeout.test.ts` — asserts that no response text claims or implies cancellation.

Workflow IR already declares `cancellation.onCancel` (`compensate` | `abandon`) and `@xo/workflow-runtime` has a `cancelled` terminal
state, but no cancel operation (UW-0 spike).

## Decision

1. **Semantics.** Cancelling a run or a batch records the cancel first (durably, before anything else); no dispatch starts after the
   cancel is recorded; items already settled stand; items in flight become `outcome_unknown` until reconciled, never "cancelled";
   cancelling twice is harmless; every cancel is audited. No automatic retries of external effects result from a cancel.
2. **Authority.** Cancel goes through the workflow service (ADR 0011) and the authorization point (ADR 0010).
3. **Policy.** The workflow's declared `onCancel` decides between compensating completed reversible writes and abandoning.
4. **Tests.** When UW-7 adds the route, only the cancel half of the two pinned assertions is retired, by name, with a pointer to this
   ADR. The "no retry route" half stays. Acceptance: UAC-31 (cancel a 300-item batch mid-run).

## Consequences

The frozen roadmap documents are not edited (UAC-23); this ADR is the record of the replacement.
