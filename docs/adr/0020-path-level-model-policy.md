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

## Reopen if

A vertical genuinely needs a hosted model on real values; that requires a new ADR and the owner's sign-off.
