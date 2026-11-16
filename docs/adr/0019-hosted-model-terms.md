# 0019: Hosted models only on a paid, contracted, no-training tier, with masked inputs (D-J)

## Status

Accepted under owner delegation, 2026-11-13 (UW-0). Signed off 2026-11-13 by Claude under the owner's explicit delegation of sign-off authority (owner instruction of 2026-11-13); this is a delegated sign-off, not an independent review. **Counsel review required** before any real-data pilot.
Enforced by UW-14.

## Context

The repository already records that the only documented hosted provider's free tier may use submitted content, and that real customer
documents must not go through it. `@xo/ai-core` has a fail-closed inference policy with node, server and run authorities, a provider
allow-list and a local Ollama provider; `redaction.ts` (22 lines) removes credentials only, with no personal-data handling
(`docs/baseline/UW0_BASELINE.md` §7; plan UW-14).

## Decision

1. A hosted model may be used only on a **paid, contracted tier whose terms exclude training on submitted data**. Free tiers are never
   used with customer data.
2. Hosted models receive **masked inputs only** (schemas, synthetic records, filtered intent; ADR 0020).
3. Logs and audit records hold hashes or placeholders, never raw customer values.
4. The provider allow-list in the server inference policy names only providers whose contract has been reviewed.

## Reopen if

Counsel advises otherwise.
