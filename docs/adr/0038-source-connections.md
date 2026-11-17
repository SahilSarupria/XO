# 0038: Workspace source connections: sync, freshness, retirement, and proposed roles (UW-12a)

## Status

Accepted under owner delegation, 2026-11-16 (UW-12a, wave W2). Signed off by Claude under the owner's delegation of decision
authority. This is a delegated sign-off, not an independent review.

## Context

The plan's first journey stage is "Connect discovers sources": XO inventories the workbook and the certificate folder, proposes what
each is, and the person confirms. Then XO asks what they want to accomplish. Before UW-12a, two things existed, and neither did
that:

- **`@xo/connect` (C7).** A per-person, instance-level folder service over Environment Intelligence. It reads only text formats
  (`.txt`, `.md`, `.csv`, `.tsv`, `.json`), keeps what it reads in EI's own evidence store rather than in a workspace, and is not
  started by the instance at all. It has no notion of a role, and no coupling to chat.
- **Workspace sources.** Files uploaded or imported one at a time. They feed compilation, knowledge evidence (UW-4) and the
  data-protection dictionary (UW-14), but nothing keeps them in step with where the files actually live.

The plan asks for one source-connection entity with sync, freshness and retirement (A1 N1, K3), over the existing local-folder
service and cloud connectors. Discovery must offer roles that the person confirms, and Connect must never write authoritative
knowledge itself (A3 §7).

## Decisions

1. **A source connection belongs to a workspace, and its files become ordinary workspace sources.**
   - **What a connection is.** A connection (`scn_…`) names a folder.
   - **What a sync does.** It stores each supported file as a workspace source (origin `connection`, with the connection and the
     file's path in it).
   - **One path in.** Files go through the same store path as uploads, link imports and email attachments, now one function
     (`sources/ingest.ts`). So a synced file gets the same checks at the door, the same measurements and the same audit entry.
   - **One store.** Compilation, knowledge evidence and the leak guard's dictionary see synced files with no change to them. There
     is no second store to keep in step: that was the plan's "two stores" risk.
2. **Sync, freshness, retirement.**
   - **Changed files.** A changed file (new bytes) becomes a new source version, and the version it replaces is _retired_
     (`changed`, with `replacedBy`).
   - **Removed files.** A file that left the folder retires its version (`removed`).
   - **Retired connections.** Retiring a connection retires every version it holds (`connection_retired`).
   - **Nothing is deleted.** Retired versions keep their bytes and records, so evidence that cites them can still be shown.
   - **Evidence on a retired version.** It now resolves as `source_retired`, so the UW-4 executable-knowledge gate stops
     knowledge resting on an out-of-date file from feeding execution until someone reviews it against the current file. This
     closes K3 end to end.
   - **A partial listing retires nothing.** When a listing stops at a limit, absence proves nothing.
   - **Refused files.** A file the door refuses is counted, and the version already held stays current.
   - **Freshness.** Freshness is derived: `never_synced`, `current`, `stale` (an interval connection two slots overdue),
     `needs_attention`, `paused` or `retired`.
   - **Scheduled syncs.** Interval connections (15 minutes to 7 days) are synced by the scheduler and audited as the system actor
     `source-sync`.
3. **Folders are read by a new reader built on EI's scope guard, not through the C7 service.**
   - **Why not C7.** The C7/EI path reads only text formats and keeps content outside the workspace. The workspace needs PDFs,
     workbooks and Word files as sources.
   - **What it reuses.** `folder-reader.ts` (in `@xo/connect`) uses EI's `resolveRoot`, `resolveInside` and `isInside`, now exported,
     and EI's lists of excluded directories and credential-looking names.
   - **Where folders may be.** The operator lists the folders workspaces may connect in `XO_SOURCE_FOLDER_ROOTS`. A connection's
     real path must lie inside one of them, and this is checked again at every sync. With none set, nothing can be connected.
   - **What it never reads.**
     - Links are never followed, at any depth.
     - Hidden files, Office lock files, hard-linked files and special files are counted, never read.
     - Credential-looking names (`.env`, keys, `credentials.*`) are counted, never read.
   - **How a file is read.** It is opened with `O_NOFOLLOW`, re-checked as a plain file, and its descriptor is proven to point
     inside the root.
   - **Limits.** Listings are bounded: 2,000 files, depth 8, 50 MiB per file, 2 GiB in all.
   - **Paths.** A connection shows the folder's last segment; the path is never returned.
   - **Read-only.** Nothing in a folder is ever written, moved or deleted.
4. **Discovery proposes; a person decides; a decision is an operational binding, not knowledge.**
   - **What discovery finds.** After each sync, deterministic, local discovery (no model) proposes:
     - `contact_list`: a table with a name column and an email column, named "a client list", "a staff list", … from its headers,
       sheet and file name;
     - `record_table`: any other table;
     - `document_collection`: a folder of several documents, named by what most of their file names say ("a folder of
       certificates");
     - `per_person_documents`: a contact list whose names appear in a collection's file names, with how many match, how many
       match no one, how many match more than one person, and how many people have none.
   - **How a proposal is shown.** Each proposal carries the evidence it is based on and a strength.
   - **Stable ids.** A proposal has an id stable across syncs, so a decision survives a sync over the same target. Each decision
     records the file versions it was made on, and is shown as `changedSinceDecision` when they change.
   - **Confirmed roles are bindings.** A confirmed role says "this table is the client list". It is not a business fact, so it is
     not written into the knowledge base; UW-6 binds workflow inputs to confirmed roles.
5. **The discovery message.**
   - **What it does.** `POST …/discovery/conversation` opens an intelligence conversation (`cnv_`, the caller's own) with a
     message written from the proposals, without a model. It says what XO found, what each thing looks like, asks "Is that right?"
     where a person has not decided, and ends "What would you like to do?".
   - **What it names.** Files and folders the person connected; never a cell value.
   - **Structured proposals.** The message carries the proposals in structured form. Studio shows them with "Yes, that's right" and
     "No".
   - **Deciding goes through the API.** The choice is sent to the source-connection API, never through the conversation. So chat
     cannot change anything except through the same authorized, audited control path (UAC-16).
6. **Cloud drives use the same port later, through UW-9's broker. EI's device-code manager is not persisted.**
   - **Correction to ADR 0036.** ADR 0036 said UW-12a would persist EI's in-memory device-code connections through the UW-9 store.
     That is withdrawn.
   - **Why.** The EI cloud manager is used by no product path, only by its own tests. Persisting a second OAuth flow (device code)
     beside UW-9's authorization code with PKCE would mean two credential paths.
   - **The plan instead.** When cloud drives are connected, they use UW-9's broker and store, with read scopes added as new
     capabilities, behind the same reader port. EI's device-code manager stays as it is (unused) until then.
7. **Permissions.**
   - **Read role:** list and see connections, see discovery, and start a discovery conversation (one's own).
   - **Author role:** sync now, and confirm or reject a role.
   - **Manage role:** connect (with a recent sign-in), change the schedule, pause and resume, and retire (with a recent sign-in).
   - **Audit.** Every change is in the workspace audit log: `source_connection.*`, `source.synced` and `source.retired`.

## Consequences

- **Concurrency.**
  - **One sync at a time per process.** A request and the scheduler queue, per connection.
  - **Two instances on one data directory.** They can sync the same connection at once. The connection's own revisions cannot both
    win (exclusive create per revision). At worst one changed file is stored twice as two records of the same bytes, which source
    versions already group.
- **Large folders.** A folder past the listing limits syncs in part and says so. Nothing is retired for being absent from it.
- **Retirement shows up in readiness.** Knowledge from a changed workbook now holds a workflow for review until it is re-approved
  against the new file. That is the intended effect, and it is visible in the readiness `knowledge` gate.
- **Discovery's limits.**
  - Discovery is rule-based. It recognises lists by name and email columns, and collections by folder and file-name words.
  - A list without an email column is "a table".
  - Per-person matching needs every word of the person's name in the file's path. Nicknames and initials do not match.
- **No local agent.** A folder on the person's own computer, when XO runs elsewhere, still needs the local agent (C7 design, not
  built). Today the folder must be on the instance's machine.
