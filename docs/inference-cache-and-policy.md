# Inference cache (Slice 1), inference policy (Slice 3) and inference-safety closure (Slice 7)

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

## Slice 5: enforcement at the compile entrypoint, and a dependable cost cap

**P0 — unbounded compile is no longer possible by omission.**

- The compiler functions that accept `aiCore` (`compileSources`, `compilePdfToXoir`, and therefore `compilePdfToPackage`) call
  `checkCompileInferenceAuthority` **first**, before any work. A layer that cannot limit spend (`AiCapabilityLayer.inferenceBounded()`
  is false: no scope, or a scope built from an unlimited policy) is refused with `CONFIG_MISSING_KEY`, unless the caller passes
  `allowUnboundedInference: true`. A layer with a finite limit, or with inference disabled, is accepted. With no `aiCore` the compile
  is rule-based and unchecked.
- `resolveCompilerInferencePolicy` is **fail-closed**: with neither `XO_COMPILER_MAX_TOTAL_TOKENS` nor `XO_COMPILER_MAX_COST_USD` it throws,
  unless the operator explicitly sets `XO_COMPILER_ALLOW_UNBOUNDED_INFERENCE=true`. (This reverses the earlier "unset = unlimited".)
- `createCompilerAiLayer(env, deps)` is the sanctioned constructor: explicit provider selection + fail-closed limits + a fresh
  per-compilation scope + optional durable cache (`XO_INFERENCE_CACHE_DIR`). It returns `unconfigured` when no provider is selected, and
  its `allowUnboundedInference` is true only on explicit opt-in; spread `{ aiCore, allowUnboundedInference }` into the compile options.
- **Reality check:** today no app constructs an AI layer (the API compile route and the CLI call `compileSources` without `aiCore`).
  So no production path was unbounded before this change either; this closes the door before one is opened, at the library boundary
  every future caller must pass through. Anyone can still construct an `AiCapabilityLayer` and call extractors directly, bypassing
  the entrypoints; the boundary protects the compile pipeline, not arbitrary library use.

**P1 — a dollar cap that actually bounds spend.**

- **Unknown price is not free.** `findPricing` returns `undefined` for an unlisted model (a `'*'` entry is an explicit "all models cost this",
  used for `ollama` and `deterministic-replay` at $0). Under a cost cap, an unpriced model, or a call with no input-size estimate, is
  refused as `cost_unestimable` before any provider call. Without a cost cap, unpriced models are unaffected.
- **Worst-case reservation.** Before a call, the guard reserves `inputBound * inputPrice + grantedOutput * outputPrice`, where
  `inputBound = estimateInputTokensUpperBound(messages, schema)` (UTF-8 byte length + fixed margin; deliberately over-estimates) and
  the granted output tokens are clamped so that reservation fits the remaining cap. Concurrent calls each hold their reservation, so
  in-flight calls cannot jointly exceed the cap. On settle the reservation is replaced by actual cost; on failure it is released.
- **Unknown usage under a cost cap** is charged the reserved worst-case cost (not $0).
- The runtime executor passes the model and input bound too, so the same cap semantics apply to runtime server/run cost limits.
- **Default Gemini consequence:** `gemini-3.5-flash-lite` has no entry in the pricing table, so a cost cap with the default Gemini model
  is refused until the operator supplies a price. This is intentional: use the token cap, or add a verified price. No price was
  invented.
- **Assumptions the bound rests on (not guarantees):** tokens <= UTF-8 bytes of the prompt (+ margin); the provider bills input as
  text; the provider honours `maxOutputTokens` including hidden reasoning tokens (not verified for every provider); and the pricing
  table is accurate and current.

## Slice 6: confidence-gated escalation (knowledge hybrid extractor)

**Policy** (`knowledge/escalation-policy.ts`, a pure function over the rule extractor's candidates; the spend guard still decides whether an
escalated unit may actually call a model, and nothing here retries or routes around a denial):

| Rule-extraction result                                           | Decision                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------- |
| Fragment: fewer than `minContentWords` (4) words                 | Skip (`insufficient_content`): a model has nothing to add |
| No usable candidate                                              | Escalate (`no_candidate`)                                 |
| Best usable candidate below `confidenceThreshold` (default 0.75) | Escalate (`low_confidence`)                               |
| Competing candidates the rules cannot settle                     | Escalate (`ambiguous`)                                    |
| Usable candidate at/above threshold, no unresolved competition   | Skip (`strong`)                                           |
| `mode: 'always'`                                                 | Escalate every unit (the previous behaviour)              |

- **Usable** means a clean single phrase (no line break, comma, semicolon or colon inside; at most `maxLabelWords` = 8 words). The rules assign 0.65 to
  any multi-word capitalized run, even one spanning a line break, so malformed candidates never make a unit look strong.
- **Competition**: two candidates with the same normalized label or overlapping spans but different types. The rules settle it themselves only
  when the confidences differ by at least `ambiguityMargin` (0.1) or a fixed specificity order applies (`organization` over `entity`,
  `definition` over `concept`); otherwise the unit escalates. On the real fixtures this fires rarely (2 of 128 units at threshold 0.7).
- Configure with the `escalation` option of `extractKnowledgeGraph`/compile options, or `resolveEscalationPolicy(env)`
  (`XO_COMPILER_ESCALATION_{MODE,CONFIDENCE_THRESHOLD,AMBIGUITY_MARGIN,MIN_CONTENT_WORDS}`).
- **Behaviour change:** the hybrid extractor previously called the model for every unit. The default is now gated; use `{ mode: 'always' }` for the old behaviour.
- **Validation:** model output is checked before it is accepted (`knowledge/model-validation.ts`): non-empty bounded labels, confidence in [0, 1],
  unique ids, no dangling edges, and a deliberately weak grounding check (each label shares a 5-letter word stem with the unit). Any violation rejects the
  whole result (all-or-nothing); the rule result stands and the rejection is counted. A literal-word grounding check wrongly rejected a legitimate
  abstraction during development, hence the stem match; it can still reject a purely abstract label (a known false-reject risk) and cannot prove faithfulness.
- **Provenance:** model-derived candidates carry `provenance.derivation { kind: 'llm', source: 'generated' | 'cache', provider, model, escalationReason }`;
  rule-derived candidates carry none (their absence plus `extractorName: 'rule-based'` marks them), so rule-only graphs are byte-identical to before.
- **Repeat calls:** a unit (same id and content) is escalated at most once per extractor instance; repeats are memoized. Retries inside a call are the layer's own bounded policy.
- **Report:** `HybridKnowledgeExtractor.report()` gives units seen, escalated, skipped, counts by decision reason, outcomes (`accepted`, `cache_hit`, `denied`,
  `failed`, `rejected_invalid`, `memoized`) and fresh calls attempted; `extractKnowledgeGraph` logs it when an `aiCore` is supplied.

**What the real score distribution looks like** (128 prose units from the three `examples/vertical-test` PDFs). The rule extractor's confidences are
tiers, not a continuum: the unit-primary node is 0.5 (58 units), 0.6 (35) or 0.7 (35), and never 0.85 (no explicit defined term occurred); entity
candidates are 0.5 or 0.65. Because of the caps, `best < 0.75` holds for every unit, so a high threshold degenerates to "always escalate". 46 units (36%) are
fragments of fewer than 4 words (headings, `https:`, empty cells).

**Measurement** (`test/knowledge/escalation-measurement.test.ts`; fixture `escalation-gold.ts`). Gold is 42 real units that I annotated by hand, after
seeing the rule output, stratified by the gate's own classes, single annotator, not blind. Its stated rules are in the fixture. Read everything below as
a diagnostic of the gate's _targeting_, not a benchmark. There is no live model offline, so "after" figures use an **oracle that fixes every escalated unit
perfectly**: they are a ceiling for each policy, **not evidence that a real model would improve anything**.

Rules alone, on the gold units: 41 of 42 units contain at least one error (38 correct entities, 104 false positives, 26 misses; 26 wrong primary nodes).

| Policy                                                     | Calls | Input-token upper bound | Units needing help sent to model | Residual FP / FN / wrong primary | Oracle entity F1 |
| ---------------------------------------------------------- | ----- | ----------------------- | -------------------------------- | -------------------------------- | ---------------- |
| Rules only                                                 | 0     | 0                       | 0 / 41                           | 104 / 26 / 26                    | 0.37             |
| Always (previous behaviour)                                | 42    | 33,866                  | 41 / 41                          | 0 / 0 / 0                        | 1.00             |
| Gated, threshold 0.60                                      | 10    | 5,952                   | 10 / 41                          | 96 / 20 / 21                     | 0.43             |
| Gated, threshold 0.65                                      | 11    | 6,491                   | 11 / 41                          | 96 / 20 / 20                     | 0.43             |
| Gated, threshold 0.70                                      | 22    | 16,361                  | 22 / 41                          | 29 / 7 / 10                      | 0.76             |
| **Gated, threshold 0.75 (default)**                        | 38    | 31,700                  | 37 / 41                          | 3 / 0 / 2                        | 0.98             |
| Exploratory, not shipped: 0.70 plus a noisy-candidate rule | 33    | 26,793                  | 33 / 41                          | 5 / 3 / 5                        | 0.94             |

(The token column is an upper-bound proxy for input size, not a price or a measurement of spend.)

What this does and does not show:

- **It does not demonstrate that escalation improves extraction.** No real model was run. It shows only where each policy would send calls and what it would leave behind if the model were perfect.
- **Rule confidence barely predicts correctness here.** Under a 0.7 threshold, 15 of the 16 units called "strong" still contained an error (26 false positives, 7 misses, 8 wrong primary nodes). Skipping on that signal would leave most of the problems in place; the thresholds 0.60 to 0.70 save many calls and leave a large share of the errors behind.
- **That is why the default is 0.75**: it skips on confidence only when the extractor's top tier fired (an explicit defined term), and otherwise the dominant, safe saving is the fragment rule. Across all 128 real units, default gating escalates 82 (64%) versus 128 for always, i.e. a 36% reduction in calls, almost all from fragments; a 0.70 threshold would escalate 65 (51%) at the cost shown above. That top tier did not occur in the fixtures, so skipping on it is a design judgement about an explicit cue that the fixtures could not confirm.
- Precision of the calls is uninformative because the base rate is so high (rules need help on 41 of 42 units, so any policy's calls mostly "needed help").
- The exploratory noisy-candidate rule improves targeting on this gold, but it was designed after looking at this same data; it is not shipped, and would need an independent gold set before adoption.
- Needed next: a live-provider run (opt-in, with a budget) on an independent, blind gold set, measuring a real model's precision and recall against the rules, before claiming that escalation improves output.

## Slice 7: inference-safety closure (`@xo/ai-core`)

Closes the transport and routing gaps that remained after Slices 1-6. Gemini is the reference implementation and its adapter is unchanged.

- **Shared transport (`providers/http-transport.ts`).** The generic part of Gemini's request path, used by the Anthropic, OpenAI, Azure
  OpenAI and Ollama adapters: per-request timeout (default 30 s, also covering the body read), caller-signal propagation with timeout vs caller
  abort distinguished, HTTP status to `ProviderFailureCategory`, `Retry-After` parsing (a wait above `maxRetryAfterMs`, default 15 s, fails fast
  instead of sleeping), and a **bounded transport retry** (default 2 retries, 500 ms to 8 s backoff, abort-aware sleep, only
  `isTransportRetryable` categories). The router does not retry classified provider failures, so this retry is the only thing that retries a 503
  or 429; without it a transient vendor error would fail the request. A pre-aborted signal makes zero network calls.
- **Adapters throw `providerFailure(...)` only.** No raw vendor body ever appears in a message: vendor text goes to `context.providerMessage`
  only after redaction (the configured key, Google-key and auth-header patterns, plus `sk-...` and `Bearer ...` shapes) and truncation to 300
  characters. Missing or odd `choices` / `content` / `usage` can no longer raise a `TypeError`: usage becomes `usageKnown: false`, empty output
  `empty_response`, a refusal or content filter `content_blocked`, an output-token stop `finishReason: 'length'`. Wire formats and descriptors are
  unchanged; Ollama is still `supportsStructuredOutput: false` (never router-eligible).
- **New category `output_truncated`** (additive; never transport-retried, never router-retried): the router's rejection of a `length` finish.
- **Router finish-reason guard.** After the call is settled and before `JSON.parse`: `length` is rejected as `output_truncated`,
  `content_filter` as `content_blocked`, `error` as a transient failure retried **once**. Truncated JSON can be well-formed yet silently missing
  items, so a valid-looking body does not rescue it. The billed attempt is still charged (settled against the `InferenceRunScope`, recorded in cost).
  `length` and `content_filter` are deterministic and are not retried. For the Gemini adapter, `content_filter`/`error` are thrown earlier by the
  adapter (unchanged); a Gemini `MAX_TOKENS` with parseable JSON now reaches this guard and is rejected, which it previously was not.
- **Circuit breaker predicate.** `CircuitBreakerOptions.isFailure?(error)`; default counts every error (unchanged). The router counts only
  `transient`, `timeout`, `rate_limited` provider failures and unclassified errors. Auth, permission, invalid request, quota, unsupported
  model/feature, content blocked, truncation, abort, `malformed_response`, `empty_response`, `AI_SCHEMA_VALIDATION_FAILED` and inference denials
  leave the breaker untouched (neither counted nor reset). A caller-supplied `circuitBreakerOptions.isFailure` takes precedence.
- **Fallback control.** `ModelSelectionPolicy.allowFallback?: boolean` (default `true` = unchanged). `false` uses only the first eligible
  candidate: when it fails the request fails with `AI_ALL_PROVIDERS_FAILED`; no other provider is called. `singleProviderPolicy()` sets it to
  `false` explicitly. The cache identity uses the effective candidate list.
- **Temperature pinned to 0.** The router sends `temperature: 0` on every provider call (first attempt, retry, fallback) and records it in the
  cache key's `generation`. `CACHE_FORMAT_VERSION` is now **3**. **This invalidates every existing durable (`FileCapabilityCache`) entry**:
  v2 entries are treated as misses (not errors) and are regenerated once, at real cost. In-memory caches are unaffected across restarts.
- **Tests.** `test/providers/adapter-conformance.test.ts` runs one contract over all five adapters (Gemini included) with a scripted `fetchImpl`
  and fake timers; `test/providers/http-transport.test.ts` covers helper-specific behavior; `test/router-safety.test.ts` covers the router items.

## Known limitations

- **No adapter other than Gemini has been verified against a real vendor.** The new conformance suite proves each adapter behaves per this
  contract against scripted responses, not that the scripted shapes match what the vendors actually return today.
- **Pinning `temperature: 0` can be rejected by some models.** Several vendor model families (for example some reasoning models) accept only a
  default temperature, or require `max_completion_tokens` instead of `max_tokens`; the adapters keep their existing wire format, so such a model
  would fail with `invalid_request` (not retried, not counted by the breaker). Choose models accordingly or revisit before enabling them.
- **No router-level total deadline.** Each HTTP attempt is bounded, and so is the number of attempts, but the worst-case wall time of one
  `extract*` call (retries x adapters x fallback candidates, plus backoff) is not capped as a whole.
- **No policy validator.** `ModelSelectionPolicy` is not validated at construction (unknown providers, missing `modelByProvider` entries and
  empty `providerOrder` are silently skipped at selection time).
- **No per-provider schema-dialect verification.** The output schema is translated per vendor (Gemini subset, OpenAI strict `json_schema`,
  prompt-embedded for Anthropic) but the translation is not verified against each vendor's accepted dialect; local validation is the backstop.
- **Adapter-thrown `content_blocked` / `empty_response` are released, not charged.** Those failures are raised inside the adapter, so the
  router never sees usage and cannot bill the call (Gemini behaves the same). Only the router-detected finish reasons (`length`, `content_filter`
  and `error` returned by a provider) are charged as billed-but-discarded.
- **App wiring.** Nothing in the apps constructs an AI layer or an inference scope yet; this slice changes `@xo/ai-core` only.
- **Cost cap depends on the pricing table being right.** See Slice 5: unknown prices are refused, but a _wrong_ price in `DEFAULT_PRICING_TABLE` (documented as illustrative, not current vendor pricing) produces a wrong bound. Operators must supply a maintained table.
- The TOKEN budget can still be overshot by one call's input size (input tokens are unknown in advance); the COST budget cannot, because it reserves a conservative input bound (Slice 5).
- Failed/timed-out/cancelled calls are released, not charged (possible under-count, above); see Slice 7 for which finish-reason failures are charged.
- Per-scope only: nothing aggregates spend across separate compilations or processes.
- Confidence-gated escalation exists for the knowledge hybrid extractor only (Slice 6). The reasoning and capability extractors still call the model for every unit.
  here means retries and candidate fallback. Selecting which units deserve model calls is a separate, unimplemented slice.
- The compiler entrypoints now refuse an unbounded layer (Slice 5), but nothing in the apps constructs an AI layer yet: AI-assisted compile is not enabled in the CLI or API today. Enabling it must go through `createCompilerAiLayer`.

## Not done yet

- Escalation gating for the reasoning and capability extractors, and an independent, blind gold set to validate any gate (Slice 6 used a small self-annotated one).
- The LLM workflow-authoring and human-approval flow; nothing here lets an LLM-authored workflow deploy.
- A shared/production cache backend, and any Studio/UI surface. The API execute route remains disabled.

## Running the live (real-model) evaluation

Status: **pending**. The offline parts were run; the real-model arms need an API key and network access to `generativelanguage.googleapis.com`.

Windows (PowerShell, from the repository root, on the branch that contains this commit):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\escalation-eval\run.ps1 -DryRun     # checks everything, spends nothing
powershell -ExecutionPolicy Bypass -File .\scripts\escalation-eval\run.ps1             # prompts for the key (hidden), then runs
```

macOS/Linux/Windows with Node directly: set `GEMINI_API_KEY` for the session and run `node scripts/escalation-eval/run.mjs`.

What it does, in order: preflight (Node >= 22.15, key, budget), connectivity check, `npm ci`, `npm run typecheck`, then the opt-in test in
`packages/compiler/test/knowledge/escalation-eval.test.ts`, then `summarize.mjs`. All arms share one layer, one budget scope and one cache, so a
unit's model answer is generated once (about 43 calls, roughly 70k tokens) and replayed for every other arm. The default hard cap is 150,000
tokens (`-BudgetTokens`); once spent, further calls are refused, and any denial or provider failure makes the summary declare the run invalid.
`-MinIntervalMs` (default 6000) spaces out provider calls for free-tier rate limits. Outputs go to `.eval-output/<timestamp>/` (git-ignored):
`report.json` and `report.summary.md`, neither of which contains the key, prompts or document text.

**Data warning.** The evaluated units come from `examples/vertical-test/*.pdf`; `burglary-policy.pdf` and `Aastha.pdf` appear to contain real
personal data and an internal operations document. The run sends that text to Google, and on the free tier Google may use submitted content to
improve its products (per its pricing page when this was written; confirm current terms). Use a paid-tier key or do not run it if that is not
acceptable. The script requires you to type `SEND` (or pass `-AcknowledgeDataLeavesThisMachine`).

The summary applies the pre-registered criteria in the test header mechanically (selection on dev only, held-out once). Do not edit the labels or
criteria after seeing results. The offline "plumbing" test uses a scripted provider and its reports are marked `scripted` and bannered as not real evidence.
