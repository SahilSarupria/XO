# 0025: One trigger engine: `@xo/automation` sources, Studio controls as its policy, starts through the workflow service (D-P)

## Status

Accepted under owner delegation, 2026-11-13 (UW-0). Signed off 2026-11-13 by Claude under the owner's explicit delegation of sign-off authority (owner instruction of 2026-11-13); this is a delegated sign-off, not an independent review. Implemented by UW-15; parity tests first.

## Context

Two trigger designs are on `main` (`docs/baseline/UW0_BASELINE.md` §8, D-P parity):

- `@xo/automation`: cron, file-drop, webhook and manual sources; an idempotency ledger (each key runs at most once across retries and
  restarts); per-workflow rate limits; retries and dead letters; a single-writer lock (single host). It runs its own workflow handlers,
  with no authorization or audit. Used by the CLI and ab-eval only.
- The API scheduler (`apps/api/src/workflow-controls`): "every N minutes" schedules and webhooks; draft/shadow/live/paused modes, a
  daily cap and workspace pause; starts as the `trigger-schedule` service principal through the audited runner. Stated limits: one
  process, no catch-up, two processes would double-start.

Neither replays missed slots.

## Decision

1. **`@xo/automation`'s trigger sources and idempotency ledger are the single trigger layer.** "Every N minutes" becomes a schedule
   source with the same meaning.
2. **Studio's controls are its policy layer**: modes, daily cap, pause and sign-off are checked at the gate between an accepted event
   and a run start.
3. **Triggers never execute.** An accepted event starts a run only through the workflow service (ADR 0011), as a deny-by-default
   service principal. `@xo/automation`'s own handler execution is retired for instances.
4. **Leases and missed slots (UW-15).** A lease behind an interface prevents a double start with two processes (UAC-37); each schedule
   declares its missed-slot behaviour (skip, or run once) and it is tested.
5. **The interval scheduler is retired after parity tests** show identical starts, refusals and audit records for the same inputs.

## Reopen if

A parity test cannot be met without losing a control the API scheduler enforces today.
