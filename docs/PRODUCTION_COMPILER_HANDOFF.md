# Production compiler — handoff for a new Claude chat

Goal of the next chat: take the XO compiler from "promising prototype" to a compiler that turns a real policy/procedure
document (PDF, DOCX, markdown) into a signed, portable XO that runs deterministic workflows — **and that asks the owner
when it cannot work something out instead of guessing**, with or without a language model.

Read this file first, then `docs/DETACHABLE_INTELLIGENCE_LAYER.md` (measured status), `docs/ROADMAP.md`, and the five
project docs (`SPECIFICATION.md`, `EXPERIENCE_COMPILER.md`, `XO_PROTOCOL.md`, `PACKAGE_README.md`,
`claude/P10_M7_GO_NO_GO_ASSESSMENT.md`).

## 1. Where things stand (measured, offline; branch `feat/detachable-layer-b-f`, PR #12)

| area                                              | state                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy synthesis (`packages/compiler/src/policy`) | Domain-neutral: a policy program (facts, ordered gates/assigns/finishes, tables, invariants) built from the document's own words; no industry vocabulary in code. Wired into `compileSources` and `xo create`.                                                                           |
| Unaided understanding                             | **Weak on unfamiliar manuals.** Held-out insurance manual: 5 of 18 rule sentences understood, 7 % of cases agree with the oracle. Everything not understood fails closed (escalates). Dev manual (expense): 7 of 13. Freight (built against): 34 of 34.                                  |
| After human review                                | Insurance 100 % agreement, 0 confident-wrong — but the same author wrote manual, oracle and review decisions.                                                                                                                                                                            |
| Model-assisted extraction                         | `model-extract.ts`: model proposes one rule per unrecognised sentence; accepted only if the quote is verbatim, every number is in the quote, expressions parse over declared facts, and the tree gets no worse. **Never run against a real model.**                                      |
| Clarification engine                              | `clarify.ts`: deterministic plain-English questions (unrecognised sentence, undefined quantity, awkward name, missing target, conflicting rules, no default outcome, calendar-vs-business days) and `applyAnswers` through the same checks. `xo compile-review <manual.md>` prints them. |
| Input binding                                     | `input-contract.ts`: contract per input + operator-owned declarative field mapping (no code), `bindWithMapping` never guesses; unmapped input ⇒ missing fact ⇒ escalate. The ab-eval word-overlap binder is still a proxy for the _live_ arms.                                           |
| Versioning                                        | `version.ts`: diff of two compiled programs (changed numbers, changed targets, removed rules), stale-ruling detection → re-confirmation questions.                                                                                                                                       |
| Operating numbers                                 | `telemetry.ts`: timed compile, metered model (calls, failures, estimated tokens, cost only if prices given), quality report; corpus regression suite `packages/compiler/test/corpus` with stored baselines.                                                                              |
| Tests                                             | compiler 934, ab-eval 84, cli 298, api 331 pass; lint clean.                                                                                                                                                                                                                             |

### Known gaps (what is NOT done)

1. No live-model evidence: model-assisted extraction and the compiled-vs-gold **uplift ratio** (target ≥ 0.8) unmeasured.
2. Only three realistic manuals, all written by the previous assistant (freight, insurance, expense) plus a vendor-invoice demo.
3. Real PDFs: stream filters decode (ASCII85/Hex/RunLength/LZW) but scanned PDFs (no OCR), multi-column layouts,
   nested/merged-cell tables, headers/footers, amendments/revision marks and contradictory rules are **unproven**. The
   original failing real PDF (Aastha health-claims SOP) was never re-run after the fixes.
4. The extractor recognises a fixed set of sentence shapes (~20). New phrasing mostly goes to review.
5. No reviewer service/UI (backend API only; **no frontend work until the owner says so**).
6. Two benchmark baselines (`aastha-operations`, `commercial-property-policy` workflows output) changed because
   composition now splits by section; **refresh needs the owner's decision** per `packages/benchmark/BASELINE_PROTOCOL.md`. Do not refresh silently.
7. No latency/cost data on large documents; no compile-quality monitoring across customer documents.
8. "Any PDF" is not a literal target. Honest scope: **policy and procedure documents that state decision rules.** Pure
   narrative, images-only scans without OCR, and legal prose with cross-references are out of scope until stated otherwise.

## 2. What the owner must supply (the new chat cannot invent these)

1. **Real documents** — 10–20 policy/SOP PDFs (sanitised), from at least 4 industries, _written by people who never saw
   this compiler_. Include: scanned ones, multi-column ones, ones with tables, one with amendments, one that contradicts itself.
   Put them in a private folder; never in this repo if confidential. Split them: ~half **development**, ~half **held-out
   (never looked at until the final measurement)**.
2. **Reviewers who are not the assistant** — at least two people who own those policies and can answer the compiler's
   questions. For each held-out document: their answers, recorded, plus 20–50 real or realistic cases with the
   _correct_ decision written by them (this is the oracle; it must not come from compiler output).
3. **API access, operator-side only** — a model key set as an environment variable on the machine that runs evals
   (`XO_AI_*` operator config; there are no key flags). **Never paste a key into chat.** A key that was pasted earlier
   in this project must be revoked. Say which provider/model to use and a spend cap.
4. **Decisions**: refresh the two stale benchmark baselines? (yes/no); is the compile target "assisted" (a person answers
   questions) or "unattended with escalation"? default below assumes assisted; which industries first; hosting/privacy limits for customer documents sent to a model.
5. **A design partner (optional but decisive)** — one customer who will run shadow mode and tell you how often XO agrees with their staff.

## 3. How to start the new chat

1. Open a new Claude Code chat attached to the project **XO** (it carries the five project docs).
2. Attach the repo `SahilSarupria/XO` on branch `feat/detachable-layer-b-f` (or `main` once PR #12 merges).
3. Give it this file, the private document folder (or tell it where it is on your machine if linked), and your answers to section 2.
4. Paste the prompt below.

## 4. Acceptance criteria (measured, written before building)

The compiler is "production quality" for the stated scope when ALL hold on the **held-out** documents:

| criterion                                                      | bar                                                                                                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rules understood or asked                                      | 100 % of rule sentences are either compiled with a source quote **or** turned into a question; none silently dropped                                        |
| Confident-wrong decisions                                      | 0 on the held-out cases (a wrong approve/deny from a rule the compiler or reviewer got wrong counts; escalation does not)                                   |
| Agreement with the owner's oracle after ≤ N answered questions | ≥ 95 %, N reported (target ≤ 15 questions per 10 pages)                                                                                                     |
| Unaided understanding (no model, no human)                     | reported honestly per document; no bar, but it must not regress vs the stored corpus baseline                                                               |
| Model-assisted understanding (real model, checks on)           | reported per model; accepted proposals must pass the deterministic checks 100 % of the time                                                                 |
| Uplift ratio vs hand-written gold XO                           | ≥ 0.8 on freight and insurance (needs key)                                                                                                                  |
| Real-PDF robustness                                            | every held-out PDF either compiles or returns a specific, actionable error ("scanned, needs OCR", "table unreadable on page 4"); no crash, no empty success |
| Questions are good                                             | in a blind read, reviewers rate ≥ 90 % of questions as clear and necessary; the same fact is never asked twice                                              |
| Operating                                                      | p95 compile < 60 s for a 50-page document without a model; model cost per document reported; corpus regression suite green in CI                            |
| Provenance                                                     | every compiled rule links to the exact source sentence (and page) it came from; an owner can open any rule and see it                                       |

## 5. Rules of engagement (carry these over)

- Every claim must be MEASURED. Never present simulated or tuned-on-eval numbers as results. Report negative results plainly.
- **Never tune on held-out documents.** Develop on the development half; run held-out once per milestone; if a held-out failure is fixed, move that document to development and get a fresh one.
- Fail closed: a rule not understood escalates; an unmapped input is a missing fact; a stale human ruling is not applied until re-confirmed.
- No frontend work. No new API keys pasted in chat. No live evals without a stated spend cap. Feature branches only; never force-push or push to `main`; keep tests/lint/build green; never bypass the pre-commit hook.
- Benchmark baselines change only through the explicit refresh procedure, with the owner's approval.
- Ask before spending beyond a small pilot (`--limit 10` first).

## 6. Suggested work order for the new chat

1. **Real-PDF intake**: run the development PDFs through `xo create`; list every failure class; add OCR (or a clear "needs OCR" error), multi-column ordering, header/footer stripping, merged-cell tables, revision marks. Re-run the Aastha SOP.
2. **Question quality**: extend `clarify.ts` — contradictions across sections, "may/should" vs "must", exceptions and precedence ("unless", "except"), inclusive vs exclusive thresholds (> vs ≥), effective dates and superseded clauses, defined terms, cross-references ("see section 4"), currency/units. Dedupe questions; order by blocking impact; group by section.
3. **Live model-assisted extraction** (with spend cap): evaluate on the development set first; log acceptance rate, rejection reasons, cost (`meteredModel`); improve the prompt; add few-shot examples taken from accepted reviewer answers.
4. **Reviewer service (backend)**: persist a review session per manual revision (questions, answers, who/when, signed), expose it over the existing server (`xo serve`), reuse `applyAnswers`, `ledgerStatus`, `diffPrograms`. UI later, by decision.
5. **Run-time binding**: connect `FieldMapping` to real connectors; add text extraction with `checkGrounding` for inputs read from case text; mapping questions via `mappingQuestions`.
6. **Measure**: held-out run per section 4; fill the acceptance table; write it into `docs/DETACHABLE_INTELLIGENCE_LAYER.md`.
7. **Operate**: corpus baselines from real documents, CI job, latency/cost dashboards from `measureCompile`, drift alerts via `compareQuality`.

## 7. Paste this into the new chat

> You are continuing work on XO (github.com/SahilSarupria/XO, branch `feat/detachable-layer-b-f`, PR #12), attached to the Project "XO". Read `docs/PRODUCTION_COMPILER_HANDOFF.md` first, then `docs/DETACHABLE_INTELLIGENCE_LAYER.md` and `docs/ROADMAP.md`. Your job: make the compiler production quality for policy/procedure documents, meeting the acceptance table in section 4 of the handoff, working in the order in section 6 and obeying section 5. The compiler must not just compile: whenever it cannot work something out (a sentence it does not understand, a name or amount the document never defines, a missing outcome, contradictory rules, an ambiguous unit or threshold, an input with no source in the customer's systems) it must ask the owner a plain-English question that quotes the document, apply the answer only through the existing deterministic checks, and never guess — with or without a language model. Start by (1) running the full test suite and `xo compile-review` on the corpus in `packages/compiler/test/corpus` to confirm the baseline, (2) telling me exactly which of the items in section 2 you still need from me, and (3) proposing a milestone plan with the measurable exit criteria for each milestone before building. Report every result — including failures — with the numbers, separate development from held-out, and ask me before any model spend beyond a small pilot or any benchmark-baseline refresh.
