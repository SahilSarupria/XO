# Workflows (the Workflow entity)

A **Workflow** (`wfl_…`) is one piece of work a person asked XO to do: "send each client their certificate", "ship a
release". It is durable, has versions, and remembers the conversation it was asked in. It is not an XO (nothing is
installed when you create one) and not a conversation (deleting the conversation keeps the workflow). Decisions: ADR 0032.

## The lifecycle a client shows

| Lifecycle                            | Meaning                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `draft`                              | The current version has not been checked (no READY certificate yet).                                                                              |
| `ready`                              | The current version has a READY or READY_WITH_CONDITIONS certificate. Every start checks it again.                                                |
| `awaiting_approval`                  | A run is waiting for a person's decision.                                                                                                         |
| `running`                            | A run is in progress, including one waiting on a timer.                                                                                           |
| `paused`                             | New starts are held: the workflow, or the whole workspace, is paused.                                                                             |
| `needs_attention`                    | The latest run escalated to a person (for example, a connector outcome XO could not confirm).                                                     |
| `completed` / `failed` / `cancelled` | How the latest run of the current version ended. A run that was undone (compensated) counts as `cancelled` after a cancel and `failed` otherwise. |
| `partially_completed`                | The latest run was a batch in which some items completed and the others failed (UW-7).                                                            |
| `archived`                           | Put away. Hidden from lists and cannot start; history and runs are kept.                                                                          |

The lifecycle is worked out from the stored facts every time it is read. No second copy of it is stored.

## The API

All paths are under `/workspaces/{workspaceId}`. The API document (`GET /openapi.json`) has the details.

| Call                                                         | What it does                                                                                                                                                                 | Permission                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `POST /workflow-entities`                                    | Create from `{ compilationId, goal }` or `{ definitionId }`. Add `conversationId` and `messageId` to link it to your conversation; without a goal, that message is the goal. | author                             |
| `GET /workflow-entities`                                     | Compact summaries, newest first. Supports `limit`, `cursor`, `lifecycle`, `archived=true` and `conversationId`.                                                              | read                               |
| `GET /workflow-entities/changes?cursor=&wait=`               | What changed since the cursor. Use `wait` (up to 25 s) to long-poll.                                                                                                         | read                               |
| `GET /workflow-entities/{id}`                                | Lifecycle, versions, runs, pending approvals and history.                                                                                                                    | read                               |
| `PATCH /workflow-entities/{id}`                              | Rename (`expectedRevision` optional).                                                                                                                                        | author                             |
| `POST …/{id}/versions`                                       | Add a version (for example after recompiling). Anything you leave out stays as it is.                                                                                        | author                             |
| `POST …/{id}/pause`, `resume`, `archive`, `restore`          | Change the flags.                                                                                                                                                            | author                             |
| `POST …/{id}/readiness`                                      | Issue a readiness certificate for the current version.                                                                                                                       | author                             |
| `POST …/{id}/runs`                                           | Start the current version. XO presents the latest certificate for it.                                                                                                        | author                             |
| `GET …/{id}/runs`, `GET …/{id}/runs/{runId}`                 | Runs of every version, and one run with its verified decisions.                                                                                                              | read                               |
| `POST …/{id}/runs/{runId}/approvals/{approvalId}`            | Approve or reject a waiting step.                                                                                                                                            | review, and a recent sign-in       |
| `POST …/{id}/runs/{runId}/cancel`                            | Cancel a run, a batch or one item of a batch (`docs/EFFECTS.md`).                                                                                                            | author                             |
| `POST …/{id}/runs/{runId}/effects/{step}/reconciliation`     | Record what happened to a call whose outcome is unknown. Never re-sends.                                                                                                     | review, and a recent sign-in       |
| `GET /intelligence/conversations/{conversationId}/workflows` | The workflows started from one of your conversations.                                                                                                                        | read, and you own the conversation |

**Starting a run.** An `Idempotency-Key` makes a retried start the same run. The same key with a different input is refused (422
`XO_IDEMPOTENCY_KEY_REUSED`) and starts nothing. A start is recorded in the audit trail before anything about the run is written; when it
cannot be recorded, the start is refused (503 `XO_AUDIT_UNAVAILABLE`) and nothing is sent. Both apply to every start of a generated workflow
(the Workflow entity, the definition route, a schedule, a webhook and a standing approval).

A typical thin client does the following:

1. Fetch a page with `GET /workflow-entities`. Keep its `changesCursor`.
2. Loop on `GET /workflow-entities/changes?cursor=…&wait=25`. When a change names a workflow, re-read that workflow.

## Batch preview and approval (UW-8, ADR 0046)

Before a run that can send or change things, prepare a preview (`POST …/generated-workflows/{id}/previews` with the input and
certificate). It shows exactly what each item would do, with each call's arguments and the account it would send as, and sends
nothing. Items that would stop for a person, or that cannot be shown exactly, come first. Someone with the review role (and, in
production, not the person who prepared it) approves the preview by its `root`. Start with `batchApprovalId`: the start is refused
if anything changed since the approval, and each call must equal what was approved. The approver names the steps a person does that the
approval also decides (`presignSteps`; the preview lists them as `stepsToApprove`); every other such step waits for a person in each item
(ADR 0051). The approval is used once; starting again with it returns the same run. In production (`XO_RUN_APPROVAL=required`) a
run with effects cannot start without one.

A schedule may name the confirmed list or pairing its items come from (`schedule: { everyMinutes, certificateId, items: { connectionId,
proposalId } }`; it replaces the `forEach` input). In production, a slot of a workflow that can send or change things prepares the batch
preview as the person who set the schedule and sends nothing; it waits in the Inbox, and the slot records `preview prepared (pvw_…)`. One
slot gives one preview, however many instances fire it. In development a slot with an item source builds its items and starts.

## Standing approvals (UW-16b, ADR 0051)

A standing approval is a signed policy: one person proposes, someone else approves, and from then on runs that stay inside its bounds start
without a per-batch approval. Each run still gets its own preview and its own batch approval (minted from the policy, signed as the
approver), so every batch check (start, each call, argument for argument) still runs.

- **Propose** (`POST …/standing-approvals`, author role, a person): the workflow, the certificate, where its items come from (a confirmed
  source, or an exact input), `limits` (items per run, items and runs per day, week or month in UTC, excluded rows), the triggers
  (`manual`, `schedule`), who it starts as, and up to 90 days of life. It prepares a sample preview of today's items. Every argument a
  write or irreversible step takes from an item is pinned to the values in the sample unless named in `mayVary`; an irreversible step
  keeps at least one pinned. The view shows counts of pinned values, never the values, and a `policyDigest`.
- **Approve** (`…/approve`, review role, recent interactive sign-in, a person; an API key or service is refused): by the digest shown.
  Not the proposer and not the person it starts as. When separation is off and nobody else may review, a self-approval is allowed and is
  shown as `selfApproved` everywhere. The sample must be under 24 hours old.
- **Use**: `POST …/standing-approvals/{id}/runs` (the named person; `Idempotency-Key` makes a retry one run), or a schedule that names
  `standingApprovalId`. Inside the bounds the run starts (201). Outside them (more items, a value or input the sample did not contain, a
  changed binding, a period limit, a revoked or expired approval) the start **falls back**: 202 `{ fallback, reasons, previewId }` and an
  ordinary batch preview waits in the Inbox, showing why. Nothing is sent. A schedule slot records `fell back to a batch approval (…)`.
- **Revoke** (`…/revoke`; a reviewer, the proposer or the approver; no recent sign-in is needed): no run starts under it, and a run already
  started under it makes no further call (read again before each call). `xo instance standing-approvals revoke` does the same with the API
  stopped. An unused batch approval can be revoked too (`…/previews/{id}/approval/revoke`).
- A start that names an approval step the policy did not name still waits for a person at that step.
- **In Studio** (UW-16c): on a workflow's page, after "Check before starting" is READY, "Let this run without asking each time" asks for one
  (pick the confirmed source, the limits, when it may run, how long). It starts with every value fixed to the sample; after the proposal,
  tick the values that may change and ask again (the platform keeps at least one value of a step that cannot be undone fixed). The
  proposal appears in the Inbox for someone else, with the bounds in words, the sample (read-only) and Approve / Ask for changes. A batch
  that came from a run outside the bounds says why ("This run needs your approval because: …"). Settings → Standing approvals lists them
  with use this period, expiry and who approved (and "self-approved"), and revokes with a reason and a confirmation. An approved batch
  that has not started can be revoked from the Inbox.

## The control inbox (UW-12b, ADR 0047)

`GET /workspaces/{id}/control/inbox` (read role) lists everything on the workflow runtime that waits for a person: batch previews
waiting for an approval, approved batches not yet started, approval steps of runs, and calls whose outcome is unknown. Each entry
names the definition, run and step that the acting routes above take; those routes check role, recent sign-in and separation again.
Studio shows these in its Inbox beside the other decisions: a batch with its counts, sending account and items (exceptions first),
approved by the root on screen and then started; a waiting step; a call to reconcile; and cancel, after a confirmation. A Studio start
that needs a batch approval prepares the preview instead and says that it waits in the Inbox.

### Control surface additions (UW-12b, ADR 0052)

- The inbox carries an `etag` (also the `ETag` header). `GET …/control/inbox/changes?etag=…&wait=0..25` returns `{ etag, changed }`
  as soon as the inbox differs from the tag (checked once a second) or the wait ends. The inbox is cached per definition: the batch
  listing by the identity of its folders, each run by the identity of its folder; the cache is rewritten by temp-and-rename and an
  unreadable one is ignored and rebuilt. A read always equals a full walk.
- `GET …/runs/{runId}/evidence?item=n` (read): where the item came from (row, match, document), the approval (batch or standing, who,
  which steps it decided), each step and call with its outcome, whether the run's manifest is intact, and the number of observations.
- `GET …/runs/{runId}/outputs` (read): deliveries, documents and results with their type, access (workspace members) and retention
  (until the workspace is deleted).
- `POST …/runs/{runId}/approvals/{approvalId}/delegate` `{ to, reason, revision? }` (review, recent sign-in): `to` must be able to
  review; only they may then decide the step (403 `delegated`); an admin takes it back by delegating to themselves. The inbox shows
  `assignedTo` and `assignedToYou`.
- `POST …/previews/{previewId}/request-changes` `{ comment }` (review): the preview can no longer be approved (`changes_requested`);
  the preparer sees the comment in the preview and the Inbox.
- The evidence, outputs and delegate routes exist under `/workflow-entities/{id}/runs/{runId}/…` too.

### In Studio (UW-12b, ADR 0052)

- **Inbox**: live (it waits on `…/inbox/changes` and reloads on a change; it stops when the Inbox closes). A step shows who it was handed
  to; only that person can decide it. "Hand to someone else" needs a reviewer and a reason (reviewers are named by display name, never by
  email address). "Request changes" on a batch needs a comment; the batch then says so and cannot be approved. "Why XO is asking"
  opens the evidence in words: the source row, the document and how it was matched, who approved, who decided each step, what was done
  and whether the workflow is the one that was certified. Recipients and cell values are not in it.
- **Pre-start check → runs**: "Show results" lists what a run produced (who can open it, how long it is kept), the evidence, and what XO
  noticed; a person can record a correction (a field, a value and a reason) and propose chosen observations as knowledge.
- **Starting**: when more than one confirmed list could give the items, Studio asks which and prepares nothing until a list is chosen.
  "Preview what it would do" prepares a preview of today's items; it never approves, starts or sends anything.
- **What XO knows** (sidebar): known records, disagreements, packs, a search, changes waiting for review (what each would change and
  how many certified workflows it touches; approving or rejecting needs a reason; a stale change cannot be approved), and the history
  with "Go back to this", which proposes a rollback for someone else to approve.
- **Settings → Operations**: emergency stops (see `docs/runbooks/emergency-stop.md`).

## Learning from a run (UW-11b)

`GET …/runs/{runId}/observations` (read) lists what a finished or running batch taught, derived from its own record: outcomes a person
reconciled, steps a person rejected, tasks marked not done, escalations, rows the confirmed source left out or matched loosely, and
corrections. Summaries are plain words built from codes and hold no cell values. `POST …/corrections` (author) records what a field of
an item should have been (field name, a string, number or boolean, and a reason). `POST …/learning-proposals` (author) turns chosen
observations into a proposed knowledge change set of origin `run-outcome`; the knowledge head moves only when a reviewer other than the
proposer approves it, and claims in `xo-run` are never executable. A correction does not change the source file or the run.

## Privacy

Conversations are private to the person who started them. Anyone who can read the workspace can read its workflows,
because approvers must be able to see what they approve. Only the conversation's owner sees which conversation and
message a workflow came from; everyone else sees `{ "store": "cnv", "linked": true }`.

## Storage

Workflows live in the instance data directory, under `<data>/<workspace>/workflow-entities/`:

- **One immutable snapshot per revision.** Writes are compare-and-swap, and safe across API processes.
- **`changes.log`.** The change feed: append-only, with byte-offset cursors.

Backup, restore and erasure cover workflows with the rest of the data directory (`docs/INSTANCE.md`). Runs stay in the
engine's journal (`generated-runs/`). Each run records which workflow and version it belongs to before its first entry.

## Limits

- **Definitions.** Only generated, certified Workflow IR definitions can be a version today. Authored Studio graphs are not yet
  versions. The composed-workflow runner is retired wherever certificates are required (ADR 0035). It remains only for uncertified
  starts in development workspaces, and it is removed once the Studio execution screens move to the Workflow entity (the rest of UW-12b, W5).
- **Pausing.** Pausing a workflow holds new starts only. To stop a run that is already in progress, cancel it (UW-7, ADR 0033).
- **Sizes.** A workspace can hold up to 2,000 workflows, and each workflow up to 100 versions.
- **Change feed.** The feed is not compacted yet.
