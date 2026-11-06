# C6 Knowledge Agent SDK — integration

Context: [CUSTOMER_CHAT.md](./CUSTOMER_CHAT.md) (the **ASK → DECIDE → DO → LEARN** loop) and [EVALUATION.md](./EVALUATION.md).

## Status

**The adapter is built and tested against the real C6 stack. A running Studio does not yet get answers from C6**, because nothing in the API populates a C6 environment for a workspace (see "Not done"). Until then Studio still answers from the interim installed-XO source.

```
Today (default):  Studio → API → Intelligence → InstalledXoKnowledgePort        (keyword match over installed XOs)
Built, tested:    Studio → API → Intelligence → C6KnowledgePort → C6 SDK → C5 knowledge model → C4 ingested evidence
Missing:          the per-workspace C6 environment bootstrap (state, audit, grants, connectors, ingestion) — below
```

## Where C6 lives, and how it was brought in

C6 is `packages/environment-intelligence/src/sdk/` on **`feat/c0.3-audit-unification`** (commit `083c656`, with C4 ingestion and C5 knowledge beneath it). That branch diverged from the Studio lineage (38 commits vs 97) and has no `apps/studio`.

The branches could not simply be merged: `c0.3` and the Studio lineage have **two different authorization/audit architectures in `apps/api`** (c0.3: `PermissionManager` + `AuditService` + audit sink required by every route; Studio: workspace-level roles and a workspace-local audit), producing 24 conflict hunks across 9 files in the execution, workflow, human-task, source and server wiring. Also, `c0.3`'s `packages/runtime` makes `subject` + `permissionDeclaration` **required** on every capability execution, which Studio's API does not supply.

So the integration commit imports only the **minimal dependency closure C6 needs** — `packages/audit`, `packages/environment-intelligence`, `packages/permissions`, `packages/types`, `packages/errors` and `packages/ai-core` (3-way merged), plus docs — as an **ordinary single-parent commit, not a merge**. A merge commit would mark `c0.3`'s API changes as already merged when they were deliberately left out. Excluded on purpose: `packages/runtime`, `packages/benchmark`, `apps/cli`, `apps/api`, `examples/`. **Reconciling the two API-level audit/authorization architectures (and adopting runtime's required capability subject) is an open decision for whoever owns both lineages**; it is also the prerequisite for DO.

## What the adapter does (`@xo/intelligence-c6`)

It contains **no retrieval logic**. `C6KnowledgePort` implements `KnowledgePort` and does four things:

| Concern                    | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity**               | Hands C6 the caller's `AuthenticatedPrincipal`, which the API's auth middleware already mints from the server-side key record (`req.principal`) and the route carries on `Principal.authenticated`. No credential, a forged one, or one that isn't the caller's → C6 is **never called** (`denied`). The orchestrator never inspects, logs or stores the credential (tested: absent from results, prompts and stored conversations).               |
| **Evidence & provenance**  | Each C6 `Statement` becomes `Evidence`: stable `ref` as id, source id, `c6:<kind>` type, latest `observedAt` as `asOf`, and a note of how many independent sources back it ("single source"). Citations are still verified by the orchestrator against what was returned.                                                                                                                                                                          |
| **Conflict & uncertainty** | C6's status is **put in the text the model reads**: `CONFLICTED — the sources disagree and a person must decide: … both values …`, `HYPOTHESIS — inferred, not confirmed`, `UNKNOWN`. A conflict reaches the answer as a conflict and caps confidence at "medium" (tested end to end against a real C6 conflict, 300000 vs 500000).                                                                                                                |
| **Errors**                 | C6 fails closed; the adapter keeps those outcomes distinct. `denied`/`unauthenticated` → "you don't have access to search your organization's knowledge" (`knowledge_denied`; C6 defines denial as a whole-operation result, so this reveals nothing about specific data). `unavailable`/limit/internal, including **audit failure** ("no data when the read could not be audited") → "couldn't reach your knowledge". Never an empty "not found". |

Authorization itself stays in C6: per-source hiding is tested through the adapter (a contractor denied the HR source receives no HR-derived value, not even its source id, and access changes apply on the very next call).

## Requirements you listed, mapped

| Requirement                                  | Status                                                                                                                                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated user and organization identity | **Done** for user (platform `AuthenticatedPrincipal`, which also carries `orgId` from the key record). How `orgId` should relate to `workspaceId` is undecided; the adapter passes the principal through as C6 expects.                                     |
| Authorization-aware retrieval                | **Done** in C6, verified through the adapter.                                                                                                                                                                                                               |
| Evidence and provenance                      | **Partly.** Ids, source ids, times and source counts flow through. C6 evidence references carry only a hashed source id — **no display name or URL**, so citations show "source sha256:…" unless `describeSource` is supplied (e.g. from the EI inventory). |
| Entities and relationships                   | **Via statements only.** C6 returns entity/claim/relationship/conflict statements, and these flow as text evidence. Structured traversal (`select`/`entity`/`relation` queries) is not used: the port has no shape for it.                                  |
| Conflict and uncertainty                     | **Done** (see above). C6's uncertainty summary and review queue (`reviewQueue`, `submitReview`) are not used.                                                                                                                                               |
| Cross-source search                          | **Within C6's own scope.** One call over everything the principal may see. C6 reports only what is visible and never what was withheld, so `unsearchedSources` is never set by this adapter.                                                                |
| Visibility / permission enforcement          | **Done** in C6.                                                                                                                                                                                                                                             |
| Unavailable or denied knowledge              | **Done** (distinct outcomes above).                                                                                                                                                                                                                         |

## C6 is also keyword search

C6's free-text `query` is, by its own contract, "DETERMINISTIC LEXICAL retrieval … not semantic search … an unmatched question returns no statements". The adapter tags results `lexical`, and every answer tells the user it matched keywords, not meaning. C6 is structured knowledge (entities, claims, relationships derived from **structured records**), not a document index, so a question has to share words with entity names, predicates or values.

## Not done

1. **No per-workspace C6 environment exists in the API.** Producing a `KnowledgeSdk` for a workspace needs: a durable `EiStateStore`, a **production audit recorder** (the in-memory recorder is test-only and C6 refuses to answer when a read can't be audited), an `AuthorizationPort` with real grants (`PermissionManagerAuthorization`) defining who may query which sources, connectors (C2 local agent / C3 Microsoft Graph), and an ingestion/sync schedule. Mapping workspace roles to C6 grants is a policy decision. Connecting sources is the C7 "Connect" experience, which doesn't exist.
2. **Wiring.** When (1) exists: `createHttpServer({ intelligenceKnowledge: c6KnowledgeFactory({ sdkFor: (workspaceId) => sdk }) })`. A workspace without an SDK gets an explicit "not configured" port and **does not fall back** to the installed-XO source.
3. **`scope` is ignored** by this adapter (`@name` focus is an installed-XO notion C6 doesn't have), and the route still validates attached names as installed XOs.
4. **The evaluation corpus can't be loaded into C6.** The eval corpus is prose documents; C6 derives knowledge from structured records. To run the evaluation against C6 the corpus needs a structured counterpart (entities, claims, relationships) — not built. `--knowledge-module` still works for any adapter that can serve the prose corpus.
5. **Unused C6 capabilities:** `buildContext` (C6's own prompt-ready context with citation markers — the orchestrator does its own, with verified citations), the agent toolkit, and the human-review queue.
6. **Tests of the adapter import C6's test harness** (`environment-intelligence/test/support`) and its **source**, not the built package (mixing them loads two copies of the trusted-decision module and C6 correctly refuses). Coupled to that harness.
