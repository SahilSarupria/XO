# 0052: The control surface, the rest; the composed runner's code removed (UW-12b)

## Status

Accepted under the owner's delegation, 2026-11-23. Completes UW-12b after ADR 0047. Decisions 1 to 4 land in `uw-12b2/control-api`,
decision 5 in `uw-12b2/studio-control-screens`, decision 6 in `uw-12b3/remove-composed-runner`. Completes ADR 0035 decision 4.

## Context

ADR 0047 left for W5: the evidence view, the what-XO-knows screen, request-changes and delegation, typed output artefacts, moving
Studio's execution screens to the Workflow entity, an inbox index and live updates. ADR 0049 left a picker between several fitting
item sources; RX-1 left emergency stops without a screen; ADR 0035 removes the composed runner's code once Studio no longer needs it.

## Decision

1. **The inbox is computed from the runs, cached by file identity.** A read re-derives only files whose size or modification time
   changed, so the cache cannot disagree with the runs. Clients wait for changes with a long-poll on the inbox's entity tag.
2. **An evidence view per item** says where the item came from, what was approved and by whom, what each call did, and whether the
   run's record is intact. It is shown to workspace members, as previews already are.
3. **Outcomes:** request changes on a batch preview; delegate a waiting step to another reviewer (only they may then decide it; an
   admin can take it back); revoke an unused batch approval or a standing approval (ADR 0051).
4. **Typed output artefacts:** deliveries, documents and results of a run, each with its type, who may see it and how long it is kept.
   Nothing new is stored.
5. **Studio** shows all of this, adds what XO knows (with review, preview and rollback of knowledge changes), emergency stops, the live
   inbox, the item-source picker, outputs and run learning, and starts and follows work only through the Workflow entity on the
   canonical engine. Practice mode becomes "preview what it would do".
6. **The composed runner's code is removed.** Its start, resume, draft-launch, practice and task-decision routes answer 410 naming
   their replacement. Historic executions stay readable. A stored practice mode reads as draft. Schedules and webhooks need a
   certificate in every workspace. Upgrading refuses while unfinished composed executions exist, unless the operator accepts losing
   them. Tests whose subject was the removed code are retired through a reviewed list that names, for each, the test that now proves
   the same property or why none is needed.

## Consequences

- One engine runs every workflow, in development as in production.
- **Breaking change for API clients** of the removed routes (410 with the replacement path).
- The by-name test comparison gains a reviewed retired list, used by this change only.

## Reopen if

- A customer needs practice runs beyond the preview: build them into the canonical engine (ADR 0035, Reopen if).
- Inbox reads become slow with the cache: add an event index, keeping the walk as the check.
