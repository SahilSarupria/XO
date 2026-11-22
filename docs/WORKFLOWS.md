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

A typical thin client does the following:

1. Fetch a page with `GET /workflow-entities`. Keep its `changesCursor`.
2. Loop on `GET /workflow-entities/changes?cursor=…&wait=25`. When a change names a workflow, re-read that workflow.

## Batch preview and approval (UW-8, ADR 0046)

Before a run that can send or change things, prepare a preview (`POST …/generated-workflows/{id}/previews` with the input and
certificate). It shows exactly what each item would do, with each call's arguments and the account it would send as, and sends
nothing. Items that would stop for a person, or that cannot be shown exactly, come first. Someone with the review role (and, in
production, not the person who prepared it) approves the preview by its `root`. Start with `batchApprovalId`: the start is refused
if anything changed since the approval, each approval step the preview showed is decided by it, and each call must equal what was
approved. The approval is used once; starting again with it returns the same run. In production (`XO_RUN_APPROVAL=required`) a
run with effects cannot start without one.

## The control inbox (UW-12b, ADR 0047)

`GET /workspaces/{id}/control/inbox` (read role) lists everything on the workflow runtime that waits for a person: batch previews
waiting for an approval, approved batches not yet started, approval steps of runs, and calls whose outcome is unknown. Each entry
names the definition, run and step that the acting routes above take; those routes check role, recent sign-in and separation again.
Studio shows these in its Inbox beside the other decisions: a batch with its counts, sending account and items (exceptions first),
approved by the root on screen and then started; a waiting step; a call to reconcile; and cancel, after a confirmation. A Studio start
that needs a batch approval prepares the preview instead and says that it waits in the Inbox.

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
