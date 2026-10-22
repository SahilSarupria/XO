# Inference: provider-neutral contract + Gemini adapter (v1)

> Google's pricing, model availability, quotas and free-tier terms change. Everything below was checked
> against Google's official docs on 2026-10-22; re-verify before relying on it.

## Architecture

`@xo/ai-core` already defined the provider-neutral contract (`ModelProvider`, `ProviderRequest`,
`ProviderResponse`, `ProviderCapabilityDescriptor`). This work **extended** it additively rather than adding a second interface:

- `ProviderRequest`: optional `requestId`, `signal`.
- `ProviderResponse`: optional `usageKnown` (false = vendor reported nothing; `usage` is a `{0,0}` placeholder) and `meta` (provider, request id, duration, attempts, raw finish reason).
- `ProviderCapabilityDescriptor.features`: explicit per-feature flags (system instructions, schema-constrained output, usage reporting, temperature, hidden reasoning tokens). Absent = undeclared, not "supported".
- `provider-errors.ts`: normalized `ProviderFailureCategory` (`invalid_request`, `authentication`, `permission_denied`, `rate_limited`, `quota_exhausted`, `timeout`, `transient`, `aborted`, `unsupported_model`, `unsupported_feature`, `malformed_response`, `empty_response`, `content_blocked`) carried in `AiError.context`. Existing error codes are reused; `@xo/errors` is unchanged.
- `inference-config.ts`: validated config (`@xo/config`), explicit provider resolution, readiness description.

Gemini is one adapter (`providers/gemini-provider.ts`). Call sites (router, API, CLI) only see `ModelProvider`.

## Setup

1. Create a key at <https://aistudio.google.com/apikey>.
2. Export server-side: `XO_INFERENCE_PROVIDER=gemini` and `GEMINI_API_KEY=...` (see `.env.example`).
3. Optional: `XO_GEMINI_MODEL`, `XO_GEMINI_TIMEOUT_MS`, `XO_GEMINI_MAX_OUTPUT_TOKENS`, `XO_GEMINI_TEMPERATURE`, `XO_GEMINI_MAX_RETRIES`.

```ts
import { resolveInference, AiCapabilityLayer } from '@xo/ai-core';
const r = resolveInference(process.env, { logger });
if (r.state === 'configured') new AiCapabilityLayer({ providers: [r.provider], policy: r.policy /* … */ });
```

**Unconfigured**: with no `XO_INFERENCE_PROVIDER` (or `none`), `resolveInference` returns `{ state: 'unconfigured' }`. There is no default provider, no fallback to another provider, and no fallback to deterministic execution. To disable Gemini, unset the variable. Unknown providers and invalid config throw `ConfigError` at startup.

## Default model

`gemini-3.5-flash-lite`: Flash-family, listed free-tier on Google's pricing page, generally available (not `-preview`), no announced shutdown, and Google's recommended model for simple data processing/extraction. The previous `gemini-1.5-*` defaults in this repo are no longer offered. Always overridable via `XO_GEMINI_MODEL`. Model names are validated only for shape (`gemini-…`), so new models need no code change; unknown ids surface as `unsupported_model` from the API.

## Behaviour

- Key is sent only in the `x-goog-api-key` header (never the URL), and redacted from errors/logs.
- Per-request timeout (default 30s), input-size and output-token bounds, validated before any network call. Aborting only stops local waiting; **remote work may still complete and be billed**.
- Bounded retry (default 2 retries, exponential backoff + jitter) only for `rate_limited`, `timeout`, `transient`; honours `Retry-After` / `RetryInfo`; a vendor wait >15s fails fast. Never retried: auth, invalid request, quota exhausted, blocked, unsupported. `XO_GEMINI_MAX_RETRIES=0` disables. This policy applies to inference only, never to external side effects or `external_tool`.
- The router no longer re-retries classified provider failures (it would multiply attempts); it still retries `malformed_response`.
- Safety-blocked, filtered, empty or truncated-structured responses are failures, not successes. Structured output is requested via `responseSchema` (OpenAPI subset) and always re-validated locally.
- Telemetry (`inference.request.completed|failed`): provider, model, request id, duration, outcome/category, attempts, retry count, timeout/rate-limit flags, usage when reported. Prompts and responses are never logged. No distributed tracing or durable audit trail is provided by this work.
- Usage: Gemini output tokens include hidden reasoning tokens. If unreported, `usageKnown=false`. `costUsd` comes from the existing pricing table and is **not** a billing statement (models absent from the table cost 0 there).
- Output is untrusted: it must still pass XO's validation/authorization gates; it never triggers external effects directly.

## Health / readiness

`/health` (unauthenticated) is unchanged liveness. `GET /ready` (authenticated) returns inference **configuration** status only: `providerReachable` is always `not_checked`, `inferenceVerified` is always `false`. It never calls Google. Use the opt-in smoke test for a real check.

## Tests

- Mocked (default, no key/network): `npm test --workspace @xo/ai-core`
- Optional live smoke (one tiny request): `XO_LIVE_GEMINI_TEST=1 GEMINI_API_KEY=... npm test --workspace @xo/ai-core`. Skips cleanly otherwise; never prints the key or content.

## Free-tier limits and data use

- Free tier is for development/experimentation, not a production SLA. Limits are per project, vary by model and change; check your limits in AI Studio / <https://ai.google.dev/gemini-api/docs/rate-limits>.
- Google's pricing page lists free-tier content as **used to improve Google's products** (paid tier: not). Confirm current terms at <https://ai.google.dev/gemini-api/terms> before use. **Do not send real customer documents, confidential data or credentials through the free tier.** With `XO_ENV=production`, startup requires `XO_GEMINI_ACK_DATA_USE_TERMS=true`.
- Keep the key server-side only; never in Studio, browser bundles, CLI output or logs.

## Adding another provider

Implement `ModelProvider` (`id`, `complete`, `describeCapabilities`), throw `providerFailure(category, …)` for normalized errors, report `usageKnown` honestly, add one `case` to `createProviderFromConfig`, and extend the `inferenceProvider` enum. No call-site changes.

## Known limitations

No streaming, vision or tool/function calling in the adapter. REST via `fetch` (no `@google/genai` dependency, matching the other providers). Error classification is based on documented Google error shapes plus defensive parsing and has not been exercised against the live API in this change. The pre-existing router can fall back across providers only when several are explicitly registered; `singleProviderPolicy` guarantees none.
