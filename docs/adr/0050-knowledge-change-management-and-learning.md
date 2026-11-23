# 0050: Knowledge change management, and learning from runs (UW-11)

## Status

Accepted under the owner's delegation, 2026-11-23. Part 1 (change management) lands in `uw-11a/knowledge-change-management`; part 2
(learning from runs) in `uw-11b/learning-from-runs`. Amends ADR 0034 and implements ADR 0045 decision 11. Closes mandatory scenario 18
and UAC-21.

## Context

- UW-4 (ADR 0034) built change sets, immutable states and a compare-and-swap head. Revision 4 asks UW-11 for branches, more
  validators, rollback, the workflows a change affects, and the knowledge state on the run's record.
- A readiness certificate bound the whole knowledge head. Any approved change, about anything, made every certificate stale, so
  learning one fact would stop every workflow and every standing approval (UW-16).
- Runs produce what an organisation learns from: outcomes a person reconciled, exceptions, tasks a person reported not done, rows
  left out, and corrections. ADR 0045 decision 11: none of it becomes knowledge on its own; a person proposes, a reviewer approves.

## Part 1: change management

1. **A certificate depends on the knowledge drawn from its own sources.** Readiness policy v3 binds a dependency root: the digest of
   every record whose evidence cites one of the certificate's sources (id, record digest, lifecycle), the conflicts naming them, and
   the installed packs. A change elsewhere leaves the certificate current; a change to one of those records, or a new conflict on one,
   makes it stale. Generated runs read knowledge only through the readiness gate over their sources, so nothing outside the root can
   change what a run does. Version 2 certificates keep the whole-state rule until they are reissued. The root is bound as
   `knowledgeDependencyRoot` beside the (still recorded) `knowledgeState`; a certificate is issued under v3 only when the caller
   supplies it, and a v3 certificate without one is refused rather than ignored.
2. **A branch is a proposed change set and its preview.** The preview is the state approval would create, with what it adds,
   replaces, retires and the conflicts it opens, computed without moving the head. There are no overlays and no three-way merge: a
   change set whose base moved is proposed again against the new head. (A change set that resolves a conflict records the resolution
   time, so its preview digest then differs from the approved state's.)
3. **Validators.** Deterministic validators run first and block on errors: dependency (retiring an entity something active still
   points at), authority escalation (only a manual or imported change may assert authoritative knowledge; model-derived and
   run-derived records stay at source level until reviewed), restore outside a rollback, and a rollback target that is not an
   ancestor. Duplicates, contradictions and the number of certified workflows a change affects are warnings shown to the reviewer.
   Superseding a record is not blocked by a reference to it: its replacement exists and the old record stays resolvable.
4. **Rollback goes forward.** A rollback is a change set that brings content and lifecycle back to an ancestor state; approving it
   creates a new state. History is never rewritten, and conflicts are recomputed, not restored.
5. **Separation.** A rollback, and a change set proposed from a run, cannot be approved by the person who proposed it when the instance
   requires separation of duties.
6. **The run's record names its knowledge.** The run manifest records the knowledge state, digest and dependency root of the
   certificate it ran under; replay says when that state no longer exists.

## Part 2: learning from runs

1. **Observations are derived, not knowledge.** For each run, XO derives observations deterministically from the journal, the run's
   record and its batch preview: an outcome a person reconciled; an approval step a person rejected; a task a person reported not
   done; another escalation; a row left out of the batch, with its reason; a row paired only loosely. They are listed for the run and
   change nothing.
2. **Corrections are a person's statement.** A person with the author role may record a correction to a run: which item, which field,
   the value it should have had, and why. It is stored with the run. It changes no source and no knowledge.
3. **Proposals.** A person with the author role chooses observations and corrections and proposes them as one change set (origin
   `run-outcome`, reference = the run). Each becomes a claim in the `xo-run` namespace, at source authority, with evidence that points
   to the run: the run id, step and item, and the digest of the run's manifest. A reviewer, other than the proposer when separation is
   required, approves it with a recent sign-in.
4. **Never executable by itself.** No Domain Knowledge Pack defines `xo-run`, so these claims are searchable and reviewable but never
   pass the executable-use gate (UAC-12). They do not touch any certificate's dependency root unless they cite its sources, which
   they do not. A pack that gives `xo-run` meaning is a separate decision.
5. **Run evidence resolves against the run.** It resolves while the run's manifest exists and matches its digest; if the run's record
   is deleted or altered it stops resolving, and the gate holds the record for review like any other.
6. **Privacy.** Observations and corrections live with the run in the workspace's data. Audit events carry ids, kinds and counts, never
   a value or a field's content.

## Consequences

- Approving knowledge no longer stops unrelated workflows. Certificates issued before this ADR keep the old rule until reissued.
- Mandatory scenario 18 holds: a correction proposes, a reviewer approves, the head moves only then, and runs keep the state they were
  certified against.
- Not done: overlays, three-way merges, automatic proposals after every run, and any use of run-derived claims in execution.

## Reopen if

- A workflow must read knowledge at run time from outside its own sources (the dependency root would have to include it).
- The owner wants run observations proposed automatically.
