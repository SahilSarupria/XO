# 0045: Runtime support envelope and owner defaults (RX-0)

## Status

Accepted under the owner's delegation, 2026-11-22. Signed off by Claude under the owner's delegation of decision authority; this is a
delegated decision, not an independent review. It records conservative defaults for the decisions the post-readiness runtime spec
(section 22) reserves for the owner. Each default holds until the owner changes it.

## Context

The spec "XO Post-Readiness Workflow Runtime, Execution and Learning" (1.0) asks that eleven decisions not be invented silently, and
that conservative safe defaults be used until they are made. The gap audit (`docs/runtime/RUNTIME_SPEC_GAP_AUDIT.md`) shows most of
the runtime already exists. These defaults describe the system as built, closing the questions it leaves open in the safe direction.
The first vertical (V1, certificate distribution by email) sets the envelope.

## Decisions

1. **Hosting and queue infrastructure.**
   - One instance (`xo up`, UW-17), state in one data directory, and no external queue.
   - Work is coordinated by the engine journal, run leases and the scheduler lease and engine.
   - Several instances are supported only where they share the data directory on one host. Knowledge can use Postgres
     (`@xo/knowledge-store-postgres`).
   - A cloud template with a managed queue is UW-17 (W5) and needs a new ADR.
2. **Database, event store and retention.**
   - Run journals, workflow entities and controls are files in the workspace's directory. Knowledge is in SQLite (Postgres optional).
   - All of it is kept until the workspace is deleted (a verified erasure receipt, UW-17), except where a rule already says otherwise:
     audit retention purge (anchored, UW-1), token vaults (30 days, UW-14), and source versions retired by connections (kept, marked).
3. **Supported constructs (the envelope).**
   - Supported: `extract`, `decide`, `act`, `approve`, `branch`, `wait` (timer, event, approval), `compensate`, `escalate`, and
     bounded `forEach`.
   - Strategies: deterministic, human-in-the-loop, model-assisted extraction and external connector actions.
   - Not supported, and refused before start:
     - parallel branches;
     - subworkflows;
     - a `hybrid` strategy routed as such;
     - free-form model actions.
4. **Connector providers.**
   - V1 providers:
     - Gmail and Microsoft Graph (send, with the optional `mail.lookup`);
     - SMTP with IMAP, and SMTP alone;
     - Google Drive and OneDrive/SharePoint (read);
     - the local folder agent.
   - The OAuth apps are registered by the owner (`docs/CREDENTIALS.md`).
   - No managed integration provider (Composio or similar) and no third-party adapter code before the horizontals phase, which needs
     its own ADR (registry, sandboxing, signing).
5. **Side-effect classes and approval.**
   - Classes are `read`, `write` and `irreversible`; `unknown` counts as `write` (UW-7). Communication (email) is `irreversible`.
   - Default: every `write` or `irreversible` step needs a person's approval bound to the exact payload. A batch approval (UW-8) and
     standing approvals (UW-16) may replace it later, each by its own ADR. (Both are implemented: ADR 0046 and ADR 0051.)
6. **Retries, timeouts, concurrency and quotas.**
   - A connector call is retried only when its operation declares `supports_key` or `supports_lookup`. Retries are bounded by the
     step's declared `retry` (at most 10 attempts by schema).
   - Default when a binding declares none: 3 attempts, exponential backoff from 1 s up to 60 s, with full jitter.
   - An unknown outcome is never retried; it escalates.
   - Approval timeouts escalate. A live workflow needs a daily limit (existing controls).
   - One driver per run (the run lease).
   - Email pacing and the daily cap per tier stay as configured (UW-10).
   - Per-connector rate limits arrive with RX-1c, defaulting to off.
7. **Residency, retention, deletion, legal hold, model data use.**
   - Residency `strict_local` by default (UW-14).
   - No customer data is used to train any model, and none is sent to a hosted model except as a typed request in `masked_hosted`.
   - Deletion is by verified erasure. Legal hold is not supported: a workspace under hold must not be deleted or purged (an operator
     duty, stated in the runbooks).
8. **Compensation.**
   - Allowed only for an operation whose binding declares a compensation operation.
   - Never automatic for `irreversible` operations, so never for email.
   - `onCancel` defaults to `abandon`. Compensation is never described as rollback.
9. **SLOs, availability, recovery objectives, escalation.**
   - None are set. Baselines are measured first (UW-13); the owner then sets targets.
   - Until then, incident escalation is the instance operator, by the runbooks (RX-1g).
10. **Approval quorum and separation of duties.**
    - One approver. Separation of duties is not claimed.
    - UW-8 decides whether the person who started a run may approve its `irreversible` steps. The conservative default it should
      implement: not in production workspaces, configurable per workspace. Implemented by ADR 0046 as the instance setting `XO_APPROVAL_SEPARATION` (production default `required`): whoever prepared a batch preview cannot approve it.
11. **Run outcomes as knowledge.**
    - None become knowledge automatically.
    - A person's correction to a run may be proposed as a knowledge change set (UW-11). A reviewer with a recent sign-in approves it.
    - Activation creates a new knowledge state; runs keep the state they were pinned to.

## Consequences

- RX-1 (wave W4) implements the missing V1 parts named in the gap audit:
  - scoped emergency stop;
  - run manifest and audit bundle;
  - rate limits;
  - pack pinning;
  - replay over the API;
  - runbooks;
  - the scenario index.
- The horizontals inherit decision 4: XO Connect's registry, event gateway and third-party adapters each need an ADR before code.

## Reopen if

- The owner sets any of these differently, or a pilot needs a construct outside decision 3.
- A cloud deployment is commissioned (decisions 1 and 2).
