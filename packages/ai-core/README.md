# @xo/ai-core — The AI Capability Layer

The sole interface between the compiler (or anything else) and AI
providers. Callers get typed **semantic capabilities**
(`extractEntities`, `extractKnowledge`, `extractReasoning`,
`extractCapabilities`, `extractDecisionGraph`, `extractConstraints`) —
never a provider-specific API. Everything vendor-specific (OpenAI vs.
Anthropic vs. Gemini vs. Azure OpenAI vs. Ollama) is routing this package
owns internally.

## Design philosophy

- **Capabilities, not providers.** `AiCapabilityLayer#extractEntities()`
  takes a typed `EntityExtractionInput` and returns a typed
  `EntityExtractionOutput` — a caller never sees a model name, a prompt
  string, or an HTTP request. Swapping which provider serves a call, or
  adding a sixth vendor, never touches a caller.
- **One file per vendor, at the very bottom.** `ModelProvider` is the
  single boundary that knows about vendor-specific request/response
  shapes (`providers/*.ts`). Everything above it — routing, retries,
  circuit breaking, rate limiting, caching, cost accounting, schema
  validation — is 100% vendor-agnostic and works identically regardless
  of which providers are actually registered.
- **Explainable, not magic.** Every response's `CapabilityResponseMeta`
  reports exactly which provider/model served it, which prompt version,
  token usage, cost, cache-hit status, latency, and attempt count — a
  caller (or a test) can always see what actually happened, never just
  "an AI answered."
- **Deterministic where it matters.** The cache key and the deterministic-
  replay provider's fixture key are both content hashes over exactly
  what determines the answer — no wall-clock, no randomness — so this
  package's own test suite (and any caller's tests) can be fully
  deterministic without a real network call.

## Architecture

```
capability-types.ts     CapabilityRequest/Response envelope + CapabilityId
capabilities/*.ts       the six capabilities' typed input/output shapes
json-schema.ts          minimal JSON-Schema-subset validator
capability-schemas.ts   the JSON Schema each capability's output must satisfy
provider-types.ts       ModelProvider / ProviderRequest / ProviderCapabilityDescriptor
prompt/                 versioned PromptTemplate + PromptRegistry + default v1 prompts
retry.ts                exponential-backoff RetryPolicy
circuit-breaker.ts      three-state CircuitBreaker (closed/open/half_open)
rate-limiter.ts         TokenBucketRateLimiter
cache.ts                content-addressable CapabilityCache
cost.ts                 PricingTable + CostAccountant
model-selection.ts      ModelSelectionPolicy -> ordered candidate providers
router.ts               AiCapabilityLayer — wires all of the above together
providers/
  anthropic-provider.ts       real /v1/messages integration
  openai-provider.ts          real /v1/chat/completions integration
  azure-openai-provider.ts    real Azure OpenAI integration
  gemini-provider.ts          real generateContent integration
  ollama-provider.ts          real local/self-hosted /api/chat integration
  deterministic-replay-provider.ts   fixture-based provider for tests/replay
  scriptable-test-provider.ts        scripted success/failure provider, for this package's own tests
```

## What one call does, end to end

1. Resolve the capability's prompt template (default or pinned version)
   from the `PromptRegistry`.
2. Compute a cache key over `{capability, promptVersion, input, excerpt}`
   — a cache hit returns immediately, no provider call.
3. Ask `model-selection.ts` for an ordered candidate list (primary +
   fallbacks), filtered to providers that are registered and (if the
   capability needs it) support structured output.
4. For each candidate, in order: check its rate limiter (skip to the next
   candidate if exhausted, without ever attempting the call), then run
   the call through that provider's circuit breaker and a `RetryPolicy`.
5. Check the finish reason, then parse the response as JSON and validate
   it against the capability's `JsonSchema`. A truncated (`length`) or
   filtered (`content_filter`) response is rejected without parsing and not
   retried; a vendor `error` finish is retried once; a parse failure or
   schema-validation failure is a retryable error. Every provider call is
   made at `temperature: 0`.
6. On success: record cost via `CostAccountant`, populate the cache,
   return `{ output, meta }`.
7. If every candidate is exhausted: `AI_ALL_PROVIDERS_FAILED`.

## Cross-cutting behaviors, and where to find their tests

| Behavior                                                  | Module                                                            | Tests                                                                       |
| --------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Provider abstraction                                      | `provider-types.ts`                                               | exercised throughout `router.test.ts`                                       |
| Capability routing                                        | `router.ts`, `model-selection.ts`                                 | `router.test.ts`, `model-selection.test.ts`                                 |
| Retries                                                   | `retry.ts`                                                        | `retry.test.ts`                                                             |
| Fallbacks                                                 | `router.ts`                                                       | `router.test.ts` ("falls back to the next provider...")                     |
| Streaming                                                 | `provider-types.ts`'s `completeStream`                            | `deterministic-replay-provider.test.ts`                                     |
| Structured outputs                                        | `json-schema.ts`, `capability-schemas.ts`                         | `json-schema.test.ts`                                                       |
| Schema validation                                         | `router.ts`'s post-parse validation step                          | `router.test.ts` ("fails schema validation...")                             |
| Prompt versioning                                         | `prompt/prompt-registry.ts`                                       | `prompt-registry.test.ts`                                                   |
| Caching                                                   | `cache.ts`                                                        | `cache.test.ts`, `router.test.ts`                                           |
| Telemetry                                                 | `router.ts`'s `Tracer`/`Meter` calls (reuses `@xo/observability`) | exercised, not separately asserted on — see "Known limitations"             |
| Cost accounting                                           | `cost.ts`                                                         | `cost.test.ts`, `router.test.ts`                                            |
| Rate limiting                                             | `rate-limiter.ts`                                                 | `rate-limiter.test.ts`, `router.test.ts`                                    |
| Circuit breakers                                          | `circuit-breaker.ts` (health-only failure predicate)              | `circuit-breaker.test.ts`, `router.test.ts`, `router-safety.test.ts`        |
| Adapter transport (timeout, abort, retry, redaction)      | `providers/http-transport.ts`                                     | `providers/adapter-conformance.test.ts`, `providers/http-transport.test.ts` |
| Finish-reason guard, fallback control, pinned temperature | `router.ts`, `model-selection.ts`                                 | `router-safety.test.ts`                                                     |
| Total deadline / cancellation scope                       | `call-scope.ts`, `router.ts`                                      | `router-deadline.test.ts`                                                   |
| Policy validation                                         | `policy-validation.ts`                                            | `policy-validation.test.ts`                                                 |
| Deterministic replay for tests                            | `providers/deterministic-replay-provider.ts`                      | `deterministic-replay-provider.test.ts`                                     |
| Mock providers                                            | `providers/scriptable-test-provider.ts`                           | used throughout `router.test.ts`                                            |
| Provider capability discovery                             | `AiCapabilityLayer#describeProviders()`                           | `router.test.ts`                                                            |
| Model selection policies                                  | `model-selection.ts`                                              | `model-selection.test.ts`                                                   |
| Future multimodal models                                  | `ProviderCapabilityDescriptor.supportsVision`                     | descriptor-only today — see "Known limitations"                             |

## Known limitations (real, not hidden)

- **Transport safety is now shared, but still unverified live.** The
  Anthropic, OpenAI, Azure OpenAI and Ollama adapters use
  `providers/http-transport.ts` (per-request timeout, caller-abort, status
  classification, bounded transport retry, secret redaction) and are held to
  the same contract as Gemini by `adapter-conformance.test.ts` (scripted
  `fetch`, fake timers). That proves the contract against scripted
  responses only, not against what each vendor really returns.
- **Total deadline and policy validation exist now (deadline is opt-in).**
  `totalDeadlineMs` bounds retries, backoff and fallback for one capability
  call; a late provider response is discarded (never cached) but its usage is
  still charged. `ModelSelectionPolicy` is validated at construction
  (structural errors throw `ConfigError`; suspicious-but-legal findings are in
  `layer.policyWarnings`). See `docs/inference-cache-and-policy.md`, Slice 8.
- **Still deferred:** per-provider verification of the output-schema dialect,
  live (opt-in) verification of each adapter, and wiring an AI layer into the
  apps.
- **`temperature: 0` is pinned on every call**, and the cache format
  version is now 3: existing durable (file) cache entries are never
  looked up again (new keys) and are regenerated once; old files stay on disk. Some model families reject a non-default
  temperature or `max_tokens`; the adapters keep their existing wire format.
- **The five real provider adapters (OpenAI, Anthropic, Gemini, Azure
  OpenAI, Ollama) are NOT live-verified.** The sandbox this package was
  built in has no network access and no API credentials for any vendor.
  Each adapter is written to that vendor's documented request/response
  contract and is genuinely reviewable code — not a placeholder — but
  the very first real-world verification of each is still owed, in an
  environment with the network access and credentials this one lacks.
  `DeterministicReplayProvider`/`ScriptableTestProvider` are what this
  package's own test suite actually runs against.
- **No true multimodal (image/audio) input yet.**
  `ProviderCapabilityDescriptor.supportsVision` exists and is populated
  per provider, but `ProviderRequest`/`ProviderMessage` only carry text
  content today — a future `ProviderMessage` variant for image/audio
  parts is the natural extension point, not a redesign.
- **Structured-output enforcement is best-effort per vendor.** Only
  OpenAI and Azure OpenAI have a real, dedicated structured-output
  mechanism (`response_format: json_schema`) as implemented here.
  Anthropic and Gemini are asked via prompt instruction (Anthropic) or a
  `responseSchema`/`responseMimeType` hint (Gemini); `router.ts`'s
  post-parse JSON Schema validation is the actual backstop regardless of
  which mechanism a given vendor call relied on.
- **Streaming is defined but not exercised against a real provider.**
  Every real adapter implements `complete()` (non-streaming);
  `completeStream` is only implemented on `DeterministicReplayProvider`
  today. Adding real SSE-based streaming to the five vendor adapters is
  the natural next increment, not a gap in the streaming abstraction
  itself (`provider-types.ts`'s `ProviderStreamEvent` already models it).
- **Telemetry emits through `@xo/observability`'s `ConsoleTracer`/
  `ConsoleMeter` by default** (see that package's own README for why) —
  this package adds no OpenTelemetry-specific code of its own; swapping
  in a real exporter is entirely `@xo/observability`'s concern.
- **Pricing figures in `cost.ts`'s `DEFAULT_PRICING_TABLE` are
  illustrative**, hand-entered to make cost accounting work end-to-end,
  not guaranteed to reflect current vendor pricing. Don't rely on them
  for real billing without checking against each vendor's live pricing.

## Example

```ts
import { AiCapabilityLayer, AnthropicProvider, type ModelSelectionPolicy } from '@xo/ai-core';

const policy: ModelSelectionPolicy = {
  rules: [{ capability: '*', providerOrder: ['anthropic'], modelByProvider: { anthropic: 'claude-sonnet-4-6' } }],
};

const ai = new AiCapabilityLayer({
  providers: [new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! })],
  policy,
});

const result = await ai.extractEntities({
  input: {},
  excerpt: { text: pageText, documentPath: 'contract-law.pdf', page: 3 },
  traceId: crypto.randomUUID(),
});

if (result.ok) {
  console.log(result.value.output.entities);
  console.log(`served by ${result.value.meta.providerUsed}/${result.value.meta.modelUsed}, $${result.value.meta.costUsd.toFixed(4)}`);
} else {
  console.error(result.error.code, result.error.message);
}
```
