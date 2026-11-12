# 0015: External effects go through `@xo/adapters`; connectors provide credentials and egress (D-F)

## Status

Accepted under owner delegation, 2026-11-13 (UW-0). Signed off 2026-11-13 by Claude under the owner's explicit delegation of sign-off authority (owner instruction of 2026-11-13); this is a delegated sign-off, not an independent review. Implemented by UW-7, UW-9 and UW-10.

## Context

Two effect stacks exist. `@xo/adapters` (P1.1 M4) has the six-state effect model owner-approved in P1.1 O-3 (`intent_recorded`,
`dispatch_attempted`, `confirmed_success`, `confirmed_failure_no_effect`, `outcome_unknown`, `reconciliation_required`), a durable
blob ledger, reconciliation that never redispatches and single-use payload approval, but no real adapter. `@xo/connectors` has a
hardened egress layer (https only, allowlist, pinned public address, no redirects, bounded), a vault with `secret:NAME` references,
grants, per-operation idempotency attestation (`supports_key` | `supports_lookup` | `none`) and real connectors (HTTP, webhook, Slack,
SMTP, SQLite read-only, MCP).

## Decision

1. **Every external effect is dispatched through `@xo/adapters`.** A provider connector implements the adapter contract; the adapter
   ledger records intent before dispatch and the outcome after it.
2. **`ConnectorHost`'s vault, grants and egress controls are the shared credential and egress layer** for source connectors (UW-12a)
   and action connectors alike. One broker, not two (UW-9).
3. **Retry rule.** A write is re-sent automatically only when the destination attests `supports_key` (it deduplicates on the key we
   send) or a `supports_lookup` read proves no effect happened. A destination attesting `none` is never re-sent automatically; an
   unknown outcome blocks that item for reconciliation. This refines the plan's "no automatic retries of external effects" to the
   precise safe case and matches the behaviour the UW-0 spike observed.
4. **`external_tool` stays fail-closed** (no configured adapter, no dispatch). MCP stays optional and is never required for an effect.

## Consequences

- One state vocabulary for the preview, receipts and reconciliation screens.
- The SMTP connector's limits (AUTH PLAIN only, five-recipient default, mandatory domain allowlist, no attachments) are replaced in
  UW-10 by the recipient policy and attachments-by-hash (ADR 0018).

## Reopen if

A provider cannot support any lookup at all. Tiers already handle that case (ADR 0018).
