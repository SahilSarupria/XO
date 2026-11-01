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

Runner, connectors, run store, approvals, shadow mode, determinism analysis in the compiler, `xo` CLI commands for workflows, SDK/HTTP API.
