# xdomain — cross-domain CANDIDATE corpus (M0b)

Status: **candidate, not an accepted baseline.** Nothing here touches `baselines/BASELINES.json`, existing suites or labels.

## Composition
- 9 synthetic documents (HR leave, equipment loan, IT-ops SOP, software contract, warranty, procurement, travel/expenses with INR, facility access (compound-condition traps),
  clinical abstract) = 48 labelled clauses. Domains differ from the insurance fixtures on purpose.
- `formats/`: plain, table-heavy, two-column and image-only ("scanned") PDFs plus DOCX of `loan` and `leave` (ASCII only).
- Deliberate stressors: OR/AND compounds, negation inside conditions, exceptions, permissions ("may"), prohibitions, temporal
  limits, conflicting clauses (procurement 1.1 vs 1.6), vague language (travel 1.4), non-rule reference text (research).

- `prompts.gold.json`: 9 synthetic prompts (interpretation accuracy + prompt/document convergence).
- `domain-id.gold.json`: 21 items for domain identification (9 corpus docs, the real property policy, 4 positives per known
  domain family incl. synonym-only wording, 1 mixed, 4 adversarial/unknown). Labels were fixed BEFORE running; the packs and the
  set share an author, so this is a sanity check, not independent evidence. Config A = no retrieval, B = structured packs,
  C = + vectors (deliberately not implemented; adopt only if it measurably beats B).

## Annotation
Per clause: type, modality, polarity, outcome (`approve|deny|escalate|requires_approval|none`), condition operand count,
exception count, temporal flag, extras. `requires_approval` is kept distinct from `escalate`.

## Metrics (reported by layer, never blended)
Ingestion: `clauseTextRecallPct` (token-set), OCR page count, diagnostics. Semantic: clause coverage, compound-condition handling split into `partialStructureSilentLoss` (structure present but with fewer operands than the clause: dangerous) vs `unstructuredFailClosed` (no structure, raw text kept: safe), exception capture, permission-treated-as-rule, unmatched rule nodes, modality/polarity representation, policy-tree presence.
exception capture, permission-treated-as-rule, unmatched rule nodes, modality/polarity representation, policy-tree presence.

## Label corrections log
- facility 1.2: modality `declarative` -> `may` ("entry is permitted" is a permission); found when the typed-modality metric disagreed, author error, corrected openly.
- sop 2.1: outcome label `escalate` disputed ("notify the engineering director" is a notification, not an explicit escalation); left unchanged, flagged `label_disputed`.
- loan 2.1: modality label disputed (consequence statement); left unchanged and flagged `label_disputed` for second-annotator review.

## Known measured gaps (not hidden by relabelling)
- travel 1.1: the explicit "if ..." clause is structured, but "eligible" is a qualifier INSIDE the object phrase ("for eligible
  travel expenses") that the condition grammar cannot see, so the structured condition covers 1 of the 2 gold conditions
  (`partialStructureSilentLoss` 1/10). The rule is a permission and is not minted as executable, but embedded qualifiers are an
  open problem (candidate for the validated AI-assisted extractor).
- Unconditional statements with a long subject or a modal buried in a subordinate clause are still not extracted (kept out on
  purpose by the parser's precision contract) and are reported by the coverage guard instead.

## Limitations (read before trusting numbers)
- Single annotator = the document author; no independent review; synthetic text is cleaner than real documents.
- Node-to-clause matching is a token-overlap heuristic (>=0.7 of node tokens in clause); spot-checked, not validated.
- Ingestion recall is order-insensitive (does not detect reading-order scrambling).
- Small N (44 clauses); do not infer rates beyond "defect observed / not observed".
- Modality accuracy is not measurable yet: current nodes carry no modality/polarity fields.

## Run
`npm ci --ignore-scripts && npx tsc -b packages/compiler apps/cli && python3 build_corpus.py && python3 build_formats.py && npx tsx packages/benchmark/xdomain/run-baseline.mts`
(needs `reportlab python-docx pillow`). Output: `baseline-candidate.json`.
