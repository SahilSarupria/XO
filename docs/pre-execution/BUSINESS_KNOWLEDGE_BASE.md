# Business Knowledge Base (PX-4)

The Business Knowledge Base (BKB) is where a workspace's organizational knowledge is governed: what the business has said,
where it said it, who confirmed it, and which version of it a workflow was built against. It lives in
`@xo/knowledge-base` (ADR 0029, decisions 4–6 and 16). This page describes the model, the rules it enforces, and how to
use it from the API and the CLI.

## What it is not

- It is not the compiler's interchange format. XOIR stays the compilation output; the BKB receives it through one
  adapter (`reconcileXoirGraph`, mapping `xoir-bkb.v1`).
- It is not a domain model. The core knows only generic primitives. Domain meaning (an `Account` has a `tier`) comes from
  Domain Knowledge Packs, which a workspace installs explicitly.
- It is not a runtime store. Nothing here executes; workflows pin a knowledge state id (PX-6, PX-7).

## Model

| Primitive             | What it is                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Entity                | Something the business talks about: canonical name, aliases, strong identifiers (`{scheme, value}`), typed attributes.               |
| Claim                 | A statement about a subject (an entity or a literal): predicate, object, polarity, modality, scope, validity interval, authority.    |
| Relationship          | A typed, directed link between two records.                                                                                          |
| Evidence              | Where a record comes from: the source version (SHA-256), its name, and a locator (pages, section, character range, XOIR node id).    |
| Authority             | Why a claim may be relied on: `source` (stated in a document), `reviewed`, `authoritative`, with a basis.                            |
| Lifecycle             | Per state: `active`, `superseded`, `retired`, `needs_review`, `rejected`.                                                            |
| Conflict              | Two active claims about the same subject, predicate and scope, valid at overlapping times, that say different things. Both are kept. |
| Change set            | A proposed list of operations (`add`, `supersede`, `retire`, `merge-entities`, `split-entity`, `resolve-conflict`) with findings.    |
| Knowledge state       | An immutable snapshot: which record digests are in which lifecycle stage, the conflicts, the pack bindings, the precedence policy.   |
| Domain Knowledge Pack | A digest-identified manifest (`xo.domain-pack.v1`) contributing entity types, predicates and relationship types for one namespace.   |

Every type is namespaced (`namespace:Name`). `xo:` is the core vocabulary: generic, never domain nouns.

Record ids are derived from content, so the same knowledge in the same workspace is the same record. That is what makes
recompiling idempotent.

## The rules

1. **Nothing reaches the active state without approval.** A compilation proposes a change set. Only `approve` creates a
   new state. A rejected change set's records stay stored for audit but never enter a state through it.
2. **Approval is refused** when the change set was already decided, when it has error findings (no evidence, a dangling
   reference, another tenant's record, a value the owning pack's schema rejects), or when the head moved since it was
   proposed (propose it again against the new head).
3. **Conflicts are kept, never overwritten.** A precedence policy (`{ version, order }`, by authority level or source
   name) resolves them when given; otherwise they stay open until a `resolve-conflict` operation is approved.
4. **Entities are never merged automatically.** Resolution links on a strong identifier, or on a single exact name or
   alias of the same type. Several exact matches, or only similar names, are returned as candidates and the new entity is
   added separately and reported as `unresolved`. Merging is an explicit `merge-entities` operation.
5. **A changed rule supersedes, it does not overwrite.** When a recompiled source states a different rule in the same
   place (same predicate, subject, source file and section), the adapter proposes a supersession; the old version stays
   readable in every state that had it.
6. **Reads are pinned.** Records, search, conflicts and entity resolution all take a state id. A pinned read never sees
   later knowledge.
7. **Tenants are isolated.** Each workspace has its own store directory; a store refuses records, states and events that
   name another tenant, and the root state differs per tenant.
8. **Integrity is checked, not assumed.** States, records and the hash-chained event log are verified against their
   digests on read. `verifyState` also checks dangling references, active claims without authority, records without
   evidence, and (when given the known source digests) evidence citing a source version that is not known.
9. **Packs add semantics, not authority.** One pack per namespace, activated explicitly; a second pack for an active
   namespace is refused rather than settled by install order. A record whose namespace no installed pack defines is kept
   and governed, marked `interpretation: "unsupported"`, and never reinterpreted. Pack dependencies, and the packs a
   package was built with (`XoManifest.domainPacks`), resolve by exact digest only.

## Storage

`KnowledgeStore` has three implementations behind one interface (ADR 0030). Every write runs inside
`store.exclusive()`, so concurrent proposals and approvals across processes are serialised and a stale base is refused
(`stale_base`), never merged. Rows are write-once and checked against their digest on read; the event log is
hash-chained; the head state is derived from it, never stored as a mutable flag. The search index is derived from a
state on demand (BM25, k1 = 1.2, b = 0.75), so it can always be rebuilt.

| `XO_KNOWLEDGE_STORE` | Where                                                                        | For                                             | Backup and restore                                                      |
| -------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| `sqlite` (default)   | `<data>/knowledge.sqlite`, WAL, one database for every workspace (by tenant) | one API instance                                | `backupSqliteKnowledge(driver, file)` (online `VACUUM INTO`); copy back |
| `postgres`           | `XO_KNOWLEDGE_DATABASE_URL` (`@xo/knowledge-store-postgres`)                 | several API instances; advisory lock per tenant | the database's own (`pg_dump`, point-in-time recovery)                  |
| `file`               | `<data>/<ws>/knowledge/<ws>/`, a lock file per tenant                        | development; refused in production              | the workspace data backup                                               |

The SQL schema is versioned (`kb_schema`); a database written by a newer version is refused rather than read wrong, and
migrations run under the schema lock, so instances starting together against an empty database create it once.

**Moving from the file store (ADR 0031).** The first time a workspace's knowledge is opened on SQLite or PostgreSQL, what
it kept in files is copied in with `copyKnowledge`: every row is read through the file store's checks and written through
the SQL store's write-once checks, and the event chain is replayed so the SQL chain is digest-for-digest the file chain.
The files stay where they were, marked `MIGRATED.json` (with the counts and the head event digest), and are not read
again. If the SQL store already holds knowledge for that workspace, nothing is merged: the knowledge routes report the
conflict until the operator keeps one (moves the files aside, or sets `XO_KNOWLEDGE_STORE=file` in development).

**Restoring SQLite.** Stop the instance, then `restoreSqliteKnowledge(backup, <data>/knowledge.sqlite)`: the backup is
verified completely first (schema version, every row against its digest, every tenant's event chain); only then is the
live file replaced, atomically, with its WAL and shared-memory files removed. A damaged backup changes nothing.
`verifySqlKnowledge(driver)` runs the same check on any SQLite or PostgreSQL knowledge database.

## XOIR mapping (`xoir-bkb.v1`)

| XOIR node                                                                                             | BKB record                                                     |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `concept` (any subtype)                                                                               | entity `xo:concept.<subtype>`                                  |
| `heuristic`, `decision_node`, `constraint`, `fact`, `safety_policy`, `risk_policy`, `escalation_rule` | claim, predicate `xo:<kind>`, subject = condition or rule text |
| `capability`                                                                                          | claim, predicate `xo:capability`                               |
| an edge between mapped nodes                                                                          | relationship `xo:edge.<KIND>`                                  |

Other node kinds are listed as `unsupported` in the report; nodes without evidence in a known source version are listed
as `rejected`. Nothing disappears silently. The report also lists `accepted`, `unchanged`, `updated`, `conflicting` and
`unresolved` items.

## API

All routes are under `/workspaces/{workspaceId}`. Reads need workspace access; proposing needs `author`; approving and
rejecting need `review` and a recent sign-in; installing a pack needs `manage` and a recent sign-in. Every decision is
audited (`knowledge.change-set.proposed | approved | rejected | denied`, `knowledge.pack.installed`).

| Route                                                                                     | Purpose                                                                                     |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `POST /compilations/{compilationId}/knowledge-change-sets`                                | Propose a compilation's knowledge (201), or nothing new (200, `changeSet: null`).           |
| `GET /knowledge/change-sets[?status=]`, `GET /knowledge/change-sets/{id}`                 | Change sets with findings, report and decision.                                             |
| `POST /knowledge/change-sets/{id}/approve` `{ reason, precedencePolicy? }`                | Create the next state. 409 `XO_KNOWLEDGE_CHANGE_SET_REFUSED` with `context.knowledgeError`. |
| `POST /knowledge/change-sets/{id}/reject` `{ reason }`                                    | Reject.                                                                                     |
| `GET /knowledge/state`, `GET /knowledge/states/{id}`, `GET /knowledge/states/{id}/verify` | Head, pinned state, verification.                                                           |
| `GET /knowledge/records?state=&kind=&type=&lifecycle=`                                    | Records of a state.                                                                         |
| `GET /knowledge/search?q=&state=&limit=`                                                  | BM25 hits with evidence and authority.                                                      |
| `GET /knowledge/resolve-entity?name=&type=&state=`                                        | Linked entity or candidates.                                                                |
| `GET /knowledge/conflicts?state=`                                                         | Conflicts of a state.                                                                       |
| `GET /knowledge/packs`, `POST /knowledge/packs`                                           | Installed packs; install a pack artifact.                                                   |

## CLI

```
xo knowledge propose policy.pdf terms.docx      # compile and propose; prints the report
xo knowledge change-sets
xo knowledge show <changeSetId>
xo knowledge approve <changeSetId> --reason "matches the signed policy"
xo knowledge reject <changeSetId> --reason "superseded by the 2026 memo"
xo knowledge state [--state <id>]
xo knowledge verify [<stateId>]                  # exit code 1 when it does not verify
xo knowledge search "refund limit" [--state <id>]
xo knowledge conflicts
xo knowledge install-pack pack.json
xo knowledge packs
```

The store defaults to `.xo/knowledge` with tenant `local` (`--kb`, `--tenant`). Add `--json` for machine output.

## Tests

`packages/knowledge-base/test/knowledge-base.test.ts` covers the spec §4.6 and §4.6.1 acceptance list: approval gating,
reject and stale refusal, invalid change sets, pinned states and supersession history, conflicts kept and resolved by
precedence and by ruling, validity-interval overlap, entity resolution without auto-merge, BM25 retrieval with evidence,
tenant isolation, record/state/event-log tamper detection, orphan evidence, human assertions, two synthetic packs plus an
unknown namespace, namespace collisions and tampered packs, exact-digest dependency resolution, no tenant data in packs,
idempotent recompilation and supersession through the XOIR adapter. `apps/api/test/knowledge-base-routes.test.ts` and
`apps/cli/test/knowledge-command.test.ts` cover the same flow end to end on each surface.
