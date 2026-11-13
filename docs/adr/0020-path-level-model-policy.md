# 0020: Model use is decided per path; data-bearing paths use no hosted model (D-K)

## Status

Accepted under owner delegation, 2026-11-13 (UW-0). Signed off 2026-11-13 by Claude under the owner's explicit delegation of sign-off authority (owner instruction of 2026-11-13); this is a delegated sign-off, not an independent review. Enforced by UW-14 (residency modes and the typed egress
boundary).

## Context

The inference policy in `@xo/ai-core` decides whether inference may run (node declaration, server policy, run restriction) but not
which data may reach which provider. The shipped default server policy is `{ enabled: true, allowUndeclared: false }`
(`packages/ai-core/src/inference-policy.ts`). Hosted vision is off unless a caller builds it.

## Decision

1. **Data-bearing paths** (extraction of customer values, matching, rendering messages, anything that touches real values) use no
   model, or a model on the instance's own server (the existing Ollama provider path).
2. **Planning paths** (turning a goal into a proposed workflow) may use a hosted model only through the typed egress boundary of UW-14:
   prompt builders accept only schema descriptors, synthetic records, filtered intent text and fixed templates.
3. **Residency is a fourth authority** in the inference policy: `strict_local` (default; no hosted call is possible), `masked_hosted`,
   and `open` (development only; refused at production start-up).
4. Recipients, attachments and amounts are never taken from model output, only from resolved structured data (UW-5, UW-8).

## Implementation (UW-14, wave W1: 14a and 14b)

Operations: `docs/RESIDENCY.md`.

- **Residency modes.**
  - `XO_RESIDENCY` is `strict_local` (default), `masked_hosted` (with `XO_HOSTED_MODEL_PROVIDERS`) or `open`.
  - `open` is refused in production, both by the settings check and by the server itself.
  - `checkResidency` is the single rule. It is the fourth authority in `InferenceRunScope.checkPolicy`, and the guard that wraps every
    provider the instance builds (`guardProvider`) applies it to every call.
- **Typed egress boundary.** `buildEgressRequest` accepts only minted parts: schema descriptors, synthetic records, filtered intent and
  sealed templates. In `masked_hosted` the guard admits a hosted request only if it is the very object that function returned.
- **Data-bearing paths stay local.** These are chat, runtime inference and vision: their requests are untyped, so they reach only a
  local model unless residency is `open`. A hosted vision provider stops start-up outside `open`.
- **Wave W2.** The known-value dictionary, the locale patterns, reversible tokens and the leak guard (14c to 14e).

## Reopen if

A vertical genuinely needs a hosted model on real values; that requires a new ADR and the owner's sign-off.
