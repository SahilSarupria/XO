# XO Benchmark — Golden Expectations

**P0.9C Step 3.** This document audits the benchmark's ground truth: for each case, what is expected, what is forbidden, what is
intentionally open-world, what evidence supports it, and what is deliberately *not* ground truth. It measures ground-truth **quality**;
it does not improve any score. The evaluation semantics it relies on are in `EVALUATION_MODEL.md` (frozen in Step 2).

Machine-checkable companion: `ground-truth/<suite>.ground-truth.json` (one register per suite), parsed and audited by
`src/ground-truth.ts` and pinned by `test/ground-truth.test.ts`. The suites themselves (`suites/*.suite.json`) are the golden expectations
and are the only thing evaluated; the register is **benchmark ground-truth provenance** and is imported by nothing in the evaluation path.

## 1. Rules applied

* Ground truth must be supported by the **fixture** or by existing documented benchmark evidence (`CHANGELOG.md`, suite descriptions). Nothing was
  added from general domain knowledge, and nothing was added to make the benchmark more demanding.
* Nothing was weakened because the implementation fails it. Expectations that currently fail (e.g. `spuriousCapabilityAvoidance` 0/10) are retained.
* A forbidden expectation needs an explicit reason and a firm basis. A plausible false positive is not forbidden unless the fixture says why.
* Where the fixture cannot establish an expectation it is recorded as `ambiguous`, `not_established`, `not_measurable` or `open_world` (register
  `unestablished`) and left unmeasured — never invented.
* A world declaration that looks unsupported is **reported and left unchanged** (§4).

## 2. Confidence vocabulary (descriptive; no numeric score)

| Basis | Meaning |
|---|---|
| `explicit` | The source states it (a verbatim clause, a declaration, or a hand-built graph definition). |
| `strongly_evidenced` | Clearly supported, but the wording/name/shape is a normalisation of the source (e.g. an action clause title-cased by XO's naming convention). |
| `derived` | Follows only through a documented system rule (naming convention, execution-class semantics, runtime input contract). Supportable, not stated. |
| `ambiguous` | The fixture supports more than one reading. Kept (removing it would be a judgment made *because of* current behavior) and flagged. |
| `not_established` | Not supported. **Never** valid on a suite expectation; such items live under `unestablished`. |

Each register entry has an `identity` basis (that the item exists / is forbidden / is requested) and, where it differs, an `assertions` basis
(the asserted class, resolution, inputs, outputs, outcome). Across all 153 expectations: **83 explicit, 47 strongly evidenced, 16 derived,
7 ambiguous.** The 7 ambiguous are listed in §5.

## 3. Case-by-case assessment

| Case | Fixture | Expectations | Identity basis | World (facts / caps / workflows) |
|---|---|---|---|---|
| `synthetic-claim-rules` | 370-byte authored text, one IF/THEN rule | 2 facts, 3 forbidden facts, 2 caps, 1 workflow, 6 execution | 4 explicit · 4 strongly · 6 derived | closed·supported / closed·supported / closed·supported |
| `commercial-property-policy` | 3-page synthetic policy PDF | 22 facts, 1 forbidden fact, 18 caps, 6 forbidden caps, 2 workflows, 17 execution | 25 explicit · 35 strongly · 2 derived · 4 ambiguous | **closed·questionable** / open / open |
| `aastha-operations` | real SOP PDF (2 pages) | 15 caps, 3 workflows, 3 execution | 13 explicit · 2 strongly · 4 derived · 2 ambiguous | open (none) / **closed·questionable** / open |
| `burglary-policy-schedule` | 4-page policy schedule PDF, mostly data | 2 facts, 1 cap, 3 forbidden caps | 4 explicit · 1 strongly · 1 ambiguous | open / open / — |
| `multidoc-burglary-claims` | 3 plain-text policy documents | 4 facts, 4 forbidden facts, 6 caps, 1 forbidden cap | 10 explicit · 5 strongly | open / open / — |
| `structured-operation-data-flow` | 2-operation JSON contract | 2 caps, 1 workflow, 2 execution | 3 explicit · 2 derived | — / closed·supported / closed·supported |
| `openapi-operation-data-flow` | same contract as OpenAPI | identical expectations (identical fingerprint) | 3 explicit · 2 derived | — / closed·supported / closed·supported |
| `runtime-mechanics` | hand-built XOIR graph | 8 caps, 4 workflows, 9 execution | 21 explicit (by construction) | — / closed·by construction / closed·by construction |

Per-expectation source locators (clause / section / page) and notes are in the registers. Independent checks made against the source text
(`pdftotext`, not XO): 47 of 48 golden `pages` claims verify; the one exception (`t2.3`) is a verb normalisation ("The CRM generates" → "Generate a …")
already verified in the CHANGELOG. Every forbidden-trap reason was checked against the source (e.g. the word "Schedule" occurs only as a noun in
the commercial policy and the multi-document set; "Contact No" / "Email ID" are field labels on page 2 of the burglary schedule).

### Ground-truth basis by case (what each expectation is grounded in)

* **synthetic-claim-rules** — the rule and thresholds are explicit (15000 → deny; 10000 and 5000 → no match, because "exceeds" is strict). Capability
  names, the workflow shape and the runtime input-validation cases are *derived* from XO conventions and stated as such.
* **commercial-property-policy** — authored from the PDF text independently of XO. Facts are verbatim clauses (8.1/8.2 are stated rules without an
  If/When form). Execution cases A–H come from the document's own Appendix A. Known real gaps (mis-parsed 11.1, the flood-endorsement fragment, missing
  denial/coverage-review capabilities, "Schedule …" fragments) are expected failures the baseline records.
* **aastha-operations** — imperative bullets of sections 3–5 (explicit); `t2.3` and `t4.1` are non-imperative statements (derived); every task is
  classed `human_in_the_loop` by a documented classification rule, not by a source statement.
* **burglary-policy-schedule** — small and negative-heavy by design: two explicit facts, one instruction, and traps for field labels and contact rows.
* **multidoc-burglary-claims** — explicit duties and two quoted definitions; the traps are sentence-initial function words that do occur in the text.
* **structured / OpenAPI** — every name, parameter and dependency is stated in the source. "Unresolved / not_executable" is the documented contract
  for operations with no implementation.
* **runtime-mechanics** — the hand-built graph *is* the ground truth (`fixtures/build-xoir-fixtures.ts`); it measures mechanics, not extraction.

## 4. World-model assessment

A closed-world declaration claims *"the expected set is sufficiently complete that unexpected observed items can be treated as incorrect."*
Every declaration was checked against the fixture. **No declaration was changed.**

| Scope | Declaration | Assessment |
|---|---|---|
| synthetic — facts (`decision_node`), capabilities, workflows | closed | **Supported.** One conditional rule in the whole source. |
| structured / OpenAPI — capabilities, workflows | closed | **Supported.** Exactly two operations and one stated dependency. |
| runtime-mechanics — capabilities, workflows | closed | **Supported by construction** (8 capability nodes, all expected). Facts are *not* declared (3 concepts / 4 decision nodes exist but are not asserted) — the suite description's "closed world everywhere" holds for capabilities and workflows only. |
| commercial — facts (`heuristic`) | closed | **Questionable — reported, not changed.** The 22 facts omit clause 10.4 ("Where a loss appears suspicious, the claim may be referred for enhanced review"), which has the same explicit conditional form as included rules, and 4.5 / 5.4 / 5.6 / 8.4 / 3.1 are conditional exceptions. Section 10 is titled "Ambiguous and Semantic Provisions", so the omission may be deliberate, but the suite does not say so. **Effect today: none** — XO emits no heuristic for them (semanticPrecision 21/23: the two failures are the flood-endorsement fragment and the mis-parsed 11.1). A future *correct* extraction of 10.4 would be scored `unexpected`. |
| aastha — capabilities | closed | **Questionable — reported, not changed.** The declared claim is "one capability per stated task", but the task/description boundary is a judgment: the list includes two passive statements (2.3, 4.1) and excludes the equally passive 2.2 "Policy Entry"; the suite description says "sections 3–5" though `t2.3` is from section 2. **Effect today:** `capabilityPrecision` 15/16 — the one unexpected capability comes from the *descriptive* §2 item 1 "Sales Sourcing", which is plausibly correct to count against XO. |
| commercial / burglary / multidoc — capabilities; burglary / multidoc — facts; all workflows other than the above | open | **Supported.** Each golden list is demonstrably partial (e.g. at least five more stated duties in the multi-document set). Open scopes are never over-claimed; the register pins this. |

Recommended follow-up (a decision, not done here): either state the inclusion criterion for aastha's closed list and the scope of commercial's
closed `heuristic` list in the suite descriptions, or move those two scopes to open world with a Step 7 baseline refresh. Both change what
`semanticPrecision` / `capabilityPrecision` mean for those cases, so they belong to an explicit decision.

## 5. Ambiguous, unmeasured and not-established

Seven expectations are kept but flagged `ambiguous` (none is a forbidden expectation):

| Case / expectation | Why ambiguous |
|---|---|
| commercial `cA.H-review-not-covered-hitl`, execution `H-coverage-review-human`, execution `wf-hitl-review`, workflow `wf-hitl-coverage-review` | Appendix A Case H names an *outcome* ("coverage review / not covered under standard rule"), not an operator task; the capability name is a parse of that outcome. The one-step workflow has no sequence in the source. |
| aastha workflow `wf-partner-payouts` and execution `wf-partner-payouts-escalates` | A one-step workflow; the source states no order. |
| burglary capability `validate-policy-copy` | A link caption addressed to the policyholder; equally imperative lines ("Click here…", "please call…") are not asserted. |

Deliberately **not** ground truth (register `unestablished`), so left unmeasured: aastha's prohibitions and notes, "Policy Entry", "Sales Sourcing", the
MIS report contents, any cross-section process order, and any emergency/escalation procedure (the SOP states none); commercial clauses 10.1 / 10.5,
10.4 and the other exceptions, and any process order across sections 7 and 9; the burglary schedule's data fields (not expertise); remaining duties in
the multi-document set; and runtime-mechanics' semantic facts. The real Aastha SOP remains **validation evidence, not a complete golden dataset**.

## 6. Matching audit

| Layer | Behavior |
|---|---|
| Text | `normalizeText`: lower-case + whitespace collapse. No stemming, no punctuation handling, no fuzziness. |
| Capability / step names | `equals` (normalised exact) or `contains` (normalised substring). |
| Facts | `kind` + predicates over node properties (`equals` / `contains` / `exists`), normalised. |
| Capability & fact assignment | **Greedy** over id-sorted expectations (L3). |
| Workflow steps | Perfect bipartite assignment onto the observed steps, exact step **set**; not greedy. |

Findings on the real pipeline (all 8 cases): **no expectation has more than one candidate and no observed item satisfies two expectations** — so
L3 is latent and the matcher is sufficient; it was not redesigned. Suites contain no duplicate ids or duplicate matchers, and no forbidden trap would
satisfy an expected item. One genuine golden defect was found and corrected (§7). The matcher's *substring* semantics does make a few matchers weak
(e.g. aastha `t4.1` matches on `in Tally Prime`); they are recorded in the register, unambiguous today, and left unchanged.

## 7. Changes to golden expectations (Step 3J)

Exactly **one** expectation changed. See `CHANGELOG.md` for the full record.

* **Where:** `vertical-fixtures` · `aastha-operations` · workflow `wf-reconciliation-tasks`, step 3.
* **Old:** `contains: "Reconcile invoice amounts vs. receipt amounts"` **New:** `contains: "Reconcile invoice amounts vs receipt amounts"`.
* **Why / evidence:** capability names strip punctuation from object words (documented in the Layer 1B entry), so a matcher containing `.` can never match
  any implementation; the observed capability is `Reconcile invoice amounts vs receipt amounts received`. This is the same defect already fixed in the
  sibling capability expectation `t3.4-reconcile-invoice-vs-receipt`; the workflow step was missed.
* **Affected metric:** none numerically — every numerator, denominator and ratio in both suites is identical, and the comparison classification is
  `no_change`. It changes the **attribution** of the `workflowRecall` miss from the `capabilities` stage to the `workflows` stage (the defective matcher made a
  step capability look undiscovered; the capabilities exist and the composer simply does not produce a workflow with exactly these four steps) and the wording
  of its reason. The underlying signal is preserved: `workflowRecall` for this case is still 2/3.
* **Not changed:** the exact-step-set requirement. The composer emits one 7-step workflow that contains these four steps plus three others; that is a real
  composer gap and is kept.

## 8. Remaining golden-ground-truth limitations

1. Two closed-world declarations are questionable (§4) and unresolved pending a decision.
2. Trap and capability **name strings** are XO-normalised output, and some (e.g. the "Schedule …" fragments) were first seen in XO's output. Their *basis*
   is the source text, but their identity strings are not independent of XO. Recorded per entry.
3. Several expectations are `derived` (classification rules, runtime contracts): they test the system's own contract, not source content.
4. Substring matchers (`contains`) can be weak; only unambiguous today.
5. Seven `ambiguous` expectations (§5) are retained pending a decision.
6. `evidence` (page/document) is absent on some expectations (e.g. all burglary items, several commercial/multidoc capabilities); the register carries locators for all of them.
7. The vertical baseline still predates P0.9A and the Step 3 attribution change; both are cosmetic until Step 7 regenerates it.
