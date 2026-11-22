# 0047: The control surface, minimal (UW-12b in W4)

## Status

Accepted under the owner's delegation, 2026-11-22. Completes the W4 part of UW-12b; the rest of UW-12b stays in W5.

## Context

The audit before this work found:

- **No Studio screen for batch approval.** UW-8 (ADR 0046) made production starts of effectful generated workflows require a batch approval, but Studio could neither prepare a preview nor approve one. A Studio start in production failed with `XO_BATCH_APPROVAL_REQUIRED`.
- **No screen for cancel or reconcile.** The client had `cancelWorkflowEntityRun` and `reconcileWorkflowEntityEffect` (UW-7) but no screen used them. Unknown outcomes could only be found by reading each run.
- **Runtime approvals only inside the pre-start check.** A step waiting for a reviewer was visible only after a person opened that workflow, certified it again and asked for its runs. The Inbox showed only the older executions' human tasks.
- **No workspace-wide read** of what waits for a person on the workflow runtime.

## Decision

1. **One read for the inbox:** `GET /workspaces/{id}/control/inbox` (read role) returns:
   - `batches`: previews waiting for an approval (unexpired, every item shown exactly, not yet approved) and approved batches not yet used (unexpired);
   - `steps`: approval steps of runs waiting for a reviewer; an item of a batch names its batch and index;
   - `attention`: calls whose outcome is unknown or needs reconciliation;
   - `truncated` when a list passed 200 entries.
   - It decides nothing. Each entry carries the ids the acting routes take, and those routes check role, recent sign-in, separation and the root again. `preparedByYou` lets a client say early that someone else approves; the approve route is what refuses.
   - It is computed on read by walking the workspace's runs. That is enough for the first vertical; an index is deferred.
2. **Studio's Inbox shows runtime work beside the existing decisions**, one list:
   - **A batch:** counts in plain words, the sending account, and the items, exceptions first (page by page, with each call's arguments: text as written, attachments by name and content hash). A reviewer approves after a confirmation, and Studio sends the root of the preview on screen, so a batch that changed since it was loaded is refused. Once approved, someone who can start work starts it with the approval.
   - **A waiting step:** approve or reject, as the reviewer's signed decision.
   - **An unknown outcome:** the person says what happened (it happened, it did not, cannot tell yet), with a required reason and optional evidence. Nothing is sent again.
   - **Cancel:** a run or the whole batch, after a confirmation, from a step, an unknown outcome, or the runtime runs list of the pre-start check.
   - The outcome of an action stays on screen after the item leaves the list.
3. **A Studio start that needs a batch approval prepares the preview instead** (nothing is sent) and says it waits in the Inbox.
4. **Plain-language errors** for `XO_BATCH_APPROVAL_REQUIRED` and `XO_BATCH_APPROVAL_REFUSED`. A refusal shows the platform's own sentence, and the next step follows its reason: another reviewer for separation, reload for a changed root, the existing run for a used approval, otherwise a new preview.
5. **Mobile:** the Inbox is one column below 52rem (as before). Below 44rem every control is at least 2.75rem tall and actions take the full width.

## Consequences

- Production starts of effectful workflows work end to end from Studio: prepare, approve (by someone else), start.
- Unknown outcomes and waiting runtime steps are found in one place.
- Deferred to the rest of UW-12b (W5): the evidence view, the what-XO-knows screen, request-changes and delegation outcomes, typed output artefacts, moving Studio's execution screens to the Workflow entity, an inbox index, and live updates from the change feed.

## Tests

- `apps/api/test/batch-approval.test.ts`: the inbox shows a preview as `awaiting_approval` with `preparedByYou` per caller, then `ready_to_start` after approval, and nothing once it is used.
- `apps/api/test/generated-workflow-runs.test.ts`: the inbox lists a waiting step with its route ids, and drops it once decided.
- `apps/api/test/run-cancellation.test.ts`: the inbox lists the five unknown outcomes of a 300-item batch, each by batch and item, and one fewer after a reconciliation.
- `apps/studio/test/ui/control-surface.test.tsx`:
  - a start that needs approval prepares a preview;
  - the batch view, exceptions first, approval by the root on screen, and a start with the approval;
  - a separation refusal in plain words;
  - a step decision and a confirmed cancel;
  - a reconciliation with a required reason;
  - argument display;
  - the phone tap-target rule.
