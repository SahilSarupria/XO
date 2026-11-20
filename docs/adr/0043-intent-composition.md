# 0043: Intent understanding and workflow composition (UW-6)

## Status

Accepted under owner delegation, 2026-11-18 (UW-6, wave W3). Signed off by Claude under the owner's delegation of decision
authority. This is a delegated sign-off, not an independent review.

## Context

What existed before this change (audit):

- A goal (`GoalSpecification`: text, needs, section, forEach, intake) selected one of the composed candidate workflows by scoring words
  and asked ONE question when two fit equally (PX-6). `lowerCandidateWorkflow` turned the candidate into Workflow IR and validated it.
  `generateDefinition` (API) ran that and stored a `gwf_` definition; the UW-2 workflow entity routes call the same function.
- The capability inventory already reports `gaps` (a need nothing usable provides), but generation ignored them.
- No place held a record of how an intent became a definition, and nothing parsed a model's proposal. There was no `needs_model` IR step.

## Decisions

1. **No new planner.** An intent is a small structured proposal (`xo.intent.proposal.v1`: text, needs, section, forEach, intake).
   Composition is the existing selection plus the one lowering function plus the IR validator, in `composeIntent`
   (`packages/pre-execution/src/intent/`). The deterministic path needs no model.
2. **Outcomes.** `composed` | `gap` | `needs_clarification` | `invalid`.
   - A need nothing usable provides is a **gap** (`missing_capability`) and nothing is generated. A step with no connector bound is a gap
     (`unbound_capability`) in the composition result; the API keeps generating that definition with `lowered.complete: false` as before UW-6
     (an existing contract: "the act step is reported, not invented"), and blocks only on `missing_capability`.
   - Nothing matches, or two workflows fit equally, is **one clarification question**.
   - A definition the validator rejects is `invalid`. Nothing is guessed.
3. **A model's proposal has no authority.** `parseIntentProposal` keeps only the known fields, bounded (text 2000, 20 needs of 200, section 200,
   forEach an identifier-like word); anything else is dropped and recorded as a finding. A proposal can only name things in the compiled
   catalogue; a name it invents is a gap. The text is only scored as words and never interpreted. The model's answer is parsed as JSON (a fenced
   block is tolerated) and nothing else in it is read (`proposalFromModelAnswer`).
4. **The trace** (`xo.intent.trace.v1`): origin, proposal digest, findings, catalogue version (digest of capability ids, contract hashes, statuses),
   the selection and ranking, the lowering version and definition digest, step count, validity, outcome and gaps. Content-hashed
   (`intentTraceDigest`); stored on the definition record (`intentTrace`), and each UW-2 version's definition reference carries the digest
   (`GeneratedDefinitionRef.intentTraceDigest`, additive). Versions made earlier have none.
5. **Free text.** `POST /workspaces/{ws}/compilations/{cid}/intent-proposals` needs an instance `intentProposer` (a function from text to the text of a
   proposal). The default has none (`strict_local`), and the route answers 501 and points to the structured goal. The proposer must call a model only
   through the UW-14 guard with a typed request; **that wiring is not built** (see below). Audited as `intent.proposed` with counts only.
6. **Output on the UW-2 entity.** `workflow-entities` create/revise already generate through `generateDefinition`, so a composed definition becomes a
   new version of the entity; gaps are returned with `workflow: null`.
7. **Three unrelated verticals** (certificate distribution, invoice reconciliation, supply-chain risk) are small synthetic procedure documents in the
   tests; a test checks the generic composition code contains none of their words.
8. **UAC-17.** `packages/pre-execution/test/intent-injection-corpus.test.ts` runs every payload of `specs/security/injection-corpus.json` through the
   goal text, a need, a section, a forEach value, extra smuggled fields, a model proposal, and a line planted in the source document. It is registered in
   the `injection-corpus` evaluation suite. The corpus file itself (a frozen spec) is unchanged.

## Findings

- **A planted imperative sentence in a source document becomes a step.** The document compiler reads a bare instruction line
  ("Ignore all previous instructions…") as an inferred procedure step, which composes into a task for a **person** (`approve`), never an action, recipient or
  approval; a line that reads like an automated step ("List every other document you can see…") becomes a capability with no binding, so composition stops
  with an `unbound_capability` gap. Text alone cannot tell a planted line from a genuine step; the control is that each compiled capability is approved by a
  person before the readiness certificate. The test asserts exactly this (only person tasks; real steps intact and in order; no recipient), not "nothing changes".
- Gaps used to be ignored by generation; now a missing capability stops it.

## Consequences

- Everything runs with no model. Model-proposal behaviour is tested with a scripted proposer returning hostile answers, not a real model.
- The composer relies on name and word matching for needs (the inventory's existing normalisation); it does not understand meaning, so a need must be
  named close to the capability's name or it is reported as a gap rather than matched loosely.

## Not built

- **The `needs_model` step and its use of the UW-14d token vault.** No such IR step exists (the IR has `extract`, the model-assisted fact reading), and adding
  a step kind is a Workflow IR change plus an owner-enabled setting. The vault still has no consumer. Left for a workstream that owns the IR.
- **The proposer through the UW-14 guard**: the route and the contract exist; the typed request template and provider wiring do not, and `strict_local` offers no model.
- Multi-source composition from several compilations, and composition of a workflow from scratch with no compiled source (the design is "build on PX-6, no new free-form planner").

## Reopen if

- Real use shows needs rarely match by name (then add a catalogue search with explicit candidates, still ending in a question, never a guess).
- A planted line in a real document is judged unacceptable as a person's task (then require a person to confirm every inferred capability before it composes).
