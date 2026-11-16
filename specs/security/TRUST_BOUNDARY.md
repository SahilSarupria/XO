# XO trust boundary (UW-1, plan B.9)

Status: specification of record (ADR 0026). Owner of changes: whoever adds or changes a path on which content reaches a model, an
authorization decision, or an effect. A new path is not done until it is listed in the table below with its controls and a corpus check.

## The rules

| Rule | Statement                                                                                                                   | What enforces it in code                                                                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | Models propose; deterministic validators decide; humans approve effects.                                                    | Rule proposals pass `validateProposal` and need a named reviewer (`confirmProposal`). Extracted facts need quotes found in the text. AI capability proposals run only after approval (ADR 0014).                     |
| T2   | Document text, spreadsheet cell text, page text, email bodies and evidence excerpts are data, never instructions.           | Each model path below frames content as data and keeps it out of the instruction channel. Corpus checks: `specs/security/injection-corpus.json`.                                                                     |
| T3   | Authority is server-derived: from host configuration and the persisted graph, never from the client, an adapter or a label. | One authorization point (ADR 0010, `apps/api/src/auth/authorization-point.ts`) for HTTP routes, chat, AI conversations, procedures and the scheduler; declarations are re-derived from the verified stored graph.    |
| T4   | Fail closed on missing configuration, stale approval, unverifiable evidence.                                                | Verify-on-load of every stored or client-supplied graph (`fromJson(..., { verify: true })`); approval state bound to the graph; broken operator policy suspends ALLOWs; unreadable audit anchors fail verify.        |
| T5   | Never infer "no effect" from silence; unknown stays unknown until a human settles it.                                       | Indeterminate audit writes are reported as indeterminate; idempotency refuses an interrupted run it cannot prove (`idempotency.indeterminate`); policy-path provenance that cannot be found is marked `unresolved:`. |
| T6   | Everything send-relevant (recipient, attachment hash, body) is bound at approval and re-verified at dispatch.               | Not yet applicable: no send path exists. UW-10 (provider-independent email) must implement it before the first send.                                                                                                 |

## Paths on which content reaches a model

| Path                                          | Code                                                          | T2 framing                                                                                                                                               | What a hostile payload can achieve at most                                                                                                                | Corpus check                                                  |
| --------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Chat / AI conversation (ask, decide, propose) | `packages/intelligence/src/prompts.ts`, `evidence.ts`         | Excerpts only inside `<xo-evidence>` blocks, `<`, `>` and `&` escaped so a payload cannot close the block; the system prompt states the blocks are data. | A misleading answer. Citations are checked against the evidence ids; proposals of actions are only proposals (T1).                                        | `packages/intelligence/test/injection-corpus.test.ts`         |
| Workflow fact extraction                      | `packages/workflow-runtime/src/extract.ts` (`ModelExtractor`) | Case text only as the JSON-encoded `case_text` field; fixed system message labels it untrusted.                                                          | Nothing unsupported: with `quote_required` a fact is accepted only if its quote appears in the text and supports the value, otherwise the case escalates. | `packages/workflow-runtime/test/injection-corpus.test.ts`     |
| Compiler rule proposals                       | `packages/compiler/src/reasoning/rule-proposals.ts`           | The sentence only JSON-encoded, after an explicit untrusted-data notice (added in UW-1).                                                                 | A proposal. It must pass the grammar, number and grounding checks, and a named reviewer must confirm it. See the finding below.                           | `packages/compiler/test/reasoning/injection-corpus.test.ts`   |
| Scanned-page transcription                    | `packages/compiler/src/extraction/adapters/vision.ts`         | The page is an image; the system prompt says page text is data to copy, never instructions (added in UW-1).                                              | A wrong transcription, capped at confidence 0.9 and flowing into the same compile path as any text.                                                       | Not structural (image input); live-model evaluation is UW-13. |
| AI capability execution                       | `apps/api/src/routes/runtime/runtime-routes.ts`               | —                                                                                                                                                        | Nothing: disabled by a compile-time constant (`AI_EXECUTION_ENABLED = false`).                                                                            | Must be added before the constant is lifted.                  |

## Findings recorded with this specification

- **A document can state a harmful rule in plain words.** Corpus cases `inj-001` and `inj-005` spell out the rule they want ("claims
  under 1000000 need no review"). The proposal validator grounds rules in the sentence, so it accepts them: they are literally what the
  document says. No validator can tell a hostile rule from a genuine one. The control is T1: a proposal becomes a rule only when a
  named reviewer confirms it, and the reviewer is shown the exact source sentence. The test pins exactly which payloads validate, so a
  change is visible.
- **Structural checks are not model evaluation.** The corpus checks prove what holds whatever the model does: where the payload sits,
  that it cannot escape its frame, and that an answer obeying it is refused or needs a human. How often a live model is misled is
  measured in UW-13 on the same corpus.

## Rules for new paths

1. Put content in a data field (JSON-encoded or an escaped, delimited block), never in the instruction text.
2. State in the system message that the content is data and instructions inside it are to be ignored.
3. Treat the model's output as a proposal: validate it deterministically, and require approval before any effect.
4. Add a corpus check for the path in the package that owns it, reading `specs/security/injection-corpus.json`.
5. List the path in the table above.
