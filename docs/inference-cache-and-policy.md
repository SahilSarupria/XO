# Inference cache (Slice 1) and inference policy (Slice 3)

Goal: LLM output is a **build-time proposal**; the validated artifact is what runs. Runtime execution is deterministic and
free unless a node explicitly declares inference _and_ server policy, per-run policy and budget all allow it.

## Slice 1: durable capability cache (`@xo/ai-core`)

- `CapabilityCache` is now `MaybePromise`-based (sync in-memory caches still conform). `FileCapabilityCache` is a durable,
  single-host implementation: one `<sha256-hex>.json` per key, atomic write (temp + rename), files 0600 in a 0700 directory.
- **Key identity** (`computeCacheKey`) now includes, as supplied by the router: capability, prompt version, input, excerpt,
  the ordered `provider/model` candidate list, a hash of the output schema, generation settings, and a cache-format version.
  Changing any of these changes the key. (Previously the key deliberately excluded model identity; that has been reversed so a
  model switch can never silently serve another model's answer.) Optional fields are omitted when undefined, so legacy
  callers' keys are unchanged.
- **Only validated output is cached.** Failures and schema-invalid outputs are never stored. Every read is verified (valid
  JSON, format version, `envelope.key === key`) and the router re-validates the output against the _current_ schema; anything
  else is a miss. A throwing or unwritable cache degrades to "no cache", never a failed request.
- **No secrets:** values containing a configured secret or a Google-key-shaped string are not written. Keys are digests, so
  source text is not in file names; note that _outputs_ can contain text extracted from private documents (hence 0600/0700).
- **Provenance is honest.** Every `CapabilityResponse.meta.provenance` has `origin: 'llm'` and `source: 'generated' | 'cache'`.
  On a hit, top-level `usage`, `costUsd` and `attempts` are zero (nothing was spent now) and the original generation
  (time, trace id, provider, model, prompt version, schema hash, original usage/cost) is preserved under
  `provenance.generation`. Deterministic-origin output is produced outside `ai-core`; this field only describes LLM output.
- Invalidation is explicit: `invalidate(key)` / `clear()`. Nothing is evicted automatically.
- Behaviour change: candidate selection now runs _before_ the cache lookup, so with no eligible provider a request fails
  even if an entry exists.
- Limits: not a shared cache (no cross-host coordination, no size bound, no eviction). A production fleet needs a shared
  backend behind the same interface.

## Slice 3: inference policy and enforcement

Three independent authorities must all agree; none can grant what another denies (`InferenceGuard`, `@xo/ai-core`):

| Authority                               | Controls                                                                          | Can it grant?                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Node (capability/step declaration)      | `none` / `required` / undeclared                                                  | n/a: it is the request                                               |
| Server policy (`ServerInferencePolicy`) | kill-switch, provider allow-list, cumulative token/cost budget, `allowUndeclared` | yes, within its limits                                               |
| Per-run (`RunInferenceRestriction`)     | `disabled`, tighter `maxTotalTokens` / `maxCostUsd`                               | **no**: the type has no field that grants; limits combine with `min` |

- **No parallel field.** The node declaration is derived from the existing authoritative `CapabilityDeclaration.execution.mode`:
  `model` (and a hybrid `model` step) = `required`; `deterministic_rule` / `human_in_the_loop` = `none`; no `execution` = undeclared.
  `required` means the node needs inference to complete its declared operation, not that a model must be called regardless of policy.
- **Default is fail-closed.** Undeclared capabilities (every package compiled before declarations existed) may NOT call an LLM unless the
  server sets `allowUndeclared: true` (CLI: `XO_INFERENCE_ALLOW_UNDECLARED=true`). This **changes the former R1 default**
  (absent `execution` => model => LLM call) for the runtime's inference gate. `ExecutionStrategyRouter.resolve(undefined)` still
  returns `'model'` as the _strategy_; the gate is what now refuses to dispatch it.
- **Authoritative boundary:** `CapabilityExecutor` (`@xo/runtime`), the only runtime call into a provider. `execute`/`stream` require an
  `InferenceDispatchContext`, so no call site compiles without choosing an authority. This covers single-model, streaming and
  hybrid-step dispatch. A denial is `XO_RUNTIME_PERMISSION_DENIED` (or `XO_RUNTIME_BUDGET_EXCEEDED`) with
  `context.inferenceDenial.reason` in `server_disabled | run_disabled | node_declares_none | node_undeclared | provider_not_allowed | budget_exhausted`.
  It is never retried, never substitutes another provider, and never falls back to deterministic execution.
- **Budgets:** tokens are _reserved_ before a call (so concurrent calls cannot jointly overshoot) and settled with real usage.
  The provider request's `maxOutputTokens` is clamped to what remains. Unknown usage is charged at the reservation for budget purposes
  (cost stays 0; no price is fabricated). A failed call releases its reservation (billing for a failed/timed-out call is unknown).
  Input tokens are not known in advance, so one call can exceed a budget by its input size; no further call is then permitted.
  Server budget is cumulative per `InferenceGuard` (per engine) until `resetBudget()`. Requests sharing one `RunInferenceRestriction`
  _object_ (e.g. every node of one workflow) share one run budget.
- **Package boundary:** `execution.mode` and hybrid steps are already validated by `@xo/package-sdk`; no new manifest field was added.

## Slice 4: compile-time spend guard (`AiCapabilityLayer`)

**Boundary.** `AiCapabilityLayer` (`@xo/ai-core`) is the only compile-time path into a provider; every compiler extractor reaches a
provider through it. It takes an optional `inferenceScope` (an `InferenceRunScope`). Create one per compilation from a dedicated
`InferenceGuard`, e.g. `createCompileInferenceScope(resolveCompilerInferencePolicy(process.env))`. The layer instance plus its scope
is the stable budget scope; every call, including the four concurrent calls the reasoning extractor makes per unit, shares it.
This reuses the Slice 3 guard rather than adding a second budget mechanism; it is a **separate instance** from the runtime guard, so
compile budget grants nothing to runtime execution (a test asserts this) and node declarations are not consulted at compile time.

**Semantics.**

- Authorization and reservation happen before **every billable attempt**: first attempts, schema-validation retries, and fallback
  to the next candidate provider all draw on the same budget. Tokens are reserved up front (the request's `maxOutputTokens` is
  clamped to what remains), so concurrent calls cannot jointly exceed the token limit.
- A completed call is settled with the provider's reported usage **even if the body was unusable** (schema-invalid output is still
  billed). Unknown usage is charged at the reservation; no cost is invented.
- Provider error, timeout, open circuit, or cancellation: the reservation is **released** (nothing measurable). Limitation: a
  timed-out or cancelled call may still be billed by the vendor, so the guard can under-count in those cases.
- Cache hits are never charged and are served even when the budget is exhausted. Policy (kill-switch / allow-list) is still enforced
  before the cache, since cached output is LLM-derived.
- A denial is `XO_AI_INFERENCE_DENIED` (new code, not `AI_ALL_PROVIDERS_FAILED`), carrying `context.inferenceDenial {reason, nodeId:
"compile:<capability>", providerId}` and `scope: "compile"`. It is never retried and never failed over to another candidate. It is
  thrown outside the circuit breaker so it cannot count as a provider failure.
- `CapabilityRequest.signal` is checked before every attempt and forwarded to the provider.
- `AiCapabilityLayer.inferenceReport()` returns spend and a count of denials by reason for the layer instance.
- Limits come from `XO_COMPILER_MAX_TOTAL_TOKENS` and `XO_COMPILER_MAX_COST_USD` (`0` forbids all compile-time inference; unset =
  unlimited). With no `inferenceScope`, behaviour is unchanged (unlimited).
- Router cost reporting now also records billed-but-discarded (schema-invalid) attempts, so `totalCostUsd()` no longer under-reports retries.

**What the compiler does on denial.** The extractors (`HybridKnowledgeExtractor`, the reasoning and capability extractors) keep
their existing behaviour of continuing degraded: knowledge falls back to rule-based output, reasoning/capability units contribute
nothing. The warning log now carries `errorCode` and `inferenceDenied: <reason>` so denial is distinguishable from a provider outage.
The compile does **not** fail on denial; a caller that must treat exhaustion as fatal should check `inferenceReport().denials`.

## Known limitations

- **Cost limit is weaker than the token limit.** Cost is computed from the pricing table (a model absent from it prices at 0 and never
  trips the limit) and is not reserved in advance, so concurrent in-flight calls can overshoot it. Use the token limit as the dependable cap.
- Input tokens are unknown before a call, so a single call can overshoot the token budget by its input size; no further call is then allowed.
- Failed/timed-out/cancelled calls are released, not charged (possible under-count, above).
- Per-scope only: nothing aggregates spend across separate compilations or processes.
- No confidence-gated escalation exists. The hybrid knowledge extractor still calls the model for every unit; "escalation" covered
  here means retries and candidate fallback. Selecting which units deserve model calls is a separate, unimplemented slice.
- The caller must supply `inferenceScope`; nothing in the compiler constructs the layer, so enforcement is only as good as the entrypoint wiring.

## Not done yet

- Confidence-gated compiler escalation (deterministic first, escalate only low-confidence residue, review gate for unresolved output).
- The LLM workflow-authoring and human-approval flow; nothing here lets an LLM-authored workflow deploy.
- A shared/production cache backend, and any Studio/UI surface. The API execute route remains disabled.
