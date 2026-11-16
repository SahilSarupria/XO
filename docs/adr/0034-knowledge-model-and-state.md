# 0034: One knowledge model and state store: the Business Knowledge Base is the claim layer (UW-4)

## Status

Accepted under owner delegation, 2026-11-16 (UW-4, wave W2). Signed off by Claude under the owner's delegation of decision
authority. This is a delegated sign-off, not an independent review.

It reconciles ADR 0012 (D-C, the claim, evidence and lifecycle layer) and ADR 0017 (D-H, knowledge state per instance) with the
Business Knowledge Base (BKB, `@xo/knowledge-base`). PX-4 and PX-9 built the BKB under ADR 0029 and ADR 0030, after ADR 0012 was
written. It records the ADR 0017 spike results.

## Context

ADR 0012 planned a claim layer as an additive XOIR extension: a `claim` node kind, evidence metadata, lifecycle metadata and two new
edge kinds. Before UW-4 started, the pre-execution work had already built a separate store with exactly those concepts:

- claim, entity and relationship records with evidence, authority and derivation;
- lifecycle kept in immutable states, outside the record digest;
- change sets that a person approves;
- conflicts that are kept, not resolved silently;
- SQLite and PostgreSQL stores.

XOIR feeds the BKB through `reconcileXoirGraph`. Building ADR 0012 literally would have created a second, competing claim model
inside XOIR. The audit at the start of UW-4 found these gaps in the BKB:

- no evidence resolver and no executable-use gate;
- no mapping from environment-intelligence (EI) data into BKB records;
- the head was derived by scanning the event log, with no compare-and-swap at the database level;
- the schema had only ever been version 1, so no migration had been run;
- no crash or cross-process tests;
- search was rebuilt on every call;
- chat did not use approved knowledge at all;
- no model-backed text deriver.

## Decisions

1. **The BKB is the knowledge model. XOIR is not extended.** XOIR remains the compiled graph. It proposes knowledge into the BKB and
   is not where knowledge lives. ADR 0012's decisions are met in the BKB as follows:
   - **Claim (ADR 0012 decision 1).** This is `ClaimRecord`. UW-4 adds an optional `origin` (`observed` | `stated` | `inferred`).
     It is absent on older records, so their digests do not change.
   - **Evidence (decision 2).** This is `EvidenceRef`. UW-4 adds optional `quoteHash` and `observedAt`. Compiled and EI evidence
     carries no copied text. A quote is held by hash over the record's own words and found again in the stored source.
     **Deviation:** model-derived evidence also carries the quote verbatim (at most 500 characters). Its claim text is a
     paraphrase, so the quote is the only thing the reviewer can check against the page. `quoteHash` binds the quote to the
     evidence.
   - **Lifecycle (decision 3).** This is `StateEntry.lifecycle`, outside the record digest, as ADR 0012 and ADR 0017 require.
     Vocabulary: `approved` is `active`, `retracted` is `expired` (or `rejected`), and `proposed` means a change set not yet
     decided.
   - **Authority (decision 4).** This is `Authority { level, basis }` plus `derivation`, so who stands behind a claim is kept
     separate from how it was produced.
   - **Edges (decision 5).** `manages` and `associated_with` are BKB relationship types (`xo:relation.manages`,
     `xo:relation.associated_with`). No XOIR edge kind is added; XOIR never needed one, because these relationships come from EI,
     not from documents.
   - **No graph database (decision 8).** Unchanged.
2. **The executable-use gate (ADR 0012 decision 6, UAC-12) is `executableKnowledge`, one function.** A record may feed execution
   only when all of the following hold:
   - it is `active` in the state;
   - an installed pack interprets its type;
   - a claim has authority;
   - it is in no unresolved conflict and did not lose a resolved one;
   - every evidence entry resolves.

   Evidence resolves when:
   - the source version exists;
   - its stored bytes re-hash to the cited digest;
   - the cited pages, sheet and row are inside it;
   - a cited quote is on the cited pages.

   This is stricter than ADR 0012, which asked only for approval and resolvable evidence. A quote on a scanned page cannot be
   re-read, so it is `quote_unverifiable`, not missing. The readiness certificate's `knowledge` gate runs this check on the approved
   records drawn from the workflow's own sources and holds every refusal for review, with its reason. Nothing else decides what may
   feed execution. Sources are read through `EvidenceSourcePort`; the API implements it over the workspace source store and the
   compiler's own readers.

3. **EI maps onto the same records (ADR 0012 decision 7)** through `mapEiAssertions`, which is versioned (`EI_BKB_MAPPING_VERSION`):
   - `directly_observed` becomes origin `observed`;
   - `corroborated_inference` becomes origin `inferred`, but only when at least two independent sources support it. With fewer it
     is a hypothesis.
   - `candidate_hypothesis` becomes origin `inferred`, returned apart as a hypothesis, so approving it is a separate decision;
   - `unknown` becomes no record.

   The mapping is structural, so `@xo/knowledge-base` takes no dependency on EI.

4. **Two identities per state (ADR 0017 decision 2, refined).**
   - The `stateId` is unchanged. It names a point in history: it hashes the parent state and the change set that made it.
   - The **content root** is the Merkle root ADR 0017 asked for. It covers each entry's record digest and lifecycle, every conflict
     and its ruling, the pack bindings and the precedence policy. Leaves are sorted, and it is built RFC 6962 style. Two histories
     that reach the same knowledge share a root but not an id.
   - Receipts (UW-11) record both.
5. **Schema 2 (ADR 0017 decision 3).**
   - **`kb_heads`** is the head pointer. Approval moves it by compare-and-swap from the base state, inside the same transaction as
     the state, its decision and both events. Even a broken caller lock cannot let two approvals against one head both win.
   - `head()` still verifies the whole event chain. A pointer that disagrees with the log is an integrity fault and is never
     resolved silently either way. `verifyHead` reports it, and so do `verifySqlKnowledge` and the verify route.
   - **`kb_indexes`** holds retrieval indexes, one per state (decision 6).
   - The 1 → 2 migration backfills each tenant's pointer from its verified log, in one transaction under the schema lock. A log
     that does not verify stops the migration and leaves schema 1 in place.
   - Restoring an older backup migrates the staging copy, never the backup itself.
   - The file store keeps deriving the head from its log. It is a development store and has no transaction to make a pointer safe.
6. **Retrieval is per state, persisted and rebuildable.**
   - A state's index is built once from its records, written once, and checked on every read: it must have the same tenant, the
     same state and the state's content root.
   - A rebuild equals the stored index exactly, so dropping all indexes loses nothing.
   - Queries search approved records by default. They filter by lifecycle, kind and type before scoring, so statistics come from
     the filtered set.
   - The ranking equals the scan it replaces; a test pins this.
7. **Chat answers from approved knowledge first.** `ApprovedKnowledgePort` searches the head state, and the composite knowledge port
   ranks its tier ahead of raw compiled output. The record text is evidence: data, never instructions (trust rule T2).
8. **K4, model-backed text derivation, follows the trust boundary.**
   - `deriveClaimsFromText` sends page text only as JSON data, under a fixed system message (T2).
   - A claim survives only when all of the following hold:
     - its quote is on the page it names;
     - the quote is at least 12 normalised characters and at most 500;
     - the quote contains the claim's value.
   - Everything else is refused by position and reason, never echoed.
   - What survives is proposed as a `model-derivation` change set for a reviewer (T1).
   - The model is reached only through the residency-guarded provider factory (UW-14).
   - The path is listed in `specs/security/TRUST_BOUNDARY.md` with its corpus check.

## ADR 0017 spike results

| Condition                                              | Result                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite binding: `node:sqlite`, no native build         | Holds. WAL, `synchronous = FULL`, `BEGIN IMMEDIATE`, with an asynchronous lock retry.                                                                                                                                                                                                                                  |
| Crash-injection atomicity of a multi-record activation | Holds. A separate process is SIGKILLed before each statement of an approval, 20 in the test. Every kill leaves the previous head with no decision, no event and no pointer move, and the same change set then approves to the same state id.                                                                           |
| Concurrent activation                                  | Holds. Two processes approve against one head at the same moment, three rounds: exactly one wins and the other gets `stale_base`.                                                                                                                                                                                      |
| State id deterministic across rebuilds                 | Holds. The same approvals on a new store give the same state ids and content roots.                                                                                                                                                                                                                                    |
| Real migration                                         | Holds. A database written by the schema-1 code (`test/fixtures/knowledge-schema-1.sqlite`) migrates with its heads, its records and a pending change set intact. A tampered log refuses to migrate. Also checked by hand on PostgreSQL 16 with the schema-1 code; the PostgreSQL conformance suite passes on schema 2. |

ADR 0017 does not reopen.

## Consequences

- Compiled, EI and model-derived knowledge all reach execution, chat and readiness the same way: proposed, reviewed, approved, then
  resolvable.
- Approving one change set now costs one more statement (the head swap). Reading the head still verifies the log, as before.
- Records written before UW-4 keep their digests and identities.

## Reopen if

- A source type cannot be re-read to resolve its evidence (for example, a connector resource with no stored version).
- A customer needs the head pointer without the log check, at a scale where verifying the log on every read is too slow. In that case
  add a verified-prefix checkpoint, not an unverified read.
