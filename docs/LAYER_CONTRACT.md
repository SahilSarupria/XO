# Capability-layer contract (v1)

What a host application may rely on when it consumes an `.xo` package through `@xo/capability-layer`, what a package author
may rely on when producing one, and what may change without notice. The integrity, trust and fail-closed behaviours below are covered by tests in
`packages/capability-layer/test`; the retrieval and expression-language descriptions are documentation of current behaviour (unit-tested
in part, not exhaustively). The runnable reference is `examples/host-app-demo`.

## 1. Host-facing API (stable within contract major 1)

```ts
const layer = createCapabilityLayer(bundle, { host: { family, capabilities }, integrity?, trust?, signing?, now? });
layer.systemPromptFragments(): string[]
layer.toolDefinitions(): ProviderToolDefinition[]          // evaluate_decision_tree, lookup_knowledge (only when the package has them)
layer.executeTool(name, input): { isError, content }       // evaluate_decision_tree takes { facts, tree_id? }
layer.retrieve(query, k): GraphNode[]
layer.exemplars(taskType, k, query?): ReasoningTrace[]
layer.safetyGate({ input?, output? }): { allowed, violations, override? }
layer.emitLoadReceipt(): LoadReceipt                       // signed when `signing` is supplied
```

Guarantees:

- **Verified before use.** `createCapabilityLayer` throws `BundleIntegrityError` (and exposes nothing) if a component's bytes do not match
  its declared hash, a component is not declared in the manifest, or the manifest has no matching Merkle root. With `trust: PackageTrustPolicy`
  it also requires the signatures to satisfy the operator's policy. `integrity: 'allow-unsealed'` exists for hand-built test bundles only.
- **Skip, never error, on what the host cannot use.** Components the manifest does not list for the host's model family, or that need a
  capability the host lacks (decision trees need `tool_use`), are skipped and recorded in `LoadReceipt.skipped`.
- **Fails closed.** A decision tree never guesses: a missing fact returns `missing_facts`, an invalid fact returns `invalid_facts`, a malformed
  tree returns `tree_error`. A blocking safety rule with an `override_output` replaces the output; without one the output is disallowed.
- **Deterministic.** Retrieval, tree evaluation and the safety gate use no randomness, clock or network.
- **No code execution.** Trees and rules are data evaluated by a closed expression language (below). A package cannot run host code.

## 2. Package format the layer consumes

`manifest.formatVersion` is `"1.0"`. Components (by `kind`):

| kind                | file (conventional)             | shape                                                                                                           |
| ------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `knowledge_graph`   | `knowledge/graph.json`          | `{ nodes: [{ id, kind, pinned?, properties: { title?, text, keywords? } }], edges: [{ from, to, kind }] }`      |
| `decision_trees`    | `reasoning/decision_trees.json` | `{ trees: [{ id, description, inputs[], start, nodes{} }] }`; node types `branch`, `compute`, `leaf`            |
| `reasoning_traces`  | `reasoning/traces.jsonl`        | one JSON object per line: `{ id, task_type, scenario, steps[], conclusion, confidence, provenance }`            |
| `prompt_strategies` | `prompting/strategies.json`     | `{ persona, fragments: [{ id?, text, requires? }] }`                                                            |
| `workflows`         | `workflows/workflows.json`      | Workflow IR 1.0, see `docs/WORKFLOW_IR.md`. The layer verifies and hands over the bytes (`componentBytes`); `@xo/workflow-ir` parses them. Counts as L3 |
| `safety_rules`      | `safety/rules.json`             | `{ rules: [{ id, applies_to: 'input'\|'output', when, action: 'block'\|'warn', message?, override_output? }] }` |

Retrieval semantics: BM25 with multi-query reciprocal-rank fusion; `pinned: true` nodes are always returned first; node `kind` is a prior
(`rule` 2, `procedure` 2, `heuristic` 1.5, `constraint` 1.5, `background`/`glossary` 0.7); one-hop expansion along `applies_with`, `requires`,
`refines` edges. Unknown node kinds and edge kinds are accepted and treated neutrally.

### Expression language (closed)

Literals (numbers, `'strings'`, `true`/`false`/`null`), identifiers (facts and computed names), `+ - * / %`, comparisons, `&& || !`, ternary
`c ? a : b`, parentheses; functions `min max abs floor ceil round contains`. No property access, no indexing, no assignment, no calls
outside this table. Division by zero and unknown identifiers are errors. `&&`/`||` short-circuit, so a fact on an unreached branch is never required.

## 3. Versioning policy

- **Contract version** is the major number of this document and of `@xo/capability-layer`. Within a major:
  - _additive only_: new optional manifest fields, new component kinds (skipped by older hosts), new node/edge kinds, new expression functions
    (an older host rejects a tree that uses one — fail closed, `tree_error` — rather than mis-evaluating it), new `LayerOptions`.
  - _never_: renaming or removing a documented method, changing the meaning of an existing field, loosening a fail-closed behaviour.
- **Package format** (`manifest.formatVersion`) is versioned independently. A host refuses a package whose `formatVersion` major it does not know.
- **Breaking changes** bump the major, ship with a migration note, and keep the previous major's reader for one release.
- Release mechanics (changesets, publishing) are in `docs/VERSIONING.md`.

## 4. What is NOT promised

- Retrieval _ranking_ (scores, tie-breaks, the exact prior values) may be tuned in minor releases; the behaviours listed in §2 are the contract, the numbers are not.
- Wording of error messages. Match on error classes (`BundleIntegrityError`) and the `error` codes in tool results.
- `weightsPatch()` always returns `null` (no weight-level compatibility in this build).
- Anything exported from a deep path or marked internal.

## 5. Open items (known gaps against this contract)

- The interactive TUI still has its own provider flags; only `xo run`, `xo ask`, `xo ab-eval` and `xo desk` are operator-config only.
- Package-format migrations (`manifest-migration`) are covered for manifests; component-format migrations are not yet specified.

## Fact grounding (opt-in: `createCapabilityLayer(bundle, { requireEvidence: true })`)

Measured finding (gemini-3.1-flash-lite, 10 abstain tasks): when a needed fact was absent from the claim, the model invented `damage_pct: 100` in 10/10 tool calls and the tree computed a payout from it.
With `requireEvidence`, `evaluate_decision_tree` requires `evidence: { fact: { quote, derived? } }`. `XoExecutor` refuses the call (`UNGROUNDED_FACTS`) when a fact has no quote, the quote is not verbatim in the case text, or a numeric value is not a number in its quote (unless `derived`).
Rev 2 (after the live abstain run showed the model re-sending an invented value as `derived` with an unrelated quote): `derived` counts only for inputs the tree marks `derivable` (day counts, hours) and is checked against the dates in the quotes; classification enums need no quote; quotes are compared ignoring punctuation; a zero is accepted from any verbatim absence statement.
Limits: it makes invention visible, not impossible. A model can quote real text it misreads, or mark an invented value `derived` with an unrelated quote. Whether it fixes abstention on a real model is **unmeasured** until `xo_tools_grounded` is run live.

## Deterministic classification of free-text inputs (E6)

Finding (seed 9001, gemini-3.1-flash-lite): all five `xo_tools` misses were the model classifying goods into `commodity_class` — lithium batteries not called hazmat (claim denied instead of escalated to Hazmat Compliance), the class left out, dry goods called temperature-sensitive (claim paid). The tree was right; its input was wrong.

A tree input may carry `classification: { entries, highRisk, onConflict }`. Before a model-supplied value is trusted, `XoExecutor` looks the case text up in the glossary (whole words, case-insensitive, plural tolerated) and reconciles:

| lookup vs model                                                       | result                                                                                                         |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| no glossary match                                                     | model's value used, reported in `model_assisted_fields`                                                        |
| agree                                                                 | proceed                                                                                                        |
| model gave nothing, one class matched                                 | glossary value used                                                                                            |
| matched a **high-risk** class, model said otherwise                   | high-risk class applied, so the tree's own rule escalates (hazmat → Hazmat Compliance); both values in `trace` |
| model said a high-risk class, glossary said another                   | the cautious (model) value kept, disagreement noted                                                            |
| glossary disagrees on a normal class, or text matches several classes | escalated to `onConflict.target` with reason `CLASSIFICATION_CONFLICT`, nothing paid, both values in `trace`   |

Entries carry an origin: `manual` (a definitional sentence of the compiled document, with the sentence as evidence) or `operator` (the customer's own glossary, e.g. a TMS class table). The compiler's review report (`policy.review.classification`) lists, per class, what the document defines, what it does not, what the operator supplied, and which classes remain model-only.

**For the Halvorsen manual: it defines no goods for any class** (all five classes are `notDefinedByManual`), so the lookup rests entirely on the operator glossary in `scenario/freight/glossary.ts`. That glossary was written with knowledge of the task domain: its score on generated claims is an upper bound, not evidence about unseen goods (unknown goods fall back to the model and are flagged). Free-text claimant names ("Delacroix Foods") are a false-positive hazard; a test guards against it.

Opt-in: `buildGoldXo({ classification: true })`, arm `xo_tools_classified`, `compileManual({ glossary })`. The default arms are unchanged, so earlier measurements remain valid. **Not yet measured on a live model.**
