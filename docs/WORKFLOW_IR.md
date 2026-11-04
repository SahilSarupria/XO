# Workflow IR 1.0

The portable execution contract between compiled expertise, runtime decisions, external actions, approvals, recovery and audit.
A workflow is **data** in the signed XO component `workflows` (`workflows/workflows.json`), covered by the manifest hash and Merkle root
like every other component. Any conforming runtime loads the same bytes and executes them under the same semantics.

- Types: `packages/workflow-ir/src/types.ts` · Published JSON Schema: `packages/workflow-ir/schema/workflow-1.0.schema.json`
  (generated from code; a test fails if the file drifts) · Conformance vectors: `packages/workflow-ir/conformance/semantics-vectors-1.0.json`
- Reference example: `freightClaimWorkflowIr()` in `@xo/ab-eval` (validated against the gold XO's decision tree in tests).
- Status: format, validator, semantics helpers, negotiation and pure `decide` evaluation are implemented and tested.
  The **runner** (durable execution, connectors, approvals) is sections B–D and is **not built yet**. Nothing here has been measured on real traffic.

## What a document contains

`{ formatVersion, semanticsVersion, connectors[], workflows[] }`. `connectors` is the connector manifest: logical ids, a closed `kind`
(`http|webhook_out|file|smtp|slack_webhook|database|mcp`), and each operation's declared side-effect class (`read|write|irreversible`) and
secret **names** (never values). A host operator grants or denies these in local policy; an act step on an ungranted operation is refused.

A workflow has triggers (`webhook, cron, directory, batch_file, mcp_event, api`), typed inputs, a step graph, optional bounded `forEach`,
`result` bindings, `maxConcurrency`, `runTimeoutMs`, a `cancellation` policy, optional `authority.ceilings`, and `requiresFeatures`.

Step types: `extract` (free text to facts; model allowed; `structuredFirst` bypasses the model when structured input is supplied; optional
`quote_required` grounding), `decide` (`tree | rules | formula | lookup`; never a model), `act` (typed connector call), `approve`
(human gate; no auto-approve value exists), `branch`, `wait` (timer, external event, approval), `compensate` (undo action), `escalate`.
Every step declares `determinism` (`deterministic|model_assisted|human`), `timeoutMs`, optional `retry`, `onError` (`fail|escalate|compensate`).

## Validation (fail closed, at load time)

Structure comes from the published schema (`additionalProperties: false` everywhere: unknown fields are refused, there are no vendor
extension points in 1.0). Then, among others: unknown step types; undeclared connector or operation; step side-effect class not matching the
manifest (no laundering a write as a read); side-effecting step without `idempotencyKey`; constant keys; keys on steps where they mean
nothing; cycles; reads of steps not transitively needed; reads of possibly-skipped steps unless `optional`; expressions outside the closed
language or reading undeclared names; declared determinism not equal to the step type's intrinsic class; `requiresFeatures` not covering
features used; secrets, absolute paths, `file://` or endpoint URLs embedded in the document; compensation wiring errors.
**Idempotency keys are required exactly for side-effecting steps** (`act`/`compensate` with `write` or `irreversible`). Approval identity is not
authored: it is derived (`approvalIdentity`, SHA-256 over workflow, version, step, run, item index) so one approval can never satisfy another.
The loader (`loadWorkflowComponent`, `workflowsFromLayer`) throws `WorkflowLoadError` on any error; a host never gets a partial component.

## Graph semantics (normative; `semantics.ts` is the executable form)

1. The step graph is acyclic. Bounded repetition exists only as `retry` and `forEach` (`maxItems`, `concurrency`), each item an independent instance
   with `run.index` and `item.*`.
2. **Data dependencies**: a step reads only declared outputs of steps in its transitive `needs`. A binding is `from` a reference (`input.x`, `run.id`,
   `run.index`, `item.x`, `steps.<id>.<out>`) or a `const`.
3. **Concurrency**: a step is READY when all `needs` are `succeeded` or `skipped`. READY steps start in document order, at most `maxConcurrency` running.
4. **runIf**: evaluated over the step's own resolved inputs; falsy means `skipped`. Reading a skipped step's output is an error unless `optional`.
5. **States**: step `pending, ready, running, waiting, succeeded, failed, skipped, cancelled, timed_out, compensated`; run `created, running, waiting,
completed, failed, escalated, cancelled, compensating, compensated`. Only transitions in the tables in `semantics.ts` are legal.
6. **Failure**: after retries, `onError` applies. `fail`: run `failed`. `escalate`: run `escalated` (a person takes the case). `compensate`: completed
   steps with `compensatedBy` run their compensation in reverse completion order; a missing or failed compensation escalates.
   **Irreversible steps cannot be undone**; a compensation declared for one is a best-effort semantic reversal and the validator warns.
7. **Cancellation** follows `cancellation.onCancel` (`compensate` or `abandon`); in-flight steps are cancelled cooperatively.
8. **Timeouts**: every step has one. Approval and wait timeouts escalate; nothing times out into a decision.
9. **Determinism of decisions**: `decide` is pure (no clock, randomness, I/O, model). Numbers are IEEE-754 binary64. For tree steps a `null`
   input means "not stated" and is passed as an absent fact. Any `decide` failure (`missing_fact, no_match, lookup_miss, invalid_input,
invalid_output, eval_error, tree_unavailable`) means **escalate**, never a default.
10. **Idempotency**: the rendered key plus workflow id and step id are hashed into the external key (`externalIdempotencyKey`), stable across runners
    and across workflow versions. Guarantees and non-guarantees are in the runner docs (section C/F), not here.

## Portability

No code in documents; no host paths (triggers and file operations use logical `source` ids bound by host policy); no provider or model names
in deterministic steps (extract steps request abstract capabilities only); explicit connector declarations; versioned semantics;
`negotiateWorkflows(component, hostSupport)` returns runnable and refused workflows with reasons. A workflow needing something the host lacks is
refused whole, never run with part dropped. Identical valid inputs and workflow version must give identical decide results: the vectors in
`conformance/` are the test another runtime must pass. Compatibility level: `workflows` counts as L3 (SPECIFICATION.md §2.2); a manifest family entry that does not list it skips it.

## Not covered yet

Runner, connectors, run store, approvals, shadow mode, `xo` CLI commands for workflows, SDK/HTTP API are documented in `WORKFLOW_RUNTIME.md`. The compiler emits workflows from policy documents (next section); it does not yet emit them from sources other than policy text.

## Loading several XOs together (`linkWorkflowComponents`, `xo flow link`)

Workflows from more than one XO can be loaded side by side under a declared `PrecedencePolicy` (`order`: XO ids, highest first). Identical definitions (same workflow or connector in two
XOs) are reported as overlaps and deduplicated. A **differing** definition is a conflict resolved only by precedence; an XO not in the order cannot win. Two workflows claiming the same
webhook route or watched-directory source are also conflicts. Anything the policy cannot decide is **blocked and reported** (exit code 2 from the CLI) and never merged or guessed; a workflow that
depends on a blocked connector is blocked too. The merged component is re-validated in tests. Scope limits: this links the **workflow component only**. It does not link the knowledge graphs,
decision trees, safety rules or memory of the packages (the compiler-side linker in `EXPERIENCE_COMPILER.md` §5 is a separate, unbuilt piece), it does not rename colliding workflows, and
decision-tree ids referenced by workflows from different XOs are not cross-checked for collisions. Unmeasured.

## Compiling policy documents into workflows (`xo create`, `packages/compiler/src/policy/workflow-emit.ts`)

`xo create <policy.md> --sign` lowers the **same** program, decision tree and review data the `decision_trees` component comes from into a
`workflows/workflows.json` component, validates it with `validateWorkflowComponent` and `validateAgainstBundle` against exactly the tree it ships
with, and packages it (not required, hashed, signed, loaded as L3 like any component). Nothing re-reads the document, so the two cannot drift.

Two workflows are emitted per policy, because a runner refuses any workflow containing an `extract` step when it has no model (negotiation, not
a choice made here):

- `<id>_structured`: facts arrive as typed inputs; no model step. Negotiation against the model-free reference host confirms it runs with no model.
- `<id>_from_text`: adds the single grounded, model-assisted `extract_facts` step (`quote_required`). Refused on a runner with no extractor.

Steps: `extract_facts` (text only) -> `decide_case` (the compiled tree) -> `route` -> `record_fields` (formula) -> `record_decision` (idempotent
`write_record`) -> `escalate_to_human`. Every step that carries content from the document has `provenance` (rule tag or section plus the source
sentence, clipped to the schema's limits).

**What is and is not decided automatically.**

- A rule the compiler did not recognize has no step. Every path that reaches it ends in the tree's `UNFORMALIZED_RULE` escalation, and the sentence is
  listed as a review item with its reason. Sentences that read as granting discretion are reported as `judgement_call` (a keyword heuristic that a
  reviewer should confirm; it never decides anything).
- **Approvals are held while any decision sentence is unreviewed.** An approving outcome ("Otherwise the request is approved", "If X, ... is
  approved", "The desk pays the <quantity>") is recognized, but while review items are open it is turned into an escalation with reason code
  `APPROVAL_HELD_UNREVIEWED_RULES`: an approval would otherwise silently ignore rules the compiler did not understand. Resolving every review item
  releases the hold. A reviewer rules on sentences in a JSON file passed as `xo create ... --review-ledger rulings.json`:
  `{"accepted": [{"sentence": "...", "proposal": <ClauseProposal>}], "rejected": [{"sentence": "...", "note": "guidance, not a rule"}]}`
  (proposals are re-checked by the compiler; a ruling for a sentence not in the document is inert and cannot release a hold).
- An approving step is always evaluated **after** every deny/escalate rule, wherever the document states it, so an approval never pre-empts a refusal.
- The approval patterns abstain (leave the sentence unrecognized) when the sentence is negated or qualified ("never", "not", "unless", "only",
  "and", "or", digits, "may", ...), and when the document defines case kinds but the sentence carries no scope. They do not guess.
- Today's extractor recognizes only a small set of sentence shapes, so most real manuals will still have review items and therefore held approvals
  until a reviewer works through them. That is the intended, fail-closed behaviour, not a bug.

**Where decisions go (`--decision-sink`).** The policy names no external system, so the sink is the operator's choice, never inferred:
`file` (default) records each non-escalated decision through a `file` connector the operator binds (`decisions/<route>/<case_id>.json`,
content `decision=...;reason_code=...;amount=...;case_id=...`; policy-computed fields come first and the caller-supplied `case_id` is last so it
cannot forge an earlier field); `none` emits no connector and no action, and the decision is the run result for the host to act on. Slack,
webhook-out and database sinks arrive with those connectors (not built). Not yet constrained: `case_id` is free text (IR 1.0 has no `pattern`
constraint); the file connector refuses `..`, absolute and empty path segments, but other characters pass.

**The compile-time report** (`--workflow-report <file>` writes JSON, and a summary is printed): per workflow and per capability the counts of
deterministic / model-assisted / human steps and their ratio; for every non-deterministic step its exact cause (`free_text_input`,
`documented_escalation`, `unrecognized_rule`, `judgement_call`) with provenance; the review items; held approvals; and a `limits` list. Every
figure is labelled **declared, not measured**: it counts declared step classes and recognized sentences and says nothing about accuracy, real-case
coverage, cost or savings. Ratios are dominated by the fixed step structure (a short workflow with one human step cannot exceed ~0.8).

**Credentials in source text.** Quoted policy sentences are scrubbed with the validator's own secret test (`looksLikeSecret`) before they reach the
component or the report. Other components (decision tree notes, knowledge graph) carry source sentences too and are **not** scrubbed by this change.
