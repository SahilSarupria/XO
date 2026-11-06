# Evaluating the XO customer chat

Package: `@xo/intelligence-eval` (`packages/intelligence-eval`). Specification context: [CUSTOMER_CHAT.md](./CUSTOMER_CHAT.md) — the **ASK → DECIDE → DO → LEARN** loop this suite measures.

## What it is

A graded dataset, an authorization-aware fixture corpus, a runner, and a report that **fails CI below thresholds**. It runs the real `IntelligenceOrchestrator` end to end (routing, retrieval, prompts, guard rails, citation handling, DO validation, LEARN recording) against a chosen model and knowledge source.

```
npm run build
node packages/intelligence-eval/dist/cli.js                                   # oracle mode (no model, no key)
GEMINI_API_KEY=... node packages/intelligence-eval/dist/cli.js \
    --mode live --provider gemini --model <model>                             # scores a real model
node packages/intelligence-eval/dist/cli.js --category security               # one category
node packages/intelligence-eval/dist/cli.js --export-corpus ./corpus          # corpus + personas as JSON
node packages/intelligence-eval/dist/cli.js --knowledge-module ./adapter.mjs  # score a knowledge source that can serve the prose corpus (NOT C6 as-is: see C6_INTEGRATION.md)
```

Outputs `eval-out/report.json` (per-item checks) and `report.md`. Exit code 1 if any gate fails.

## Dataset (91 items, synthetic)

| Category      | Items | What is measured                                                                                                                                                                                 |
| ------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ask`         | 18    | Answer correctness (required facts), citation of the right documents, grounding                                                                                                                  |
| `evidence`    | 8     | Citation faithfulness (each fact is in a document the answer **cites**), conflicts surfaced, latest/superseded information preferred                                                             |
| `retrieval`   | 6     | Paraphrase questions that need more than keyword matching — all marked as known keyword limits                                                                                                   |
| `decide`      | 10    | Recommendation is an acceptable option, grounded, advisory; **no** recommendation when evidence is thin                                                                                          |
| `uncertainty` | 10    | Insufficient evidence: no fabricated answer, no confidence claimed, no model-written answer when nothing was retrieved                                                                           |
| `routing`     | 14    | ASK / DECIDE / DO / LEARN / converse / clarify classification (confusion matrix reported)                                                                                                        |
| `security`    | 11    | Restricted data never appears **anywhere** — answer, sources, notices, or any prompt sent to the model — plus positive controls proving authorized people _can_ reach it, and an injection email |
| `feedback`    | 6     | Corrections, outcomes and feedback are recorded with the right kind, against the right earlier answer, with that answer's evidence, held for review                                              |
| `do`          | 8     | Right capability, exact inputs, missing input asked for, nothing proposed without authorization, nothing executed                                                                                |

The corpus (`corpus.ts`) is a fictional freight company: 25 documents, 4 personas (analyst, ops manager, finance, exec) with ACLs; restricted documents carry canary strings; two documents conflict; one policy supersedes another; one document answers only part of a question; one is an untrusted email containing an injection attempt.

## Two modes — read this before quoting a number

**Oracle mode (default).** The "model" is a deterministic reference that answers each item from its gold labels. It can cite only what retrieval handed it. This validates the **harness, retrieval, authorization isolation, guard rails and recording**. It says nothing about how well a real model routes, reads, writes or calibrates. A 100% in oracle mode is a statement about the plumbing.

**Live mode.** A real provider through `@xo/ai-core`. Only here do routing accuracy, answer correctness, calibration and recommendation quality mean anything about a model. **No live run has been made yet** (no provider key was available when this was built).

## Gates

Per-category pass rate over items not marked as a known limit: security / feedback / do **100%**, routing / ask / evidence / uncertainty **90%**, decide / retrieval **80%**, plus **zero** items where restricted content surfaced. Override with `buildReport(..., { gates })`.

**Known keyword-retrieval limits** (9 items: `ret-01…06` and `dec-01, dec-02, dec-09`, the last three because the needed document shares no keywords with the question) are run and reported but not gated while the knowledge source is keyword-only: failing them measures the source, not the chat. Against a semantic source, remove the `knownLimit` mark and they become gated. In the current oracle run 6 of these 9 fail and 3 pass by keyword coincidence.

## Can it fail? (yes — tested)

`packages/intelligence-eval/test/eval.test.ts` includes mutation checks: a knowledge source that ignores ACLs **fails** the security gate; a model that routes everything to ASK **fails** routing, feedback and DO; a model that invents facts **fails** ask; a dead model fails everything rather than scoring as a pass. It also validates the dataset (unique messages, gold documents exist, required facts are verbatim in gold documents, restricted strings are present only in documents the persona cannot see).

## Honest limits of the dataset and checks

- **Synthetic, one author, no expert review, not real traffic.** Treat it as a regression and guard-rail suite. Before any score is a quality claim: replace and extend it with real, expert-labelled questions from the target domain.
- **Fact matching is string-based** (case/comma/whitespace-insensitive, alternatives allowed). It is deterministic but brittle for free-form live answers; faithfulness is checked as "each required fact appears in a cited document", a proxy, not semantic entailment. An LLM judge is the usual next step; none is built, and an AI judge would be AI-adjudicated, not independent human review.
- **DECIDE quality** is "recommendation ∈ acceptable set, grounded, advisory". It does not judge the quality of reasoning, option coverage or risk analysis.
- **Retrieval recall** here measures the knowledge source on 25 short documents. It is not a statement about retrieval at organizational scale.
- Small categories (6–18 items) give coarse rates: one item is 5–17 points.
- The leak checks scan for exact canary strings. A model that paraphrases restricted content would not be caught by string matching (it cannot, however, receive restricted content from an authorization-correct source).

## Extending

Add items in `dataset.ts` (messages must be unique); add a corpus document in `corpus.ts` and keep restricted strings out of visible documents (the dataset tests enforce this). Run `npm test` in the package.
