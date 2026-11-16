# UW-3b test record (document structure: layout, procedures, guidelines, clause naming)

Branch `uw-3b/pdf-layout-procedural`, stacked on `uw-13/evaluation-harness`. Compared by name against `docs/baseline/tests-26f0052.tsv`.
Design: ADR 0027. Limits: `docs/KNOWN_LIMITATIONS.md`, "Reading documents".

## Behaviour changes callers can see

- **Procedural documents compile to ordered steps.** A section with a step table or numbered instructions becomes one step capability
  per step (`producedBy: procedure-step`). The steps are ordered by sequence edges and carry their done-when. A fill-in form before the
  first step supplies its inputs.
- **Guidelines and checklists become constraints with modality.** "Never commit secrets" is a prohibition. A definition-of-done item is
  an `acceptance_criterion` constraint tied to the procedure.
- **`understanding` on the capability projection** (`GET .../capabilities`):
  - `manual_step`: Studio shows "Understood, manual step". The step stays unresolved, not approvable and not runnable.
  - `possible_extraction_error`: Studio shows a notice to check the name against the source.
- **Capability names are clause-bounded.** For example, "Notify the insurer of the loss within 48 hours" was cut to "Notify the insurer
  of the loss within" before. Placeholder and fragment capabilities are no longer minted.
- **The unknown-domain notice** names the sections that were still read by structure.
- **`assistStructure`** (`@xo/compiler`) is an optional model fallback for unrouted sections. It is off by default and enforces UW-14
  residency.
- **Studio visual check (all six W1 branches)** is informational: it never fails a PR and always uploads the screenshot artifact.

## TaskTest.pdf (the reported case)

| Measure                          | Before (`uw-13`)                                                 | After                                                                    |
| -------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Capabilities                     | 12 stitched names ("Check naming Diff is clean feedback errors") | 8 steps: Understand, Plan, Set up, Build, Test, Review, Deliver, Reflect |
| Order                            | none                                                             | 7 sequence edges, one ordered workflow                                   |
| Constraints                      | 2 (form prompts misread as rules)                                | 21: 8 ground rules, 4 troubleshooting tips, 9 acceptance criteria        |
| Review items                     | 7, of them 5 uncovered sentences                                 | 1, the informational unknown-domain notice                               |
| Cross-column or row-number names | yes                                                              | none                                                                     |

## Insurance and operations fixtures

Every non-capability node is byte-identical. So is every policy tree:

| Fixture             | Identical non-capability nodes |
| ------------------- | ------------------------------ |
| burglary            | 211                            |
| Commercial Property | 121                            |
| Aastha              | 67                             |

Capability changes:

| Fixture             | Before | After | Removed (all benchmark-forbidden or of that class)                                                                                                                              | Renamed                                                                                                                                                                                        |
| ------------------- | ------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| burglary            | 7      | 4     | "Schedule Action" (deterministic_rule); "Contact and 9821631474 AASTHA INSURANCE BROKER aastha9ins@rediffmail.com" (human_in_the_loop, cross-column row); "Contact No Email ID" | "Contact 24-Hour Call Centre at 1800-258-5956" → "Contact 24-Hour Call Centre"                                                                                                                 |
| Commercial Property | 31     | 25    | "Record Action", "Review Action", "Schedule Action", "Schedule and the loss is not excluded", "Schedule specifies a higher deductible", "Schedule that the Insured must bear"   | 7, for example "Notify the Insurer of a loss within" → "... within 7 days"; "Record before payment authorization" → "Record the settlement amount"; "6. Claims Procedure" → "Claims Procedure" |
| multidoc            | 9      | 5     | "Schedule Action", "Schedule against loss or damage caused", "Schedule subject to the conditions and exclusions", "Schedule together with its permanently fixed fittings"       | 4, for example "Notify the police immediately and obtain" → "Notify the police immediately"                                                                                                    |
| Aastha              | 16     | 16    | none                                                                                                                                                                            | 11, for example "Create in Tally Prime based solely" → "Create Sales invoices in Tally Prime"                                                                                                  |

Burglary's resolved capabilities go from 5 to 3. The two removed resolved capabilities were benchmark-forbidden (`x-schedule-action`,
`x-partner-contact-row`). Commercial Property keeps 19 resolved. Benchmark detail: `packages/benchmark/CHANGELOG.md` (UW-3b).

## Evaluation corpus (`document-structure` suite, 7 documents)

| Metric                      | Before | After |
| --------------------------- | ------ | ----- |
| capabilityRecall            | 0/20   | 20/20 |
| capabilityPrecision         | 0/22   | 20/20 |
| semanticRecall              | 2/41   | 41/41 |
| semanticPrecision           | 2/5    | 41/41 |
| spuriousCapabilityAvoidance | 0/3    | 3/3   |
| spuriousFactAvoidance       | 1/4    | 4/4   |
| workflowRecall              | 0/4    | 4/4   |

Six of the seven documents were written for this work, so these numbers show the mechanism, not accuracy on real documents.

## Same name, body changed

| Test                                                                                                                                                                                                     | Change                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Problem C — insurance fixture: existing behavior does not regress` (`packages/compiler/test/xoir/rule-capability-linking-real-fixture.test.ts`)                                                         | Re-measured: `same_unit_term_overlap` links 40 → 20 and rule-to-capability edges 152 → 151. Diffed link by link: every removed link pointed at a forbidden placeholder ("Record Action", "Review Action", "Schedule ..."); no genuine link was lost. |
| All tests in `apps/api/test/preview-capability.test.ts`                                                                                                                                                  | `UNRESOLVED` is now "Assess the claim". The previous pick ("Schedule specifies a higher deductible") is no longer minted.                                                                                                                            |
| `DEMO (real fixture): Commercial Property PDF -> compile -> discover -> the one executable workflow ...` (`apps/api/test/workflow-executions.test.ts`)                                                   | The workflow status list is re-measured, and the human-in-the-loop workflow is selected by content, not by position.                                                                                                                                 |
| `capabilities on a source with real decision-rule content ...` (`apps/cli/test/capabilities.test.ts`) and `create against a source with real decision-rule content ...` (`apps/cli/test/create.test.ts`) | 31 → 25 capabilities.                                                                                                                                                                                                                                |
| `demo commercial-property: real deterministic rule evaluation ...` (`apps/cli/test/demo.test.ts`)                                                                                                        | Finds an unresolved capability by searching every workflow instead of assuming index 0.                                                                                                                                                              |
| `taxonomy: exactly the values the repository can stamp ...` (`packages/benchmark/test/producer.test.ts`)                                                                                                 | The taxonomy includes `procedure-step`.                                                                                                                                                                                                              |
| `the vertical suite reports the pipeline's real failure MODES separately ...` (`packages/benchmark/test/suites.test.ts`)                                                                                 | `semantically_invalid` is now 0 (absent); the forbidden capabilities that produced it are no longer minted.                                                                                                                                          |
| `real pipeline (all 8 cases): the three paths ...` (`packages/benchmark/test/cross-path.test.ts`)                                                                                                        | `binding.not_comparable` 19 → 18; lowered contracts 41 → 39.                                                                                                                                                                                         |
| `real pipeline (all 8 cases): every compiled capability has a connected chain ...` (`packages/benchmark/test/provenance.test.ts`)                                                                        | Compiled capabilities 69 → 56.                                                                                                                                                                                                                       |
| `AUDIT (historical): ...` (`packages/benchmark/test/baseline.test.ts`)                                                                                                                                   | Known drift 16 → 23 (seven UW-3b records).                                                                                                                                                                                                           |
| `the historical predecessors are retained ...` and the commercial fingerprint test (`packages/benchmark/test/p09c-closure.test.ts`)                                                                      | 24 drift records, 5 archived reports, commercial expectations `3d36c848051e895b`.                                                                                                                                                                    |
| `counts each state` and the `nextStep` cases (`apps/studio/test/domain/review.test.ts`)                                                                                                                  | `ReviewSummary` has `manualSteps`.                                                                                                                                                                                                                   |

No baseline test was renamed or removed.

## Added

- `packages/compiler/test/document/layout-recovery.test.ts` (18):
  - the bullet glyph;
  - marker-led lists, checkboxes and titles;
  - wrapped tables, with their rejection rules;
  - forms and the column-gap flag.
- `packages/compiler/test/capabilities/clause-naming.test.ts` (11):
  - clause boundaries, deadlines, passives and determiners;
  - coordinated modal clauses;
  - the abbreviation sets of the sentence splitter.
- `packages/compiler/test/semantic/structure.test.ts` (9):
  - routing and directives;
  - the TaskTest.pdf definition-of-done checks;
  - the burglary policy, which is not routed.
- `packages/compiler/test/ai-assist/structure-assist.test.ts` (6): off by default, residency denial, proposal validation, failures.
- `packages/benchmark/test/document-structure.test.ts` (2): the new suite's exact metrics and its audit.
- `apps/api/test/understanding.test.ts` (1): a TaskTest step is a manual step, unresolved, and cannot be test-run.
- 3 Studio tests in `apps/studio/test/domain/review.test.ts`.

## Result

7,531 pass, 4 skip and 1 fail across all workspaces (Studio's 740 Vitest tests included). The one failure was the drift count in
`p09c-closure`, updated above; that file passes 7/7 on re-run.

By name against the UW-0 baseline, nothing regresses beyond UW-1's documented benchmark rename. Also run:

- `npm run build`, `npm run lint`, `npx prettier --check .` and `npm run typecheck`, all clean;
- `npm run eval -- --check`, up to date.
