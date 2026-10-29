# Insurance development corpus (SYNTHETIC)

Six generated PDFs (health, motor, claims SOP, property schedule with tables, two-column travel terms,
underwriting guidelines) and `labels.json`, the 65 rules each document is known to contain.

**This is not evidence of customer-level quality (CR decision CRD-06).** The same team wrote the documents
and the extractor, so it measures gaps and regressions only. Held-out evidence needs real, anonymised
customer documents.

```
python3 examples/insurance-dev-corpus/generate.py          # regenerates pdfs/ and labels.json (deterministic)
node --import tsx examples/insurance-dev-corpus/measure.mts [--list-gaps] [--json out.json]
```

Per rule the strongest level reached is `modeled` (a decision/constraint/capability/heuristic node holds every
key fact), `surfaced` (only on the review list), `present` (facts appear but not as a rule), or `missed`.
`modeled` checks that the facts are carried, not that the rule's logic is right.

## Rule proposals (WS1-09)

`proposal-labels.json` is a small SYNTHETIC labelled set (rule sentences with gold conditions, non-rules,
and recorded good and adversarial replies). `proposal-eval.mts` replays the replies to measure the validation
layer, or runs a real model with `--model-cmd "<shell command>"` (prompt on stdin, reply on stdout). Replay
numbers say nothing about model quality.
