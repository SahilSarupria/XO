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
