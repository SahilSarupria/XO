# 0032: The Workflow entity — durable work linked to its conversation, with a derived lifecycle (UW-2)

## Status

Accepted under owner delegation, 2026-11-16 (UW-2, wave W2). Signed off by Claude under the owner's delegation of decision
authority; this is a delegated sign-off, not an independent review. It implements ADR 0013 (one conversation store) for
workflows and the thin-client state API of ADR 0022, and settles the lifecycle set the plan left to D-B (ADR 0011).

## Context

Before UW-2, a "workflow" was four different things, none of them durable work a person could come back to:

- an authored graph in Studio (`wfd_…`, `workflow-definitions`);
- a candidate composed from a compilation (`workflows`, run by the composed-workflow runner, `wfx_…`);
- a generated, certified Workflow IR definition (`gwf_…`, PX-6 to PX-10), run by `@xo/workflow-runtime`;
- a P1.1 procedure.

Nothing linked any of them to the conversation a person asked in (plan gap A2), nothing had versions across runs, and a
client had to know the definition id, the certificate id and the run id to follow one piece of work. Revision 4 asks for
a durable Workflow entity with an origin conversation, versions, a lifecycle, provenance, approvals and execution links;
many workflows per conversation; and a compact, paginated state API with change notifications for thin clients.

## Decisions

1. **One entity, `wfl_…`, per piece of work.** It is distinct from an XO (an installed package: creating a workflow installs
   nothing) and from a conversation. It owns its name, its origin, an ordered list of immutable versions, and two flags a
   person sets: `paused` (new starts are refused) and `archived` (hidden and not startable; history and runs kept).

2. **A version points at one content-addressed definition.** Today that is a generated Workflow IR definition (`gwf_…`, with
   its `definitionDigest` and compilation): it is the only definition kind with a readiness certificate and the canonical
   engine (ADR 0011). The reference is a tagged union, so another kind can be added without rewriting stored records. A new
   version carries over every unstated part of the current one (the same goal, field for field, over the same compilation);
   a version identical to the current one is refused.

3. **The origin is a `cnv_` conversation, never `cht_` (ADR 0013).** `ConversationRef { store: 'cnv', conversationId,
messageId? }`. Creating from a conversation requires owning it; without a stated goal, the person's message is the goal.
   A reply (an assistant message) cannot be the prompt. Deleting the conversation never deletes the workflow: the link stays,
   reported as `available: false` to its owner.

4. **Runs are not copied into the entity.** Every run started for a workflow records, in its meta file before its first
   journal entry, `{ workflowId, version }`. The entity reaches its runs through a port (`WorkflowRunPort`), which reads
   the engine's own journal. There is therefore one truth for what a run is doing; UW-7 extends the port (cancellation)
   without the entity changing. An `Idempotency-Key` on a workflow start binds the workflow into the run id, so the same key
   on two workflows that share a definition is two runs, and a retry is the same run.

5. **The lifecycle is derived, in this order:** `archived`; else a run in progress of any version → `awaiting_approval`
   (a person's decision is pending) or `running`; else `paused` (the workflow or the whole workspace); else the latest run of
   the current version → `completed`, `failed`, `needs_attention` (escalated) or `cancelled`; else `ready` when the current
   version's latest certificate is READY or READY_WITH_CONDITIONS, otherwise `draft`. These ten states are the final set
   (the plan's seven plus the engine's escalated and cancelled outcomes and the person's archive). `ready` reflects the
   certificate as issued; every start re-verifies it from scratch.

6. **Every action reuses the one path.** Generation, certification, start and decision call the same functions as the
   generated-workflow routes (`generateDefinition`, `issueCertificate`, `startGeneratedRun`, `decideGeneratedApproval`), so a
   workflow started here passes the same certificate gate, pause check, run-time effect authorization (ADR 0031), signing
   and audit. Reading needs `read`; changing, certifying and starting need `author`; deciding needs `review` and a recent
   sign-in.

7. **Privacy of the link.** Anyone who may read the workspace may read its workflows (an approver must see what they
   approve), but only the conversation's owner sees which conversation and message a workflow came from; everyone else sees
   `{ store: 'cnv', linked: true }`. Listing by conversation needs ownership (404 otherwise, as for an unknown one). An
   outsider cannot tell a workflow exists.

8. **Storage: one immutable snapshot per revision, compare-and-swap by construction.** `<data>/<ws>/workflow-entities/
<id>/r000001.json …`, each created with an atomic create-if-absent (temp file + `link`), so only one writer, in any
   process, wins a revision. A pinned `expectedRevision` that lost is a 412; an unpinned change is re-applied on top of the
   winner. The revision chain is the workflow's history.

9. **Change notifications: an append-only feed with byte-offset cursors.** `changes.log` gets one O_APPEND line per
   entity revision and per run move (start, decision, and timer- or deadline-driven moves observed by the minute tick).
   Cursors only grow and survive restarts and multiple instances; `wait` long-polls for up to 25 seconds. A change carries
   no content: it is a hint to re-read. A lost line (a crash between snapshot and feed) costs a notification, never state.

10. **`cht_` routes are marked deprecated in the API document** (no new features, no workflow links), as ADR 0013 decided.

## Consequences

- A thin client follows all of a person's work with three calls: a page of compact summaries, one workflow's detail, and
  the change feed. Studio's chat screen shows the workflows a reopened conversation started.
- Run state has one owner (the engine's journal); the entity never disagrees with it.
- The composed-workflow runner's runs (`wfx_…`), Studio-authored definitions (`wfd_…`) and procedures are not workflow
  versions. UW-7 folds the composed runner into the Workflow IR runtime; a definition kind for authored graphs can then be
  added to the union in decision 2.
- `paused` holds new starts only. Holding or cancelling a run already in progress is UW-7 (ADR 0024), through the port.
- The feed is not compacted; at the expected volumes (a line per change) this is years of growth per workspace. Compaction
  with a published low-water cursor is a later, compatible change.

## Migration note

Additive only. A new directory, `workflow-entities/`, appears under each workspace on first use; no existing record changes
shape. Run meta files gain an optional `workflow` field (older runs, which have none, simply belong to no workflow and keep
working through the generated-workflow routes). The `cht_` store needs no migration (ADR 0013: no client writes it). The
instance schema version is unchanged, because nothing existing is rewritten.

## Reopen if

A run must be attributed to a workflow after it started (the link is fixed before the first entry by design), or a
deployment needs workflow reads limited to the conversation's owner.
