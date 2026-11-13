# 0027: Reading documents by structure before reading them as policy, and the sentence splitter's abbreviations

## Status

Accepted under owner delegation, 2026-11-13 (UW-3b). Signed off by Claude under the owner's explicit delegation of decision authority (owner instruction of 2026-11-13); this is a delegated sign-off, not an independent review.

## Context

The compiler read every document as if it were a policy. Its rule patterns expect conditional language ("if X then Y", "subject to", thresholds, exclusions), and its capability namer took a verb plus the next six words. A procedural guide (TaskTest.pdf, a software task guide) came out as 12 capabilities with stitched names ("Check naming Diff is clean feedback errors", "Create a branch e.g", "Review Re-read your diff"), all "Needs more information". There were 2 constraints, both form prompts misread as rules, and 7 review items, 5 of them lost sentences.

There were four causes:

1. Tables whose cells wrap were flattened, so their columns interleaved.
2. Numbered, bulleted and ticked items were not parsed as structure. The bullet glyph itself (WinAnsi 0x7F) was decoded to nothing.
3. Names crossed clause and cell boundaries. The shared sentence splitter ended a sentence at "e.g.".
4. Instructions, prohibitions and checklists had no extractor at all.

`capabilities/sentence-split.ts` is shared and was described as frozen (Phase 0): capability extraction, reasoning, coverage and content classification all depend on its behaviour.

## Decision

1. **Layout first.** The PDF reader rebuilds the following from geometry alone, each all-or-nothing:
   - tables whose cells wrap (column starts come from the header; a new row starts with text in the first column; a tight-gap line is a wrapped continuation);
   - marker-led lists (a marker in a column of its own, in a counted-up sequence);
   - checkboxes;
   - bold or short titles;
   - fill-in forms (labels with at least one blank value).

   A detector that cannot account for every line of a candidate region rejects it, and the lines stay exactly as before.

2. **Route sections by kind.** `semantic/structure.ts` classifies each section as one of: procedure, guideline, checklist, form, data table, policy or reference. It decides from structure (step tables, numbered instructions, checkboxes, form fields) and language (instructions, prohibitions, conditions), and records the evidence and a confidence.
   - A section is routed only when one routable kind holds at least 60% of the evidence and enough units carry it.
   - A routed unit is read by its structural extractor:
     - a procedure step becomes one step capability (`producedBy: procedure-step`), ordered by `custom:sequence` edges the author's numbering states, so the workflow composer reads the steps as one ordered workflow;
     - a guideline becomes a constraint with modality and polarity;
     - a checklist item becomes an `acceptance_criterion` constraint; when the document has exactly one procedure, the criterion records it in `appliesTo`;
     - a fill-in form placed before the first step supplies that step's inputs.

   There is deliberately no separate "procedure" capability. An earlier draft minted one as a container for the steps; it duplicated the workflow the composer already builds from the sequence edges, and its own ordering edges to the steps were inside one unit, which the relationship builder treats as unearned.
   - Policy, reference and data sections are not routed and keep today's extractors exactly. The document-level kind is a proposal (`status: 'proposed'`), never a confirmed fact.

3. **Names come from one clause.** A capability's name is the verb and its direct object up to the first clause boundary:
   - the boundary is a comma that opens a new instruction, a subordinator, an adjunct preposition, a bracket, or "and" + verb;
   - a stated deadline ("within 30 days") is kept;
   - a passive names its subject ("Create Sales invoices in Tally Prime");
   - a verb with nothing to act on is not minted, which removes the "<Verb> Action" placeholder and nouns read as verbs ("the Schedule specifies").
4. **Confidence reflects the text.** The positional prior stays and is multiplied down by observed defects: cross-column, label-glued, leaked marker, fragment, unbounded.
   - Cross-column or label-glued text is flagged `possible-extraction-error`.
   - Cross-column text that also shows a second structural defect is not minted at all (fail closed).
5. **The sentence splitter change is additive.** `vs.` is still the only original abbreviation. Two new sets are added:
   - abbreviations that never end a sentence: `e.g.`, `i.e.`, `cf.`, `viz.`, `approx.`, `fig.`, `Mr.`, `Mrs.`, `Ms.`, `Dr.`, `Prof.`, `incl.`, `excl.`, `esp.`, `resp.`, `ref.`, `ca.`;
   - abbreviations that end one only before a capitalised word: `etc.`, `No.`, `Inc.`, `Ltd.`, `Co.`, `Corp.`, `Dept.`, `est.`, `Jr.`, `Sr.`, `al.`, `pp.`, `vol.`.

   Decimals and paths were already safe, because a period is a boundary only when whitespace follows it. The splitter now only ever produces fewer boundaries than before, never more.

6. **Understood is not executable.** A prose step with no operation contract is reported as `understanding: manual-step` (Studio: "Understood, manual step"). It stays unresolved, not approvable and not runnable. "Needs more information" is kept for rules that are actually incomplete.

## Consequences

- TaskTest.pdf gives:
  - 8 ordered steps, each with its done-when;
  - 7 sequence edges, so the composer reads one ordered workflow; the 6 form fields are the first step's inputs;
  - the 8 ground rules and 4 troubleshooting tips as constraints with modality ("Never commit secrets" is a blocking prohibition);
  - 9 acceptance criteria tied to the procedure ("Step-by-Step Workflow");
  - 0 uncovered sentences. The only remaining review item is the informational unknown-domain notice.
- burglary-policy.pdf keeps every non-capability node byte-identical (211 nodes: rules, constraints, table rows, concepts) and the same policy tree. Its capability list goes from 7 to 4: it loses the benchmark-forbidden artefacts ("Schedule Action", "Contact No Email ID", the cross-column partner-contact row), and one name becomes clause-bounded ("Contact 24-Hour Call Centre at 1800-258-5956" is now "Contact 24-Hour Call Centre"; the number stays in the description).
- The Commercial Property (31 to 25), multidoc (9 to 5) and Aastha (16, unchanged) fixtures change the same way: non-capability nodes and policy trees are identical, names are clause-bounded, and forbidden placeholders disappear. A heading-named capability loses its section number ("6. Claims Procedure" is now "Claims Procedure"). Pinned counts that measured links to those placeholders were re-measured, and the reason is recorded in the tests.
- Rule-outcome capabilities (for example "The Claim Must Be Routed To An Authorized Manager") keep their title-cased outcome text. They are decision-tree outcome identifiers pinned by the golden expectations, so renaming them is a separate golden change, not part of this decision.
- Content-profile sentence counts drop where an abbreviation used to split a sentence (burglary: 117 to 113 sentences).

## Reopen if

A routed section loses a rule that the policy extractors used to find, or a measured fixture regresses on the evaluation corpus (`packages/benchmark`, suite `document-structure`).
