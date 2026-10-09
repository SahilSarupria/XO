# Sequence Evidence for Workflow Composition

Milestone: bridge REAL PROCEDURAL SOURCE → INDIVIDUAL CAPABILITIES → TRUSTWORTHY SEQUENCE EVIDENCE → WORKFLOW-COMPOSER → ORDERED CANDIDATE WORKFLOW, without runtime execution, executable-strategy resolution, or any change to R1–R6 / frozen milestones.

---

## 1. Phase 1 — Architecture / Design Decisions

**Q1. Cleanest existing representation for "source-derived sequence"?**
None exists. `CO_OCCURS_WITH` and `COMPLEMENTS` are the closest candidates and both are symmetric/associative by design ("pairs well with"), not a directional ordering claim. `TRIGGERED_BY` is directional but claims causal triggering — stronger than warranted. No existing edge kind says "A comes before B in the text" without also claiming something else.

**Q2. Can an existing relation type express it without distortion?** No — confirmed by reading `precedence.ts`'s own doc comment, which explicitly excludes `EXTENDS`/`COMPLEMENTS` from ordering "because treating either as an ordering edge would be inventing a constraint the relationship never claimed." Repurposing any of them would be exactly the distortion that comment warns against.

**Q3. Smallest new type/schema addition required?** None, in the taxonomy sense. `CapabilityRelationType` (compiler) and `XoirEdgeKind` (xoir) both already include a `custom:${string}` escape hatch, and `xoirEdgeKindForCapabilityRelationType` (`edge-mapping.ts`) already passes any `custom:*` value through unchanged. We use the literal string `custom:sequence` as both the `CapabilityRelationship.type` and the resulting `XoirEdge.kind` — zero changes to `@xo/xoir`'s or `@xo/compiler`'s core type unions, zero changes to `capability-to-xoir.ts` (it already generically maps every `CapabilityRelationship` regardless of type, carrying confidence/provenance/sourceRefs through opaquely).

**Q4. How does workflow-composer consume it?** A new, deliberately separate table in `precedence.ts` — `SEQUENCE_EDGE_KINDS` — kept structurally apart from the existing `PRECEDENCE_EDGE_KINDS` (never merged in). `derivePrecedenceFacts` now checks both tables and tags every resulting `PrecedenceFact` with a `strength: 'logical' | 'source_derived'` field. `toposort.ts` is untouched — it already orders purely from `before`/`after` pairs, agnostic to strength, so both evidence kinds combine into one valid order automatically. `compose.ts` uses `strength` only for *reporting* (rationale text, a new `source_derived_ordering` gap) — never to withhold or invent an order.

**Q5. Confidence/evidence representation?** Reused, not invented: the `XoirEdgeMetadata.confidence` field every edge already has, plus the same `KnowledgeProvenance`/`sourceRefs` plumbing every other capability relationship uses. Two confidence tiers, both deliberately below every named relation (`complements` 0.5, `depends_on` 0.55, `extends` 0.6): within-unit adjacency 0.45 (direct, same-paragraph evidence), cross-unit sibling adjacency 0.35 (weaker, more indirect — two adjacent bullets under one heading, not necessarily one coherent sentence).

**Q6. How do we ensure this is never treated as a logical dependency?**
- Structural table separation (`SEQUENCE_EDGE_KINDS` vs. `PRECEDENCE_EDGE_KINDS`), not a runtime flag on shared entries — a future maintainer editing the logical table's own doc comment (which enumerates exactly what it covers) cannot silently absorb this into it.
- `PrecedenceStrength` is derived solely from which table an edge kind was found in — never inferred from confidence score, which is a separate axis.
- `StepPrecedenceRationale.orderedAfter[i].evidenceStrength` surfaces this on every step, so a caller must actively ignore it to conflate the two.
- A new `source_derived_ordering` `WorkflowGapKind`, always emitted when any transition in a workflow used sequence evidence, is **informational only** — it never sets `requiresHumanDecision` (confirmed by test: `assert.equal(workflow.requiresHumanDecision, false)` on a workflow ordered entirely by sequence evidence).
- `capability-to-xoir.ts`'s `REQUIRES`-from-`dependencies` emission (the mechanism `precedence.ts` cites for logical `REQUIRES` edges) is completely untouched — sequence edges never populate a capability's `dependencies` array.
- Negative tests (Phase 6) directly assert `COMPLEMENTS`-only pairs still produce `ambiguous_precedence`, and that `requires`/`depends_on` are never emitted merely from unrelated same-unit adjacency.

**Provenance/unit-position representation, as found:** `ExperienceUnit.hierarchy.parentUnitId` + `ExperienceUnit.hierarchy.siblingUnitIds` (already reading-order sorted, same-section) and `ExperienceUnit.provenance.blockIndexRange` (literal block position) already exist and are populated. We use `parentUnitId` (to scope "same section") + `blockIndexRange[0]` (to order within that scope) directly — `siblingUnitIds` itself wasn't needed once `blockIndexRange` gave a cleaner, unambiguous sort key.

---

## 2. Exact Files Changed

| File | Change |
|---|---|
| `packages/compiler/src/document/list-marker.ts` | Added `○` to `BULLET_CHARS`; doc comment |
| `packages/compiler/test/document/list-marker.test.ts` | 2 new regression tests |
| `packages/compiler/README.md` | New known-limitation bullet on the bullet-character allowlist |
| `packages/compiler/src/capabilities/relationship-builder.ts` | New `SEQUENCE_RELATION_TYPE` (`custom:sequence`), within-unit + cross-unit sequence emission (237 lines total, ~90 new) |
| `packages/compiler/test/capabilities/relationship-builder.test.ts` | 1 pre-existing test updated (new expected edge count, explained inline); 8 new tests |
| `packages/workflow-composer/src/precedence.ts` | New `SEQUENCE_EDGE_KINDS` table, `PrecedenceStrength` type, `strength` field on `PrecedenceFact`, `derivePrecedenceFacts` extended (136 lines total, ~50 new) |
| `packages/workflow-composer/src/types.ts` | `StepPrecedenceRationale.orderedAfter[i].evidenceStrength` field; new `'source_derived_ordering'` `WorkflowGapKind` |
| `packages/workflow-composer/src/compose.ts` | `rationaleFor` labels strength; new `source_derived_ordering` gap emission (239 lines total, ~15 new) |
| `packages/workflow-composer/test/fixtures/corporate-lawyer-fixture.ts` | 4 new fixture builders |
| `packages/workflow-composer/test/compose.test.ts` | 5 new tests |

No other file was touched. `toposort.ts`, `capability-node.ts`, `edge-mapping.ts`, `capability-to-xoir.ts`, `capability-id.ts`, `edge-kinds.ts`, `node-kind-mapping.ts`, R1–R6, binding, HITL, runtime, confidence formulas — all unmodified, confirmed by directly diffing every `.ts` file with a newer mtime than the original upload against this list (exactly the 9 files above, nothing else).

---

## 3. Bullet-Glyph Fix (Phase 2)

`list-marker.ts`'s `BULLET_CHARS` now includes `○` (U+25CB WHITE CIRCLE) alongside the existing `•`, `◦`, `‣`, `·`, `-`, `*`. Deliberately kept as a fixed allowlist addition, not a Unicode-category heuristic — the brief's own instruction, and consistent with the module's existing "no regex, plain character inspection" design constraint.

**Verified, rigorously, with a controlled before/after comparison** (temporarily reverted the fix, re-ran the full suite, restored it, re-ran again):
- **Before:** 750 pass / 7 fail.
- **After:** 761 pass / 7 fail — **identical 7 failing test names** in both runs (confirmed by name, not just count).
- Aastha's four reconciliation steps ("Match CRM records…", "Verify Expected Brokerage…", "Reconcile invoice amounts…", "Validate TDS and GST…") are now four separate `ExperienceUnit`s (confirmed by direct inspection of `chunkDocument()` output) — previously one merged blob.
- Unit count: 27 → 49. Action knowledge nodes: 13 → 22.
- Existing markers (`•`, `-`, digits, letters) unaffected — the 2 new tests are additive; every prior list-marker test still passes unchanged.
- Unrelated fixtures (burglary, commercial) don't use `○` and are unaffected (confirmed: their bullet-character inventories contain neither `○` nor any of the other newly-recognized glyphs).

**One real, honestly-reported side effect:** the empty-content-unit count also increased (11/27 → 23/49 in raw terms, roughly proportional). Investigation: these are bare-bullet-glyph remnants at the end of a wrapped text line (e.g. `"...vs. receipt amounts received from insurers. ○"` — the trailing `○` on its own now correctly forms its own `list_item`, with nothing left after it). This is not a regression in the sense of lost information (nothing was better represented before), but it is a real, secondary artifact of the fix, and it directly motivated a specific design decision in Phase 3 (see §4, "empty-unit handling").

---

## 4. Sequence-Evidence Representation (Phase 3)

Implemented in `relationship-builder.ts`, two independent evidence sources, both emitting `CapabilityRelationship { type: 'custom:sequence', fromCapabilityId: <predecessor>, toCapabilityId: <successor> }`:

1. **Within-unit** (confidence 0.45): consecutive non-title capabilities discovered in the same `ExperienceUnit`, in extraction order — additive alongside the existing `complements` edge (both fire on the same pair; they are different, non-conflicting claims).
2. **Cross-unit** (confidence 0.35): a unit's last non-title capability → the next unit's first non-title capability, where "next" means literally adjacent by `provenance.blockIndexRange` among units sharing the same `hierarchy.parentUnitId` (same section, same document — keyed by `documentPath\u0000parentUnitId` to prevent cross-document bleed).

**Two conservatism decisions were tested into the implementation, not just asserted:**

- **No bridging over a real content gap.** My first implementation filtered capability-less units out of the position list *before* computing adjacency — which meant it silently bridged over a genuine section heading between two bullets, connecting two capabilities that are not actually textually adjacent. A negative test (`"a unit with only a title capability... does not participate... and is not bridged over"`) caught this on first run (`not ok`). Fixed: capability-less units now remain in the position list as **chain-breakers** — two units are only ever sequenced when they are each other's literal next sibling, never across an intervening real unit.
- **But a truly empty (whitespace-only) unit does not count as a "real" chain-breaker.** Re-running the fixed logic against the real, recompiled Aastha graph produced **zero** sequence edges — because the same bullet-glyph fix (§3) that correctly separates real bullets into their own units *also* produces the bare-bullet-remnant empty units described above, and these were interspersed between literally every pair of real reconciliation steps, breaking every single chain under the "no bridging" rule. Fixed again: units with `content.trim().length === 0` are excluded from the position list entirely (neither an endpoint nor a chain-breaker), while units with real content but no recognized capability (e.g. an actual heading) still correctly break the chain. A new test (`"a whitespace-only unit... is skipped entirely — it does not break the chain the way a real heading does"`) locks this in.

This two-step correction (over-permissive → conservative → real-document-informed) is exactly the kind of thing the brief's Phase 6 emphasis on negative-case testing is designed to catch, and it worked as intended on the first real run against actual Aastha data, not just synthetic fixtures.

---

## 5. Workflow-Composer Changes (Phase 4)

- `precedence.ts`: new `SEQUENCE_EDGE_KINDS = { 'custom:sequence': 'from_before_to' }`, separate from `PRECEDENCE_EDGE_KINDS`; `PrecedenceFact` gained `strength: 'logical' | 'source_derived'`; `derivePrecedenceFacts` checks the logical table first, then the sequence table, tagging accordingly.
- `types.ts`: `StepPrecedenceRationale.orderedAfter[i]` gained `evidenceStrength`; new `WorkflowGapKind` value `'source_derived_ordering'` (documented as informational, never blocking).
- `compose.ts`: `rationaleFor` now writes a different explanation string depending on strength; a new gap-emission block adds one `source_derived_ordering` gap per workflow whenever any transition in it used sequence evidence, listing every capability id involved.
- `toposort.ts`, `capability-node.ts`: **unmodified** — the ordering algorithm itself needed no change, since it already operates purely on `before`/`after` pairs.

This exactly matches the brief's Phase 4 spec: strong evidence (`REQUIRES`/`DEPENDS_ON`/`INVOKES`/`PRODUCES`/`CONSUMES`/`ENABLES`/`COMPOSES_INTO`) is untouched and still governs ordering the same way; sequence evidence is used *only* when it's the evidence available, and is always labeled as weaker; no evidence still produces `ambiguous_precedence` exactly as before (verified: `COMPLEMENTS`-only pairs still produce it, unchanged).

---

## 6. Aastha Before/After Comparison

| | Before this milestone | After |
|---|---|---|
| Aastha `ExperienceUnit`s | 27 (steps merged) | 49 (steps separated) |
| Capability-to-capability edges (any kind) | 5 (`COMPLEMENTS` only) | 4 `custom:sequence` (0 `COMPLEMENTS` — the bullet fix removed the within-unit adjacency that used to produce them, since each step is now its own unit) |
| `composeWorkflows()` result | 4 fragmented `CandidateWorkflow`s, every multi-step one `ambiguous_precedence`, every step `tieBroken: true` | 6 `CandidateWorkflow`s: **two genuine 3-step ordered workflows** (`source_derived_ordering`, zero `ambiguous_precedence`), plus 4 real singletons |

---

## 7. Workflow Output for Reconciliation (Phase 5 Proof)

Running the real, unmodified `composeWorkflows()` against the real, recompiled Aastha XOIR graph produces exactly two multi-step candidate workflows (capability names below are the literal source-derived labels the capability extractor already produces — nothing invented, normalized, or hand-typed):

**Workflow `wf_0ad1eb94ca05dcc0`** — 3 steps, `gaps: ['source_derived_ordering']`, no `ambiguous_precedence`:

| order | capabilityId | capabilityName | ordered after | evidenceStrength | source page |
|---|---|---|---|---|---|
| 0 | `cap_2f06d223ed11ccf194a869b75e4a99ea` | Verify Expected Brokerage from... | — | — | 1 |
| 1 | `cap_37de766dca8dab48c56df837a9685cf9` | Reconcile invoice amounts... | `cap_2f06d223...` via `custom:sequence` | `source_derived` | 1 |
| 2 | `cap_c6ac1b757dfaa1db45c1db27717a6578` | Validate TDS and G[ST]... | `cap_37de766d...` via `custom:sequence` | `source_derived` | 2 |

**Workflow `wf_454d8330d18dce64`** — 3 steps, `gaps: ['source_derived_ordering']`, no `ambiguous_precedence`:

| order | capabilityId | capabilityName | ordered after | evidenceStrength | source page |
|---|---|---|---|---|---|
| 0 | `cap_58990c71b7895d4e4490c71ca816e3a3` | Record incoming payments... | — | — | 2 |
| 1 | `cap_7011177ec83a655edd8e688912ec6b35` | Calculate and book TDS | `cap_58990c71...` via `custom:sequence` | `source_derived` | 2 |
| 2 | `cap_2877c162a1539a5d8882d4959ee872c5` | Reconcile the invoice balance | `cap_7011177e...` via `custom:sequence` | `source_derived` | 2 |

Every requested reporting field is present per step above (capability ID, source page/provenance, sequence evidence, evidence strength) plus per-workflow gap kind. `viaEdgeKind` is `custom:sequence` on every transition (omitted from the table for width; present in the raw JSON). No `tieBroken: true` appears anywhere in either workflow — real evidence resolved every transition.

**Honest limitation:** "Match CRM records vs. Insurer statements" — the first of the four steps named in the brief's canonical example — does **not** appear in either workflow, because it was never discovered as a `Capability` at all by Stage 5 (the verb "Match" does not trigger the capability-lexicon's verb detector; confirmed by checking the full 10-capability list from the real compiled graph — no capability with that name exists). This is a **pre-existing Stage 5 capability-discovery gap**, unrelated to sequence evidence or the ordering machinery built in this milestone, and out of scope per the "do not modify unrelated extraction behavior" constraint. Per the brief's own instruction not to invent or normalize source labels, this step is reported as **absent**, not synthesized.

---

## 8. Negative-Case Results (Phase 6)

All required cases tested, all pass, at both the compiler level (`relationship-builder.test.ts`) and the workflow-composer level (`compose.test.ts`):

| # | Case | Result |
|---|---|---|
| 1 | Unrelated capabilities in the same unit | Get `custom:sequence` + `complements` (adjacency-based, as designed) but **never** `requires`/`depends_on` — asserted directly |
| 2 | Capabilities in different `ExperienceUnit`s (same section) | Cross-unit sequence fires correctly, ordered by `blockIndexRange` regardless of `perUnit` array order |
| 3 | Capabilities in different documents (same `parentUnitId` string, different `documentPath`) | **No** sequence edge — confirmed zero |
| 4 | Capabilities with only `COMPLEMENTS` | Still produces `ambiguous_precedence` in workflow-composer — confirmed `complements` was never repurposed |
| 5 | Capabilities with explicit logical dependency (`REQUIRES`) | Unaffected — ordered exactly as before, `evidenceStrength: 'logical'` |
| 6 | Capabilities with no ordering evidence at all | Remain separate singleton `CandidateWorkflow`s — no sequence invented from mere co-presence |
| 7 | Mixed strong + weak evidence in one component | Both facts combine into one valid order; only the weak transition's rationale is labeled `source_derived`, confirmed per-transition, not per-workflow |
| 8 | Deterministic repeated compilation | Two independent `mergeCapabilities`/`buildCapabilityRelationships` runs on identical input produce `deepEqual` relationship lists; two independent `composeWorkflows` runs on the sequence-only fixture produce identical step ordering |
| — | Different-section adjacency (not explicitly listed but tested) | No sequence edge across `parentUnitId` boundaries |
| — | Gap-bridging over a real heading | **Caught by testing, then fixed** — see §4 |
| — | Gap-bridging over an empty/whitespace-only unit | **Caught against real Aastha data, then fixed** — see §4 |

`ambiguous_precedence` behavior when sequence evidence is genuinely unavailable is unchanged and directly re-verified (`buildComplementsOnlyFixtureGraph` test).

---

## 9. Cross-Domain Results (Phase 7)

Ran against all 3 real fixtures plus the existing synthetic corporate-lawyer fixture (already exercised by the pre-existing test suite, unmodified, all still passing):

| Fixture | Capabilities | `custom:sequence` edges | Candidate workflows | Total steps | Multi-step workflows | `ambiguous_precedence` workflows | `source_derived_ordering` workflows |
|---|---|---|---|---|---|---|---|
| Aastha (operations procedure) | 10 | 4 | 6 | 10 | 2 | 0 | 2 |
| burglary-policy (contract clauses) | 6 | 0 | 6 | 6 | 0 | 0 | 0 |
| commercial-property (contract clauses) | 26 | 9 | 18 | 26 | 1 | 1 | 1 |

**No false or obviously-unrelated compositions found** in any fixture — spot-checked every multi-step result by name.

**burglary-policy produced zero sequence edges** — its capabilities are spread across sections without the same-section, blockIndexRange-adjacent shape the signal requires; this is the expected, correct behavior for a clause-by-clause contract document with few procedurally-sequential passages, not a bug (its capabilities were never sequence-related in the source either).

**commercial-property's single multi-step result is the most informative real-world case found**, and is reported here in full rather than only the clean Aastha case: a 9-step workflow with **all three** gap kinds present simultaneously — `source_derived_ordering`, `ambiguous_precedence`, **and** a pre-existing `circular_dependency` (from `REQUIRES` edges unrelated to this milestone). Of the 9 steps, 2 are genuinely `tieBroken: true` (no evidence reaches them) and 7 are ordered by real `source_derived` sequence evidence. One step name (`"6. Claims Procedure"`) is a section-heading fragment misclassified as a capability by Stage 5's shape-based detector — a pre-existing capability-discovery precision issue (documented in the earlier Semantic Richness Investigation, Finding C), not something this milestone's sequence-evidence logic caused or could fix, since it operates only on whatever `Capability` nodes Stage 5 hands it. This is reported transparently rather than cherry-picking only the clean Aastha result — the milestone was explicitly instructed not to optimize specifically for Aastha, and this result is the honest evidence of that.

The synthetic corporate-lawyer fixture (fully `REQUIRES`-based, no sequence edges) composes identically to before — confirmed by all 14 pre-existing workflow-composer tests passing unchanged.

---

## 10. Full Test Results (Phase 8)

| Suite | Before (baseline) | After | New failures | Pre-existing failures (unchanged) |
|---|---|---|---|---|
| `@xo/compiler` full suite | 750 pass / 7 fail | 761 pass / 7 fail | **0** | 7 (identical test names, both runs) |
| `@xo/compiler` — `capabilities/*` + `xoir/*` only | (subset of above) | 233 pass / 7 fail | 0 | 7 (identical names) |
| `@xo/workflow-composer` full suite | 14 pass / 0 fail | 19 pass / 0 fail | 0 | 0 |
| `@xo/capability-contract` | 140 pass / 0 fail | 140 pass / 0 fail | 0 | 0 |
| `@xo/runtime` | 17 pass / 0 fail | 17 pass / 0 fail | 0 | 0 |
| `@xo/xoir` | 119 pass / 0 fail | 119 pass / 0 fail | 0 | 0 |
| Full monorepo `npm run build` | clean | clean | — | — |
| `examples/e2e-pdf/run.ts` (burglary-policy, older harness) | all PASS/NOT_APPLICABLE (no true FAIL) | identical result | 0 | — |
| `examples/vertical-test/run.ts` (synthetic fixture, binding→runtime→execution) | 18/18 checks PASS | 18/18 checks PASS, byte-identical behavior | 0 | — |

**One pre-existing test was intentionally updated, not silently left broken or silently patched around:** `relationship-builder.test.ts`'s `"resolves extractor-supplied candidate edges..."` test asserted an exact relationship count of 2 for two non-title capabilities in one unit. Since within-unit sequence evidence now correctly also fires on that exact pair (by design — see §4), the expected count is now 3, and the test was updated with an inline comment explaining why, plus an added assertion that the new `custom:sequence` edge is indeed present. This is an **expected behavioral change** caused directly by this milestone, not a regression — every other pre-existing assertion in that test still holds.

**The 7 pre-existing compiler failures are unrelated to this milestone** (rule-capability-linking vocabulary-matching tests and one XOIR confidence-gate test, all failing for reasons predating this work) and are reproduced identically, by exact test name, in both the pre-fix and post-fix runs (verified via a controlled temporary-revert comparison, not just count-matching).

---

## 11. Remaining Limitations

- **"Match CRM records" is not discoverable** as a capability at all (Stage 5 verb-lexicon gap) — the sequence-evidence machinery built here is correct but has nothing to attach to for that specific step. Out of scope for this milestone.
- **Section-heading misclassification as a capability** (e.g., "6. Claims Procedure", "Brokerage Validation:") — a pre-existing Stage 5 precision issue (first identified in the Semantic Richness Investigation, Finding C) that can end up as a spurious step in a sequence-evidence-ordered workflow. Sequence evidence does not create this problem, but it does now surface it more visibly by successfully stitching such a node into an otherwise-coherent chain.
- **Sequence evidence is section-scoped only** — it deliberately does not attempt to sequence across section boundaries (e.g., two related sub-procedures under different headings) or across documents. This is a conservative choice per the brief's instructions, not a discovered limitation; extending it would need real evidence from a fixture demonstrating cross-section procedural continuity, which none of the 3 real fixtures currently provide.
- **No `CandidateWorkflow` → runtime execution consumer exists** (confirmed absent in the original Semantic Richness Investigation, Finding E, and unchanged by this milestone, which was explicitly scoped to stop short of it).
- **`circular_dependency` and `ambiguous_precedence` can still coexist with `source_derived_ordering`** in the same real workflow (seen in commercial-property) — this milestone reports that mix honestly rather than hiding it, but a consumer of `CandidateWorkflow` needs to check all three gap kinds, not assume they're mutually exclusive.

---

## 12. Recommended Next Milestone

**Workflow → Executable Strategy Resolution** (not runtime implementation) — per the brief's own direction. Concretely: given a `CandidateWorkflow` with a real, evidence-backed step order (now available, as of this milestone) and each step's already-resolved `SemanticCapabilityContract`/binding (already available, per the frozen Action Capability Binding v1 work), determine what it means to treat that ordered sequence as a single higher-order executable unit — how the runtime should read a `CandidateWorkflow.steps[]`/`rationale` structure (including honestly distinguishing `logical` from `source_derived` transitions when deciding how cautious to be) — **without** yet building the actual execution loop. This is the natural next boundary: it consumes exactly what this milestone now produces, and stops exactly where "build a workflow runtime executor" would begin.

---

> No changes outside Sequence Evidence for Workflow Composition.
